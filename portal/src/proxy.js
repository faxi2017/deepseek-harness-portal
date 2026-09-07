import httpProxy from 'http-proxy'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { config } from './config.js'
import { getInstanceBySlug, getInstanceByHostPort, touchInstanceRequest, updateInstanceUnlessDeleting, userForSession } from './db.js'
import { startContainer, containerRunning, dshWebToken, waitHealthy } from './orchestrator.js'
import { SESSION_COOKIE } from './auth.js'
import { instanceHostPort, trustedInstanceRequest } from './routing.js'

// changeOrigin: rewrite Host to the target (127.0.0.1:port) so the instance's
// trust fence sees loopback. dsh gates settings/credentials methods to loopback,
// and the portal is the authenticated, authorized gateway into the instance —
// so presenting proxied traffic as loopback is correct and required.
const proxy = httpProxy.createProxyServer({ xfwd: false, changeOrigin: true })
const activeWebSockets = new Set()
const ensureRunningPromises = new Map()
const INJECT_DSH_HOST = Symbol('injectDshHost')
const DSH_HOST_BOOTSTRAP_PATH = '/__portal/dsh-host.js'
const DSH_HOST_BOOTSTRAP = 'globalThis.__DSH_TRANSPORT__={...(globalThis.__DSH_TRANSPORT__??{}),ownsHost:true};\n'

export function closeUserSockets(userId) {
  for (const tracked of activeWebSockets) {
    if (tracked.userId === userId && !tracked.socket.destroyed) tracked.socket.destroy()
  }
}

// The browser-to-portal hop carries gateway credentials and identity metadata.
// None of those values belong on the portal-to-tenant hop. The parent-domain
// portal_session is never forwarded; only the target DSH authority's dedicated
// authentication cookie is allowed through.
const STRIPPED_REQUEST_HEADERS = [
  'cookie', 'authorization', 'proxy-authorization', 'origin', 'x-csrf-token',
  'cf-access-jwt-assertion', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
  'x-forwarded-user', 'x-forwarded-email',
]

const DSH_AUTH_COOKIE_NAME = /^dsh-auth-[A-Za-z0-9_-]{43}$/
const DSH_AUTH_COOKIE_VALUE = /^[A-Za-z0-9._~-]+$/

function dshAuthCookieName(authority) {
  return `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}`
}

