import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { config, validateConfig } from './config.js'
import {
  db, createInstanceRow, createUser, deleteAllSessionsForUser, deleteInstance,
  deleteUser, ensureAdmin, getDshRelease, getDshUpgrade, getInstanceById, getInstanceByUserId,
  getInstanceBySlug, getInviteCode, getUserById, listDshReleases, listDshReleaseBuilds, listDshUpgrades,
  getUserByUsername, listInstancesWithUsers, listUsers, registrationEnabled,
  purgeExpiredSessions, recoverInterruptedDshReleaseBuilds, recoverInterruptedDshUpgrades,
  setInviteCode, setSetting, setUserPassword, sessionForToken, updateDshRelease,
  updateInstance, updateInstanceUnlessDeleting, updateUser, userForSession,
} from './db.js'
import {
  createSession, destroySession, hashPassword, LEGACY_SESSION_COOKIES,
  verifyCsrfToken, verifyPassword, verifyPasswordOrDummy, SESSION_COOKIE,
} from './auth.js'
import { RATE_POLICIES, clearRateLimit, clientIp, consumeRateLimit } from './rate-limit.js'
import {
  allocatePort, containerLogs, containerName, containerRunning, provision,
  removeContainer, restartContainer, startContainer, stopContainer, verifyDockerRuntime,
} from './orchestrator.js'
import { closeUserSockets, setupProxy } from './proxy.js'
import { instanceUrl } from './routing.js'
import { registerGatewayAdmin } from './gateway-admin.js'
import { registerPluginAdmin } from './plugin-admin.js'
import { recoverPluginJobs, pluginState } from './plugins.js'
import { startGateway } from './gateway.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const fastify = Fastify({ logger: false })

await fastify.register(cookie)
fastify.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
  try { done(null, Object.fromEntries(new URLSearchParams(body))) }
  catch (err) { done(err) }
})
await fastify.register(fastifyStatic, {
  root: join(__dirname, '..', 'public'),
  prefix: '/',
  setHeaders: (reply) => {
    reply.header('Cache-Control', 'no-store')
  },
})
fastify.get('/vendor/echarts.min.js', (_req, reply) => reply.sendFile('echarts.min.js', join(__dirname, '..', 'node_modules', 'echarts', 'dist')))

validateConfig()
await verifyDockerRuntime()
purgeExpiredSessions()
ensureAdmin()
setupProxy(fastify)
recoverPluginJobs()
recoverInterruptedDshReleaseBuilds()
recoverInterruptedDshUpgrades()

// Re-queue instances left mid-provisioning by a previous process exit.
for (const inst of listInstancesWithUsers()) {
  if (inst.status === 'provisioning') {
    console.log(`[portal] re-queuing provisioning for "${inst.slug}"`)
    provision(inst.id).catch((err) => console.error('[provision]', err))
  }
}

// Portal browser hardening. Instance responses are hijacked by setupProxy
// before onSend and intentionally keep dsh's own content policy.
fastify.addHook('onSend', async (req, reply) => {
  reply.headers({
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  })
  if (req.raw.url?.startsWith('/api/')) reply.header('Cache-Control', 'no-store')
})

// ---- helpers ---------------------------------------------------------------

const publicUser = (u) => (u ? { id: u.id, username: u.username, name: u.name, role: u.role } : null)
const publicDshRelease = (release) => (release ? {
  id: release.id, version: release.version, imageId: release.image_id,
  isDefault: Boolean(release.is_default), selfService: Boolean(release.self_service), createdAt: release.created_at,
} : null)
const publicDshUpgrade = (upgrade) => ({
  id: upgrade.id, fromReleaseId: upgrade.from_release_id, toReleaseId: upgrade.to_release_id,
  fromVersion: upgrade.from_version ?? '未知版本', toVersion: upgrade.to_version ?? '未知版本',
  operation: upgrade.operation, status: upgrade.status, createdAt: upgrade.created_at,
  finishedAt: upgrade.finished_at, message: upgrade.message,
})

function setSessionCookie(reply, token) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.portalOrigin.startsWith('https:'),
    path: '/',
    ...(config.cookieDomain ? { domain: config.cookieDomain } : {}),
    maxAge: Math.floor(config.sessionAbsoluteTtlMs / 1000),
  })
}

