import { randomBytes } from 'node:crypto'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import Docker from 'dockerode'
import tar from 'tar-stream'
import WebSocket, { WebSocketServer } from 'ws'

import { SESSION_COOKIE } from './auth.js'
import { config } from './config.js'
import { sessionForToken } from './db.js'
import { docker } from './docker.js'

export const TERMINAL_WS_PATH = '/api/admin/terminal/ws'
export const TERMINAL_MAX_FILE_BYTES = 16 * 1024 * 1024
const TICKET_TTL_MS = 30 * 1000
const __dirname = dirname(fileURLToPath(import.meta.url))

const tickets = new Map()
const sessions = new Set()

export function containerPath(value) {
  const path = String(value ?? '').trim()
  if (!path.startsWith('/') || /[\0\r\n]/.test(path) || Buffer.byteLength(path) > 4096) return null
  return path
}

function cookieValue(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const [key, ...rest] = part.split('=')
    if (key.trim() === name) return rest.join('=').trim()
  }
  return ''
}

async function managedRunningContainer(instance) {
  const dockerClient = new Docker()
  const container = dockerClient.getContainer(instance.container_name)
  const info = await container.inspect()
  if (info.Config?.Labels?.['dsh.portal.managed'] !== 'true') throw new Error('unmanaged container')
  if (!info.State?.Running) throw new Error('instance is not running')
  return container
}

function pruneTickets() {
  const now = Date.now()
  for (const [ticket, value] of tickets) if (value.expiresAt <= now) tickets.delete(ticket)
}

function socketError(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'error', message }))
}

function archiveFile(archive) {
  return new Promise((resolve, reject) => {
    const extract = tar.extract()
    let result = null
    let failed = false
    const fail = (error) => {
      if (failed) return
      failed = true
      reject(error)
      archive.destroy()
    }
    extract.on('entry', (header, stream, next) => {
      if (result !== null || header.type !== 'file') return fail(new Error('not a single regular file'))
      const chunks = []
      let size = 0
      stream.on('data', (chunk) => {
        size += chunk.length
        if (size > TERMINAL_MAX_FILE_BYTES) return fail(new Error('file is too large'))
        chunks.push(chunk)
      })
      stream.on('end', () => {
        result = Buffer.concat(chunks)
        next()
      })
      stream.on('error', fail)
    })
    extract.once('finish', () => {
      if (!failed && result !== null) resolve(result)
      else if (!failed) reject(new Error('not a single regular file'))
    })
    extract.once('error', fail)
    archive.once('error', fail)
    archive.pipe(extract)
  })
}

async function attachTerminal(socket, instance, sessionToken, userId) {
  const container = await managedRunningContainer(instance)
  const current = sessionForToken(sessionToken, { touch: false })
  if (!current || current.user.id !== userId || current.user.role !== 'admin') {
    socket.close(1008, 'session revoked')
    return
  }
  const exec = await container.exec({
    Cmd: ['/bin/bash', '-l'],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    User: '0:0',
    WorkingDir: '/workspace',
    Env: ['TERM=xterm-256color', 'COLORTERM=truecolor', 'HOME=/home/dsh', 'DSH_HOME=/home/dsh/.dsh'],
  })
  const stream = await exec.start({ hijack: true, stdin: true, Tty: true })
  const tracked = { socket, stream, userId, sessionToken }
  sessions.add(tracked)

  stream.on('data', (chunk) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(chunk)
  })
  stream.once('error', () => socketError(socket, '终端连接已中断'))
  stream.once('end', () => socket.close(1000, 'shell exited'))
  socket.on('message', async (raw, isBinary) => {
    if (isBinary || raw.length > 64 * 1024) return socket.close(1009, 'message too large')
    let message
    try { message = JSON.parse(raw.toString()) } catch { return }
    if (message.type === 'input' && typeof message.data === 'string') stream.write(message.data)
    if (message.type === 'resize') {
      const cols = Math.min(500, Math.max(2, Number(message.cols) || 80))
      const rows = Math.min(200, Math.max(1, Number(message.rows) || 24))
      await exec.resize({ w: Math.floor(cols), h: Math.floor(rows) }).catch(() => {})
    }
  })
  const cleanup = () => {
    sessions.delete(tracked)
    if (!stream.destroyed) stream.destroy()
  }
  socket.once('close', cleanup)
  socket.once('error', cleanup)
  socket.send(JSON.stringify({ type: 'ready' }))
}

export function closeTerminalSocketsForUser(userId) {
  for (const tracked of sessions) if (tracked.userId === userId) tracked.socket.close(1008, 'session revoked')
}