function dshAuthCookies(cookieHeader, expectedName) {
  const cookies = []
  for (const part of String(cookieHeader ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (name === expectedName && DSH_AUTH_COOKIE_NAME.test(name) && DSH_AUTH_COOKIE_VALUE.test(value)) {
      cookies.push(`${name}=${value}`)
    }
  }
  return cookies
}

function hardenProxyRequest(proxyReq, req) {
  const hasValidatedOrigin = req.headers.origin !== undefined
  const authority = String(proxyReq.getHeader('host'))
  const allowedCookies = dshAuthCookies(req.headers.cookie, dshAuthCookieName(authority))
  for (const name of STRIPPED_REQUEST_HEADERS) proxyReq.removeHeader(name)
  if (req[INJECT_DSH_HOST]) proxyReq.removeHeader('accept-encoding')
  if (allowedCookies.length > 0) proxyReq.setHeader('cookie', allowedCookies.join('; '))
  // The outer request has already passed the exact tenant Origin check. DSH
  // sees the proxy target as its Host, so give same-origin-protected plugins a
  // matching internal Origin without forwarding the browser-visible origin.
  if (hasValidatedOrigin) proxyReq.setHeader('origin', `http://${proxyReq.getHeader('host')}`)
}

function relayHtmlWithHostBootstrap(proxyRes, res) {
  const chunks = []
  proxyRes.on('data', (chunk) => chunks.push(chunk))
  proxyRes.once('error', () => res.destroy())
  proxyRes.once('end', () => {
    const headers = { ...proxyRes.headers }
    let body = Buffer.concat(chunks)
    if (proxyRes.statusCode === 200 && String(headers['content-type'] ?? '').toLowerCase().includes('text/html')) {
      const html = body.toString('utf8')
      const tag = `<script src="${DSH_HOST_BOOTSTRAP_PATH}"></script>`
      body = Buffer.from(html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : `${tag}${html}`)
      delete headers['content-encoding']
      delete headers['transfer-encoding']
      headers['content-length'] = String(body.length)
    }
    res.writeHead(proxyRes.statusCode ?? 502, headers)
    res.end(body)
  })
}

function filterUpstreamCookies(headers, expectedName) {
  if (!headers) return
  const raw = headers['set-cookie']
  const values = Array.isArray(raw) ? raw : raw ? [raw] : []
  const allowed = values.map((value) => {
    const pair = String(value).split(';', 1)[0]
    const eq = pair.indexOf('=')
    if (eq === -1) return null
    const name = pair.slice(0, eq).trim()
    const cookieValue = pair.slice(eq + 1).trim()
    if (name !== expectedName || !DSH_AUTH_COOKIE_NAME.test(name) || !DSH_AUTH_COOKIE_VALUE.test(cookieValue)) return null
    return `${name}=${cookieValue}; Path=/; HttpOnly; SameSite=Strict`
  }).filter(Boolean)
  if (allowed.length > 0) headers['set-cookie'] = allowed
  else delete headers['set-cookie']
  delete headers['set-cookie2']
}

proxy.on('proxyReq', hardenProxyRequest)
proxy.on('proxyReqWs', (proxyReq, req) => {
  hardenProxyRequest(proxyReq, req)
  // http-proxy writes both successful 101 and rejected/non-upgrade handshake
  // headers after these listeners. Registering here removes Set-Cookie before
  // either response path reaches the browser.
  const hostPort = instanceHostPort(req.socket.localPort)
  const expectedName = dshAuthCookieName(`127.0.0.1:${hostPort}`)
  proxyReq.once('upgrade', (proxyRes) => filterUpstreamCookies(proxyRes.headers, expectedName))
  proxyReq.once('response', (proxyRes) => filterUpstreamCookies(proxyRes.headers, expectedName))
})
proxy.on('proxyRes', (proxyRes, req, res) => {
  const hostPort = instanceHostPort(req.socket.localPort)
  filterUpstreamCookies(proxyRes.headers, dshAuthCookieName(`127.0.0.1:${hostPort}`))
  if (req[INJECT_DSH_HOST]) relayHtmlWithHostBootstrap(proxyRes, res)
})

proxy.on('error', (err, _req, res) => {
  console.error('[proxy] upstream error:', err?.message ?? err)
  if (res && typeof res.writeHead === 'function' && !res.headersSent) {
    res.writeHead(502, { 'content-type': 'text/plain' })
    res.end('upstream unavailable')
  } else if (res && typeof res.destroy === 'function' && !res.destroyed) {
    res.destroy()
  }
})

/** Parse the session cookie from a raw Cookie header. */
function cookieToken(cookieHeader) {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (name === SESSION_COOKIE) return /^[a-f0-9]{64}$/.test(value) ? value : null
  }
  return null
}

/** Host -> slug when the Host is a configured instance subdomain; null otherwise. */
function slugFromHost(hostHeader) {
  const host = String(hostHeader ?? '').split(':')[0].toLowerCase()
  const apex = config.domain.toLowerCase()
  const base = config.instanceDomain.toLowerCase()
  if (host === apex || host === base) return null
  const suffix = `.${base}`
  if (!host.endsWith(suffix)) return null
  const slug = host.slice(0, -suffix.length)
  if (slug.length === 0 || slug.includes('.')) return null // single label only
  return slug
}

/** Decide whether this user may reach this instance. */
function mayAccess(user, inst) {
  if (!user) return false
  if (user.role === 'admin') return true
  return user.id === inst.user_id
}

/**
 * Ensure an instance is running, starting it if it is stopped. Failed or
 * still-provisioning instances are not auto-started (those need admin).
 * After starting, waits until dsh actually serves HTTP before returning.
 * @returns true once the instance is running and healthy.
 */