function requireSession(req, reply) {
  const session = sessionForToken(req.cookies?.[SESSION_COOKIE])
  if (!session) {
    reply.code(401).send({ error: 'not authenticated' })
    return null
  }
  return session
}

function requireUser(req, reply) {
  return requireSession(req, reply)?.user ?? null
}

function requireAdmin(req, reply) {
  const user = requireUser(req, reply)
  if (!user) return null
  if (user.role !== 'admin') {
    reply.code(403).send({ error: 'admin only' })
    return null
  }
  return user
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const PREAUTH_MUTATIONS = new Set(['/api/auth/register', '/api/auth/login'])

// Tenant subdomains are same-site with the portal, so SameSite cookies alone do
// not stop CSRF. Require the exact configured portal origin for every API
// mutation, JSON for API calls, and a per-session secret after authentication.
fastify.addHook('preHandler', async (req, reply) => {
  if (SAFE_METHODS.has(req.method) || !req.raw.url?.startsWith('/api/')) return

  const path = req.raw.url.split('?')[0]
  const host = String(req.headers.host ?? '').split(':')[0].toLowerCase()
  if (host !== config.domain.toLowerCase()) {
    return reply.code(403).send({ error: 'invalid request host' })
  }
  if (req.headers.origin !== config.portalOrigin) {
    return reply.code(403).send({ error: 'invalid request origin' })
  }
  const fetchSite = req.headers['sec-fetch-site']
  if (fetchSite !== undefined && fetchSite !== 'same-origin') {
    return reply.code(403).send({ error: 'cross-site request rejected' })
  }

  const isLogout = path === '/api/auth/logout'
  if (!isLogout && String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    return reply.code(415).send({ error: 'application/json required' })
  }
  if (PREAUTH_MUTATIONS.has(path)) return

  const session = sessionForToken(req.cookies?.[SESSION_COOKIE])
  if (!session) return // The route's normal authorization returns 401.
  const presented = isLogout ? req.body?._csrf : req.headers['x-csrf-token']
  if (!verifyCsrfToken(presented, session.csrfToken)) {
    return reply.code(403).send({ error: 'invalid CSRF token' })
  }
})

function enforceRateLimit(req, reply, policy, subject, overrides) {
  const result = consumeRateLimit(policy, subject, overrides)
  if (result.allowed) return true
  reply.header('Retry-After', String(result.retryAfterSeconds))
  reply.code(429).send({ error: 'too many attempts; try again later' })
  return false
}

function enforceIpAndSubjectLimit(req, reply, ipPolicy, subjectPolicy, subject) {
  if (!enforceRateLimit(req, reply, ipPolicy, clientIp(req))) return false
  return enforceRateLimit(req, reply, subjectPolicy, subject)
}

function slugify(value) {
  const s = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return (s || 'user').slice(0, 40)
}

const RESERVED_SLUGS = new Set([
  config.domain.split('.')[0].toLowerCase(), 'www', 'admin', 'portal', 'api', 'app', 'dsh',
])

async function uniqueSlug(base) {
  let slug = RESERVED_SLUGS.has(base) ? `${base}-1` : base
  for (let i = 2; getInstanceBySlug(slug) !== null; i++) slug = `${base}-${i}`
  return slug
}

// Serialize allocation so concurrent registrations cannot claim the same port.
let registrationQueue = Promise.resolve()
fastify.post('/api/auth/register', async (req, reply) => {
  if (!registrationEnabled()) return reply.code(403).send({ error: 'registration is disabled' })
  const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : ''
  const password = req.body?.password
  if (!enforceIpAndSubjectLimit(req, reply, RATE_POLICIES.registerIp, RATE_POLICIES.registerAccount, username)) return
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) return reply.code(400).send({ error: 'username: 3-32 chars (letters, digits, . _ -)' })
  if (typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password) > 72) {
    return reply.code(400).send({ error: 'password: at least 8 characters, at most 72 bytes' })
  }
  const invite = getInviteCode()
  if (invite !== '') {
    if (!enforceRateLimit(req, reply, RATE_POLICIES.inviteIp, clientIp(req))) return
    if (!enforceRateLimit(req, reply, RATE_POLICIES.inviteGlobal, 'global')) return
    if (String(req.body?.inviteCode ?? '').trim() !== invite) return reply.code(403).send({ error: 'invalid invitation code' })
  }
  const operation = registrationQueue.catch(() => {}).then(async () => {
    if (getUserByUsername(username)) return reply.code(409).send({ error: 'username already taken' })
    let hostPort
    try { hostPort = await allocatePort() }
    catch { return reply.code(503).send({ error: 'no instance capacity available; contact admin' }) }
    const slug = await uniqueSlug(slugify(username) + config.instanceSlugSuffix)
    const result = db.transaction(() => {
      const userId = createUser({ username, name: username, passwordHash: hashPassword(password) })
      const instId = createInstanceRow({ userId, slug, containerName: containerName(slug), hostPort })
      return { userId, instId }
    })()
    provision(result.instId, { setDefaultModel: true }).catch((err) => console.error('[provision]', err))
    clearRateLimit(RATE_POLICIES.registerAccount, username)
    const session = createSession(result.userId)
    setSessionCookie(reply, session.token)
    const instance = getInstanceById(result.instId)
    return { user: publicUser(getUserById(result.userId)), instance: { ...instance, url: instanceUrl(instance) }, csrfToken: session.csrfToken }
  })
  registrationQueue = operation
  return operation
})