export function registerTerminalAdmin(app, { requireAdmin, getInstanceById, listInstancesWithUsers }) {
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))

  app.get('/vendor/xterm.js', (_req, reply) => reply.sendFile('xterm.js', join(__dirname, '..', 'node_modules', '@xterm', 'xterm', 'lib')))
  app.get('/vendor/xterm-fit.js', (_req, reply) => reply.sendFile('addon-fit.js', join(__dirname, '..', 'node_modules', '@xterm', 'addon-fit', 'lib')))
  app.get('/vendor/xterm.css', (_req, reply) => reply.sendFile('xterm.css', join(__dirname, '..', 'node_modules', '@xterm', 'xterm', 'css')))

  app.get('/api/admin/terminal/instances', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    return { instances: listInstancesWithUsers().filter((instance) => !['deleting', 'provisioning'].includes(instance.status)).map((instance) => ({
      id: instance.id, slug: instance.slug, username: instance.username, status: instance.status,
    })) }
  })

  app.post('/api/admin/terminal/ticket', async (req, reply) => {
    const admin = requireAdmin(req, reply)
    if (!admin) return
    const instance = getInstanceById(Number(req.body?.instanceId))
    if (!instance) return reply.code(404).send({ error: 'not found' })
    let container
    try { container = await managedRunningContainer(instance) }
    catch (error) {
      if (error.message === 'instance is not running') return reply.code(409).send({ error: error.message })
      return reply.code(403).send({ error: 'unmanaged container' })
    }
    pruneTickets()
    const ticket = randomBytes(32).toString('base64url')
    tickets.set(ticket, {
      instanceId: instance.id, userId: admin.id,
      sessionToken: req.cookies?.[SESSION_COOKIE], expiresAt: Date.now() + TICKET_TTL_MS,
    })
    return { ticket }
  })

  app.post('/api/admin/terminal/instances/:id/upload', {
    bodyLimit: TERMINAL_MAX_FILE_BYTES,
  }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const instance = getInstanceById(Number(req.params.id))
    const path = containerPath(req.query?.path)
    if (!instance) return reply.code(404).send({ error: 'not found' })
    if (!path || !Buffer.isBuffer(req.body) || req.body.length === 0) return reply.code(400).send({ error: 'invalid upload' })
    try { await managedRunningContainer(instance) }
    catch (error) { return reply.code(error.message === 'instance is not running' ? 409 : 403).send({ error: error.message }) }
    const dir = mkdtempSync(join(tmpdir(), 'dsh-terminal-upload-'))
    const source = join(dir, 'upload')
    try {
      writeFileSync(source, req.body, { mode: 0o600 })
      try {
        await docker(['cp', source, `${instance.container_name}:${path}`], { timeout: Math.max(config.dockerCommandTimeoutMs, 120000) })
      } catch { return reply.code(400).send({ error: 'upload failed' }) }
      return { ok: true, bytes: req.body.length, path }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  app.get('/api/admin/terminal/instances/:id/download', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const instance = getInstanceById(Number(req.params.id))
    const path = containerPath(req.query?.path)
    if (!instance) return reply.code(404).send({ error: 'not found' })
    if (!path) return reply.code(400).send({ error: 'invalid download' })
    try { await managedRunningContainer(instance) }
    catch (error) { return reply.code(error.message === 'instance is not running' ? 409 : 403).send({ error: error.message }) }
    const dir = mkdtempSync(join(tmpdir(), 'dsh-terminal-download-'))
    const target = join(dir, 'download')
    try {
      let size
      try {
        const checked = await docker(['exec', '--user', '0:0', instance.container_name,
          'stat', '-Lc', '%F\t%s', '--', path])
        const match = /^regular file\t(\d+)\s*$/.exec(checked.stdout)
        if (!match) return reply.code(400).send({ error: 'download must be a regular file' })
        size = Number(match[1])
      } catch { return reply.code(404).send({ error: 'download source not found' }) }
      if (!Number.isSafeInteger(size) || size > TERMINAL_MAX_FILE_BYTES) return reply.code(413).send({ error: 'file is too large' })
      try {
        await docker(['cp', '-L', `${instance.container_name}:${path}`, target], { timeout: Math.max(config.dockerCommandTimeoutMs, 120000) })
      } catch { return reply.code(404).send({ error: 'download source not found' }) }
      const stat = lstatSync(target)
      if (!stat.isFile()) return reply.code(400).send({ error: 'download must be a regular file' })
      if (stat.size > TERMINAL_MAX_FILE_BYTES) return reply.code(413).send({ error: 'file is too large' })
      const body = readFileSync(target)
      const name = basename(path).replace(/[\r\n"\\]/g, '_') || 'download'
      const fallback = name.replace(/[^\x20-\x7e]/g, '_') || 'download'
      reply.type('application/octet-stream').header('Content-Disposition', `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`)
      return reply.send(body)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  app.server.on('upgrade', (req, socket, head) => {
    let url
    try { url = new URL(req.url, config.portalOrigin) } catch { return }
    if (url.pathname !== TERMINAL_WS_PATH) return
    const ticketKey = url.searchParams.get('ticket')
    const ticket = tickets.get(ticketKey)
    if (ticketKey) tickets.delete(ticketKey)
    const sessionToken = cookieValue(req.headers.cookie, SESSION_COOKIE)
    const session = sessionForToken(sessionToken)
    if (req.headers.origin !== config.portalOrigin || !ticket || ticket.expiresAt <= Date.now()
        || ticket.sessionToken !== sessionToken || session?.user?.role !== 'admin' || session.user.id !== ticket.userId) {
      socket.destroy()
      return
    }
    const instance = getInstanceById(ticket.instanceId)
    if (!instance) return socket.destroy()
    websocketServer.handleUpgrade(req, socket, head, (websocket) => {
      attachTerminal(websocket, instance, sessionToken, ticket.userId).catch(() => {
        socketError(websocket, '无法连接实例终端')
        websocket.close(1011, 'terminal unavailable')
      })
    })
  })

  const sessionTimer = setInterval(() => {
    pruneTickets()
    for (const tracked of sessions) {
      if (!sessionForToken(tracked.sessionToken, { touch: false })) tracked.socket.close(1008, 'session expired')
    }
  }, 30 * 1000)
  sessionTimer.unref?.()
  app.addHook('onClose', async () => {
    clearInterval(sessionTimer)
    for (const tracked of sessions) tracked.socket.terminate()
  })
}