async function ensureRunningInner(inst) {
  if (inst.status === 'failed' || inst.status === 'deleting' || inst.status === 'upgrading') return false
  if (inst.status === 'provisioning') return await containerRunning(inst.container_name)
  // Check the real container state rather than the DB status: a stale DB row
  // can say "stopped" while the container is already running, and issuing a
  // redundant start in that case can leave the status desynced.
  if (!(await containerRunning(inst.container_name))) {
    await startContainer(inst.container_name)
  }
  if (!(await containerRunning(inst.container_name))) return false
  // Wait for the app to serve; a freshly started container isn't ready yet.
  const healthy = await waitHealthy(inst.host_port, 30000, inst.container_name)
  if (healthy && !updateInstanceUnlessDeleting(inst.id, { status: 'running', error: null })) return false
  return healthy
}

function ensureRunning(inst) {
  const existing = ensureRunningPromises.get(inst.container_name)
  if (existing) return existing
  const pending = ensureRunningInner(inst)
    .finally(() => ensureRunningPromises.delete(inst.container_name))
  ensureRunningPromises.set(inst.container_name, pending)
  return pending
}

/**
 * Route subdomain traffic to the owning instance. Registered as a fastify
 * onRequest hook (HTTP) plus a raw server 'upgrade' listener (WebSocket).
 */