fastify.post('/api/auth/login', async (req, reply) => {
  const identifier = String(req.body?.username ?? '').trim().toLowerCase()
  const password = String(req.body?.password ?? '')
  const user = getUserByUsername(identifier)
  const subject = user ? `user:${user.id}` : `identifier:${identifier}`
  if (!enforceIpAndSubjectLimit(req, reply, RATE_POLICIES.passwordIp, RATE_POLICIES.passwordAccount, subject)) return
  const validPassword = verifyPasswordOrDummy(password, user?.password_hash)
  if (!user || !user.password_hash || !validPassword) {
    return reply.code(401).send({ error: 'invalid username or password' })
  }
  clearRateLimit(RATE_POLICIES.passwordAccount, subject)
  const session = createSession(user.id)
  setSessionCookie(reply, session.token)
  return { user: publicUser(user), csrfToken: session.csrfToken }
})

function clearSessionAndCookies(req, reply) {
  // A browser may carry several session cookies scoped to different domains
  // (host-only, .vocsong.com, .deepseek.vocsong.com, ...) accumulated across
  // config changes and cookie-name changes. fastify collapses duplicate names,
  // so parse the RAW Cookie header and kill every session token server-side.
  const raw = String(req.raw.headers.cookie ?? '')
  const tokens = new Set()
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    if (name === SESSION_COOKIE || LEGACY_SESSION_COOKIES.includes(name)) {
      tokens.add(part.slice(eq + 1).trim())
    }
  }
  if (req.cookies?.[SESSION_COOKIE]) tokens.add(req.cookies[SESSION_COOKIE])

  const revokedUserIds = new Set()
  for (const token of tokens) {
    const user = userForSession(token)
    if (user) {
      deleteAllSessionsForUser(user.id)
      revokedUserIds.add(user.id)
    } else destroySession(token)
  }
  for (const userId of revokedUserIds) closeUserSockets(userId)

  // Clear the cookie across every scope and every cookie name we may have used.
  const names = [SESSION_COOKIE, ...LEGACY_SESSION_COOKIES]
  const scopes = [undefined, config.cookieDomain, config.domain, `.${config.domain}`]
  for (const name of names) {
    for (const scope of scopes) {
      reply.clearCookie(name, {
        path: '/',
        sameSite: 'lax',
        secure: config.portalOrigin.startsWith('https:'),
        ...(scope ? { domain: scope } : {}),
      })
    }
  }
}

// Native POST navigation avoids fetch/cache logout issues while Origin + the
// hidden per-session token prevent logout and sibling-subdomain CSRF.
fastify.post('/api/auth/logout', async (req, reply) => {
  clearSessionAndCookies(req, reply)
  return reply.code(303).redirect('/')
})

fastify.get('/api/auth/me', async (req, reply) => {
  const session = requireSession(req, reply)
  if (!session) return
  return { user: publicUser(session.user), csrfToken: session.csrfToken }
})

// ---- profile ---------------------------------------------------------------

fastify.get('/api/profile', async (req, reply) => {
  const user = requireUser(req, reply)
  if (!user) return
  return { name: user.name, username: user.username, hasPassword: Boolean(user.password_hash) }
})

fastify.post('/api/profile', async (req, reply) => {
  const user = requireUser(req, reply)
  if (!user) return

  const fields = {}
  const { username, name, currentPassword, newPassword } = req.body ?? {}

  if (username !== undefined) {
    const u = String(username).trim().toLowerCase()
    if (!/^[a-z0-9._-]{3,32}$/.test(u)) {
      return reply.code(400).send({ error: 'username: 3-32 chars (letters, digits, . _ -)' })
    }
    if (u !== user.username && getUserByUsername(u)) {
      return reply.code(409).send({ error: 'username already taken' })
    }
    fields.username = u
  }
  if (name !== undefined) {
    const n = String(name).trim()
    if (n.length < 1 || n.length > 64) return reply.code(400).send({ error: 'name must be 1-64 characters' })
    fields.name = n
  }
  if (newPassword !== undefined && newPassword !== '') {
    if (typeof newPassword !== 'string' || newPassword.length < 8 || Buffer.byteLength(newPassword) > 72) {
      return reply.code(400).send({ error: 'password must be at least 8 characters' })
    }
    if (user.password_hash) {
      if (typeof currentPassword !== 'string' || !verifyPassword(currentPassword, user.password_hash)) {
        return reply.code(400).send({ error: 'current password is incorrect' })
      }
    }
    fields.password_hash = hashPassword(newPassword)
  }

  if (Object.keys(fields).length === 0) return reply.code(400).send({ error: 'nothing to update' })
  const securityIdentityChanged = fields.password_hash !== undefined
  updateUser(user.id, fields)

  let rotatedSession = null
  if (securityIdentityChanged) {
    deleteAllSessionsForUser(user.id)
    closeUserSockets(user.id)
    rotatedSession = createSession(user.id)
    setSessionCookie(reply, rotatedSession.token)
  }
  const fresh = getUserById(user.id)
  return {
    name: fresh.name, username: fresh.username,
    hasPassword: Boolean(fresh.password_hash),
    ...(rotatedSession ? { csrfToken: rotatedSession.csrfToken } : {}),
  }
})

// ---- instance (user self-service) -----------------------------------------

fastify.get('/api/instance', async (req, reply) => {
  const user = requireUser(req, reply)
  if (!user) return
  const instance = getInstanceByUserId(user.id)
  if (!instance) return { instance: null, releases: [], upgrades: [] }
  return {
    instance: await withLiveState(instance),
    releases: listDshReleases().filter((release) => release.self_service).map(publicDshRelease),
    upgrades: listDshUpgrades(instance.id).map(publicDshUpgrade),
  }
})

fastify.post('/api/instance/start', async (req, reply) => {
  const user = requireUser(req, reply)
  if (!user) return
  const inst = getInstanceByUserId(user.id)
  if (!inst) return reply.code(404).send({ error: 'no instance' })
  if (inst.status === 'failed') return reply.code(400).send({ error: 'instance failed; contact admin' })
  if (inst.status === 'deleting') return reply.code(409).send({ error: 'instance deletion is in progress' })
  if (inst.status === 'upgrading') return reply.code(409).send({ error: 'instance upgrade is in progress' })
  await startContainer(inst.container_name)
  await waitUntilRunning(inst)
  updateInstanceUnlessDeleting(inst.id, { status: 'running', error: null, last_active: Date.now() })
  return { instance: getInstanceByUserId(user.id) }
})

fastify.post('/api/instance/stop', async (req, reply) => {
  const user = requireUser(req, reply)
  if (!user) return
  const inst = getInstanceByUserId(user.id)
  if (!inst) return reply.code(404).send({ error: 'no instance' })
  if (inst.status === 'deleting') return reply.code(409).send({ error: 'instance deletion is in progress' })
  if (inst.status === 'upgrading') return reply.code(409).send({ error: 'instance upgrade is in progress' })
  await stopContainer(inst.container_name)
  updateInstanceUnlessDeleting(inst.id, { status: 'stopped', error: null })
  return { instance: getInstanceByUserId(user.id) }
})