export function setupProxy(fastify) {
  const listeners = []
  // Reuse the same Fastify request and upgrade handlers; the actual listener
  // port, never an untrusted forwarded header, selects the tenant.
  if (config.instanceRouting === 'ports') {
    fastify.addHook('onReady', async () => {
      try {
        for (let port = config.instancePortStart; port <= config.instancePortStart + config.portRangeEnd - config.portRangeStart; port++) {
          const server = http.createServer((req, res) => fastify.server.emit('request', req, res))
          server.on('upgrade', (req, socket, head) => fastify.server.emit('upgrade', req, socket, head))
          await new Promise((resolve, reject) => {
            server.once('error', reject)
            server.listen(port, config.host, resolve)
          })
          listeners.push(server)
        }
      } catch (error) {
        for (const server of listeners) server.close()
        throw error
      }
    })
    fastify.addHook('onClose', async () => {
      for (const tracked of activeWebSockets) tracked.socket.destroy()
      await Promise.all(listeners.map((server) => new Promise((resolve) => {
        server.close(resolve)
        server.closeAllConnections()
      })))
    })
  }
  function requestSlug(req) {
    if (config.instanceRouting === 'subdomains') return slugFromHost(req.headers.host)
    if (req.socket.localPort === config.port) return null
    return getInstanceByHostPort(instanceHostPort(req.socket.localPort))?.slug ?? ''
  }
  fastify.addHook('onRequest', async (req, reply) => {
    const slug = requestSlug(req.raw)
    if (slug === null) return // apex -> normal portal routing

    const inst = getInstanceBySlug(slug)
    if (inst === null) {
      reply.code(404).type('text/plain').send('instance not found')
      return
    }
    if (!trustedInstanceRequest(req.raw, inst)) return reply.code(403).send('invalid instance origin')
    const user = userForSession(req.cookies?.[SESSION_COOKIE])
    if (!mayAccess(user, inst)) {
      reply.code(user ? 403 : 302)
      if (!user) reply.header('location', `${config.portalOrigin}/`)
      reply.send('not authorized')
      return reply
    }
    // Auto-start on access (launch always works); start is fast for a stopped
    // container. If it fails, report not-running instead of a hung proxy.
    let running = inst.status === 'running' && (await containerRunning(inst.container_name))
    if (!running && !['failed', 'provisioning', 'deleting'].includes(inst.status)) {
      running = await ensureRunning(inst)
    }
    if (!running) {
      reply.code(503).type('text/plain').send('instance starting, try again in a moment')
      return reply
    }
    // Revalidate identity and routing after every startup/inspection await. A
    // deleted row must never forward to a port that may be allocated anew.
    const current = getInstanceBySlug(slug)
    const currentUser = userForSession(req.cookies?.[SESSION_COOKIE])
    if (!current || current.id !== inst.id || current.status !== 'running' || !mayAccess(currentUser, current)) {
      reply.code(503).type('text/plain').send('instance unavailable')
      return reply
    }
    touchInstanceRequest(slug)
    const requestUrl = new URL(req.raw.url ?? '/', 'http://portal.invalid')
    if (req.raw.method === 'GET' && requestUrl.pathname === DSH_HOST_BOOTSTRAP_PATH) {
      reply.type('application/javascript').header('Cache-Control', 'no-store').send(DSH_HOST_BOOTSTRAP)
      return reply
    }
    const bootstrapRequested = requestUrl.searchParams.get('portal_bootstrap') === '1'
    const expectedCookieName = dshAuthCookieName(`127.0.0.1:${current.host_port}`)
    let bootstrapping = false
    if (req.raw.method === 'GET' && requestUrl.pathname === '/'
        && (bootstrapRequested || dshAuthCookies(req.raw.headers.cookie, expectedCookieName).length === 0)) {
      const token = await dshWebToken(current.container_name)
      // DSH 0.1.2 enables browser-token authentication while 0.1.1 does not.
      // A missing token is therefore a supported legacy mode, not proof that
      // the container is still starting. ensureRunning already verified the
      // core route before requests reach this point.
      if (token) {
        req.raw.url = `/?token=${encodeURIComponent(token)}`
        bootstrapping = true
      } else if (bootstrapRequested) {
        requestUrl.searchParams.delete('portal_bootstrap')
        req.raw.url = `${requestUrl.pathname}${requestUrl.search}`
      }
    }
    const injectDshHost = req.raw.method === 'GET' && requestUrl.pathname === '/' && !bootstrapping
    req.raw[INJECT_DSH_HOST] = injectDshHost
    reply.hijack()
    proxy.web(req.raw, reply.raw, {
      target: `http://127.0.0.1:${current.host_port}`,
      selfHandleResponse: injectDshHost,
    })
  })

  async function handleUpgrade(req, socket, head) {
    const slug = requestSlug(req)
    if (slug === null) {
      socket.destroy()
      return
    }
    const inst = getInstanceBySlug(slug)
    if (inst === null) {
      socket.destroy()
      return
    }
    if (!trustedInstanceRequest(req, inst, { upgrade: true })) {
      socket.destroy()
      return
    }
    const sessionToken = cookieToken(req.headers.cookie)
    const user = userForSession(sessionToken)
    if (!mayAccess(user, inst)) {
      socket.destroy()
      return
    }
    let running = inst.status === 'running' && (await containerRunning(inst.container_name))
    if (!running && !['failed', 'provisioning', 'deleting'].includes(inst.status)) {
      running = await ensureRunning(inst)
    }
    if (!running) {
      socket.destroy()
      return
    }
    // Container startup may take tens of seconds. Revalidate after the final
    // await so a password reset/logout during startup cannot escape revocation.
    const current = getInstanceBySlug(slug)
    const currentUser = userForSession(sessionToken)
    if (!current || current.id !== inst.id || current.status !== 'running' || !mayAccess(currentUser, current)) {
      socket.destroy()
      return
    }
    touchInstanceRequest(slug)
    const tracked = { socket, userId: currentUser.id, token: sessionToken, lastActivity: Date.now() }
    activeWebSockets.add(tracked)
    const markActivity = () => {
      const now = Date.now()
      if (now - tracked.lastActivity >= 60 * 1000) {
        tracked.lastActivity = now
        touchInstanceRequest(slug)
      }
    }
    const untrack = () => {
      activeWebSockets.delete(tracked)
      socket.off('data', markActivity)
    }
    socket.on('data', markActivity)
    socket.once('close', untrack)
    socket.once('error', untrack)
    proxy.ws(req, socket, head, { target: `ws://127.0.0.1:${current.host_port}` })
  }

  // EventEmitter does not await async listeners. Convert rejections into a
  // closed socket so malformed input or Docker errors cannot become an
  // unhandled rejection that terminates the portal process.
  fastify.server.on('upgrade', (req, socket, head) => {
    void handleUpgrade(req, socket, head).catch((err) => {
      console.error('[proxy] websocket upgrade failed:', err?.message ?? err)
      if (!socket.destroyed) socket.destroy()
    })
  })

  const sessionSweep = setInterval(() => {
    for (const tracked of activeWebSockets) {
      if (!userForSession(tracked.token, { touch: false }) && !tracked.socket.destroyed) {
        tracked.socket.destroy()
      }
    }
  }, 60 * 1000)
  sessionSweep.unref?.()
}