fastify.post('/api/instance/restart', async (req, reply) => {
  const user = requireUser(req, reply)
  if (!user) return
  const inst = getInstanceByUserId(user.id)
  if (!inst) return reply.code(404).send({ error: 'no instance' })
  if (inst.status === 'deleting') return reply.code(409).send({ error: 'instance deletion is in progress' })
  if (inst.status === 'upgrading') return reply.code(409).send({ error: 'instance upgrade is in progress' })
  await restartContainer(inst.container_name)
  await waitUntilRunning(inst)
  updateInstanceUnlessDeleting(inst.id, { status: 'running', error: null, last_active: Date.now() })
  return { instance: getInstanceByUserId(user.id) }
})

fastify.post('/api/instance/dsh-upgrade', async (req, reply) => {
  const user = requireUser(req, reply)
  if (!user) return
  const instance = getInstanceByUserId(user.id)
  const release = getDshRelease(Number(req.body?.releaseId))
  if (!instance) return reply.code(404).send({ error: 'no instance' })
  if (!release || !release.self_service) return reply.code(400).send({ error: 'DSH release is not available for self-service' })
  try {
    const { scheduleDshUpgrade } = await import('./orchestrator.js')
    const upgrade = scheduleDshUpgrade(instance.id, release.id, { requestedBy: user.id })
    closeUserSockets(user.id)
    return { ok: true, upgrade: publicDshUpgrade(getDshUpgrade(upgrade.id)) }
  } catch (error) {
    return reply.code(409).send({ error: 'DSH upgrade could not be started' })
  }
})

fastify.post('/api/instance/dsh-rollbacks/:upgradeId', async (req, reply) => {
  const user = requireUser(req, reply)
  if (!user) return
  const instance = getInstanceByUserId(user.id)
  const snapshot = getDshUpgrade(Number(req.params.upgradeId))
  if (!instance) return reply.code(404).send({ error: 'no instance' })
  if (!snapshot || snapshot.instance_id !== instance.id || !snapshot.backup_home_volume || !snapshot.backup_workspace_volume) {
    return reply.code(404).send({ error: 'DSH rollback snapshot not found' })
  }
  const release = getDshRelease(snapshot.from_release_id)
  if (!release?.self_service) return reply.code(400).send({ error: 'DSH release is not available for self-service' })
  try {
    const { scheduleDshUpgrade } = await import('./orchestrator.js')
    const upgrade = scheduleDshUpgrade(instance.id, snapshot.from_release_id, {
      requestedBy: user.id, restoreFromUpgradeId: snapshot.id,
    })
    closeUserSockets(user.id)
    return { ok: true, upgrade: publicDshUpgrade(getDshUpgrade(upgrade.id)) }
  } catch {
    return reply.code(409).send({ error: 'DSH rollback could not be started' })
  }
})

// ---- admin: settings -------------------------------------------------------
registerGatewayAdmin(fastify, { requireAdmin, requireUser })
registerPluginAdmin(fastify, { requireAdmin, requireUser })

fastify.get('/api/admin/settings', async (req, reply) => {
  if (!requireAdmin(req, reply)) return
  return {
    inviteCode: getInviteCode(),
    registrationEnabled: registrationEnabled(),
  }
})

fastify.post('/api/admin/settings', async (req, reply) => {
  if (!requireAdmin(req, reply)) return
  const { inviteCode, registrationEnabled: regEnabled } = req.body ?? {}
  if (regEnabled !== undefined && typeof regEnabled !== 'boolean') return reply.code(400).send({ error: 'registrationEnabled must be boolean' })
  if (inviteCode !== undefined) setInviteCode(inviteCode)
  if (regEnabled !== undefined) setSetting('registration_enabled', regEnabled ? 'true' : 'false')
  return {
    inviteCode: getInviteCode(),
    registrationEnabled: registrationEnabled(),
  }
})

// ---- admin: DSH releases --------------------------------------------------

fastify.get('/api/admin/dsh/releases', async (req, reply) => {
  if (!requireAdmin(req, reply)) return
  return {
    releases: listDshReleases().map(publicDshRelease),
    builds: listDshReleaseBuilds().map((build) => ({
      id: build.id, requestedVersion: build.requested_version, status: build.status,
      releaseId: build.release_id, createdAt: build.created_at, finishedAt: build.finished_at,
      phase: build.phase, logTail: build.log_tail, message: build.message,
    })),
  }
})

fastify.post('/api/admin/dsh/releases/build', async (req, reply) => {
  const admin = requireAdmin(req, reply)
  if (!admin) return
  const version = String(req.body?.version ?? '').trim()
  try {
    const { queueDshReleaseBuild } = await import('./dsh-release-manager.js')
    const build = queueDshReleaseBuild({ version, requestedBy: admin.id })
    return { ok: true, build: { id: build.id, status: build.status, requestedVersion: build.requested_version } }
  } catch (error) {
    return reply.code(409).send({ error: 'DSH image build could not be started' })
  }
})

fastify.post('/api/admin/dsh/releases/:id', async (req, reply) => {
  if (!requireAdmin(req, reply)) return
  const release = getDshRelease(Number(req.params.id))
  if (!release) return reply.code(404).send({ error: 'DSH release not found' })
  const fields = {}
  if (req.body?.isDefault !== undefined) {
    if (typeof req.body.isDefault !== 'boolean') return reply.code(400).send({ error: 'invalid DSH release settings' })
    if (!req.body.isDefault && release.is_default) return reply.code(400).send({ error: 'a default DSH release is required' })
    fields.is_default = req.body.isDefault ? 1 : 0
  }
  if (req.body?.selfService !== undefined) {
    if (typeof req.body.selfService !== 'boolean') return reply.code(400).send({ error: 'invalid DSH release settings' })
    fields.self_service = req.body.selfService ? 1 : 0
  }
  if (Object.keys(fields).length === 0) return reply.code(400).send({ error: 'invalid DSH release settings' })
  updateDshRelease(release.id, fields)
  return { release: publicDshRelease(getDshRelease(release.id)) }
})

// ---- admin: users + instances ---------------------------------------------

fastify.get('/api/admin/users', async (req, reply) => {
  if (!requireAdmin(req, reply)) return
  return { users: listUsers() }
})

fastify.post('/api/admin/users/:id/reset-password', async (req, reply) => {
  const admin = requireAdmin(req, reply)
  if (!admin) return
  const user = getUserById(Number(req.params.id))
  if (!user) return reply.code(404).send({ error: 'not found' })
  const { password } = req.body ?? {}
  if (typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password) > 72) {
    return reply.code(400).send({ error: 'password: at least 8 characters, at most 72 bytes' })
  }
  setUserPassword(user.id, hashPassword(password))
  deleteAllSessionsForUser(user.id)
  closeUserSockets(user.id)
  if (admin.id === user.id) clearSessionAndCookies(req, reply)
  return { ok: true, signedOut: admin.id === user.id }
})

fastify.post('/api/admin/users/:id/delete', async (req, reply) => {
  if (!requireAdmin(req, reply)) return
  const user = getUserById(Number(req.params.id))
  if (!user) return reply.code(404).send({ error: 'not found' })
  if (user.role === 'admin') return reply.code(400).send({ error: 'cannot delete an admin account' })
  const inst = getInstanceByUserId(user.id)
  closeUserSockets(user.id)
  if (inst) {
    updateInstance(inst.id, { status: 'deleting', error: null })
    try {
      await removeContainer(inst.container_name)
      const { removeDshUpgradeBackups } = await import('./orchestrator.js')
      await removeDshUpgradeBackups(inst.id)
    } catch (error) {
      updateInstance(inst.id, { status: 'deleting', error: 'deletion failed; retry the operation' })
      req.log.error(error)
      return reply.code(500).send({ error: 'instance deletion failed; data was retained' })
    }
  }
  deleteUser(user.id)
  return { ok: true }
})

fastify.get('/api/admin/instances', async (req, reply) => {
  if (!requireAdmin(req, reply)) return
  const out = []
  for (const row of listInstancesWithUsers()) out.push(await withLiveState(row))
  return { instances: out }
})

fastify.post('/api/admin/instances/:id/start', async (req, reply) => {
  if (!requireAdmin(req, reply)) return
  const inst = getInstanceById(Number(req.params.id))
  if (!inst) return reply.code(404).send({ error: 'not found' })
  if (inst.status === 'deleting') return reply.code(409).send({ error: 'instance deletion is in progress' })
  if (inst.status === 'upgrading') return reply.code(409).send({ error: 'instance upgrade is in progress' })
  await startContainer(inst.container_name)
  await waitUntilRunning(inst)
  updateInstanceUnlessDeleting(inst.id, { status: 'running', error: null, last_active: Date.now() })
  return { ok: true }
})

fastify.post('/api/admin/instances/:id/stop', async (req, reply) => {
  if (!requireAdmin(req, reply)) return
  const inst = getInstanceById(Number(req.params.id))
  if (!inst) return reply.code(404).send({ error: 'not found' })
  if (inst.status === 'deleting') return reply.code(409).send({ error: 'instance deletion is in progress' })
  if (inst.status === 'upgrading') return reply.code(409).send({ error: 'instance upgrade is in progress' })
  await stopContainer(inst.container_name)
  updateInstanceUnlessDeleting(inst.id, { status: 'stopped', error: null })
  return { ok: true }
})

fastify.post('/api/admin/instances/:id/restart', async (req, reply) => {
  if (!requireAdmin(req, reply)) return
  const inst = getInstanceById(Number(req.params.id))
  if (!inst) return reply.code(404).send({ error: 'not found' })
  if (inst.status === 'deleting') return reply.code(409).send({ error: 'instance deletion is in progress' })
  if (inst.status === 'upgrading') return reply.code(409).send({ error: 'instance upgrade is in progress' })
  await restartContainer(inst.container_name)
  await waitUntilRunning(inst)
  updateInstanceUnlessDeleting(inst.id, { status: 'running', error: null, last_active: Date.now() })
  return { ok: true }
})

fastify.post('/api/admin/instances/:id/delete', async (req, reply) => {
  if (!requireAdmin(req, reply)) return
  const inst = getInstanceById(Number(req.params.id))
  if (!inst) return reply.code(404).send({ error: 'not found' })
  updateInstance(inst.id, { status: 'deleting', error: null })
  try {
    await removeContainer(inst.container_name)
    const { removeDshUpgradeBackups } = await import('./orchestrator.js')
    await removeDshUpgradeBackups(inst.id)
  } catch (error) {
    updateInstance(inst.id, { status: 'deleting', error: 'deletion failed; retry the operation' })
    req.log.error(error)
    return reply.code(500).send({ error: 'instance deletion failed; data was retained' })
  }
  deleteInstance(inst.id)
  return { ok: true }
})

fastify.post('/api/admin/instances/:id/reprovision', async (req, reply) => {
  if (!requireAdmin(req, reply)) return
  const inst = getInstanceById(Number(req.params.id))
  if (!inst) return reply.code(404).send({ error: 'not found' })
  if (inst.status === 'upgrading') return reply.code(409).send({ error: 'instance upgrade is in progress' })
  if (!updateInstanceUnlessDeleting(inst.id, { status: 'provisioning', error: null })) {
    return reply.code(409).send({ error: 'instance deletion is in progress' })
  }
  provision(inst.id).catch((err) => console.error('[provision]', err))
  return { ok: true }
})

fastify.post('/api/admin/instances/:id/dsh-upgrade', async (req, reply) => {
  const admin = requireAdmin(req, reply)
  if (!admin) return
  const inst = getInstanceById(Number(req.params.id))
  const release = getDshRelease(Number(req.body?.releaseId))
  if (!inst || !release) return reply.code(404).send({ error: 'DSH release not found' })
  try {
    const { scheduleDshUpgrade } = await import('./orchestrator.js')
    const upgrade = scheduleDshUpgrade(inst.id, release.id, { requestedBy: admin.id })
    closeUserSockets(inst.user_id)
    return { ok: true, upgrade: publicDshUpgrade(getDshUpgrade(upgrade.id)) }
  } catch {
    return reply.code(409).send({ error: 'DSH upgrade could not be started' })
  }
})

fastify.post('/api/admin/instances/:id/dsh-rollbacks/:upgradeId', async (req, reply) => {
  const admin = requireAdmin(req, reply)
  if (!admin) return
  const inst = getInstanceById(Number(req.params.id))
  const snapshot = getDshUpgrade(Number(req.params.upgradeId))
  if (!inst || !snapshot || snapshot.instance_id !== inst.id || !snapshot.backup_home_volume || !snapshot.backup_workspace_volume) {
    return reply.code(404).send({ error: 'DSH rollback snapshot not found' })
  }
  try {
    const { scheduleDshUpgrade } = await import('./orchestrator.js')
    const upgrade = scheduleDshUpgrade(inst.id, snapshot.from_release_id, {
      requestedBy: admin.id, restoreFromUpgradeId: snapshot.id,
    })
    closeUserSockets(inst.user_id)
    return { ok: true, upgrade: publicDshUpgrade(getDshUpgrade(upgrade.id)) }
  } catch {
    return reply.code(409).send({ error: 'DSH rollback could not be started' })
  }
})

fastify.get('/api/admin/instances/:id/logs', async (req, reply) => {
  if (!requireAdmin(req, reply)) return
  const inst = getInstanceById(Number(req.params.id))
  if (!inst) return reply.code(404).send({ error: 'not found' })
  return { logs: await containerLogs(inst.container_name, 200) }
})

fastify.get('/api/admin/stats', async (req, reply) => {
  if (!requireAdmin(req, reply)) return
  const rows = listInstancesWithUsers()
  return {
    stats: {
      users: listUsers().length,
      instances: rows.length,
      running: rows.filter((r) => r.status === 'running').length,
      totalRequests: rows.reduce((n, r) => n + (r.request_count ?? 0), 0),
    },
  }
})

// ---- public config ---------------------------------------------------------

fastify.get('/api/config', async () => ({
  domain: config.domain,
  instanceDomain: config.instanceDomain,
  registrationEnabled: registrationEnabled(),
  inviteCodeRequired: getInviteCode() !== '',
}))

// ---- helpers ---------------------------------------------------------------

async function withLiveState(inst) {
  const live = await containerRunning(inst.container_name)
  return {
    ...inst, live, url: instanceUrl(inst), dshRelease: publicDshRelease(getDshRelease(inst.release_id)),
    dshUpgrades: listDshUpgrades(inst.id).map(publicDshUpgrade),
  }
}

async function waitUntilRunning(inst) {
  const deadline = Date.now() + config.instanceStartTimeoutMs
  while (Date.now() < deadline) {
    if (await containerRunning(inst.container_name)) {
      const { waitHealthy } = await import('./orchestrator.js')
      if (await waitHealthy(inst.host_port, 30000)) return
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error('instance health check timed out')
}

// Stop running instances that have received no proxied requests within the
// idle window. `last_active` is bumped by every proxied request/upgrade.
function idleSweep() {
  const deadline = Date.now() - config.idleTimeoutMs
  for (const inst of listInstancesWithUsers()) {
    if (inst.status !== 'running') continue
    if (pluginState(inst.id)?.state === 'running') continue
    const last = inst.last_active ?? inst.created_at
    if (last > deadline) continue
    stopContainer(inst.container_name)
      .then(() => {
        if (updateInstanceUnlessDeleting(inst.id, { status: 'stopped', error: null })) {
          console.log(`[portal] idle: stopped instance "${inst.slug}"`)
        }
      })
      .catch((err) => console.error(`[portal] idle: failed to stop "${inst.slug}"`, err))
  }
}

// ---- boot ------------------------------------------------------------------

if (config.gatewayEnabled) {
  const gateway = await startGateway()
  fastify.addHook('onClose', async () => gateway.close())
}

fastify.listen({ port: config.port, host: config.host }, (err) => {
  if (err) {
    console.error('[portal] failed to start:', err)
    process.exit(1)
  }
  console.log(`[portal] listening on http://${config.host}:${config.port}`)
  console.log(`[portal] apex domain: ${config.domain}`)
  console.log(`[portal] cookie domain: ${config.cookieDomain || '(host-only)'}`)
  console.log(`[portal] idle stop after ${Math.round(config.idleTimeoutMs / 60000)}m (sweep every ${Math.round(config.idleSweepIntervalMs / 1000)}s)`)

  // Periodic idle sweep. Keep the handle so the timer isn't GC'd; unref so it
  // never blocks process shutdown.
  const sweepTimer = setInterval(idleSweep, config.idleSweepIntervalMs)
  sweepTimer.unref?.()
  const sessionPurgeTimer = setInterval(() => purgeExpiredSessions(), 60 * 60 * 1000)
  sessionPurgeTimer.unref?.()
})
