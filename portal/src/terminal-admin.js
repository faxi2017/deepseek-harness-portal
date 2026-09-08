import { randomBytes } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Docker from 'dockerode'
import WebSocket, { WebSocketServer } from 'ws'

import { SESSION_COOKIE } from './auth.js'
import { config } from './config.js'
import { sessionForToken } from './db.js'

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

async function execExitCode(exec) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await exec.inspect()
    if (!state.Running && Number.isInteger(state.ExitCode)) return state.ExitCode
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return null
}

async function execOutput(container, cmd) {
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false, User: '0:0', Privileged: true })
  const stream = await exec.start({ hijack: true, stdin: false })
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const chunks = []
  stdout.on('data', (chunk) => chunks.push(chunk))
  stderr.resume()
  container.modem.demuxStream(stream, stdout, stderr)
  await new Promise((resolve, reject) => {
    stream.once('end', resolve)
    stream.once('error', reject)
  })
  return { body: Buffer.concat(chunks), exitCode: await execExitCode(exec) }
}

async function readContainerFile(container, path) {
  const metadata = await execOutput(container, ['/bin/sh', '-c', 'test -f "$1" && [ ! -L "$1" ] && wc -c < "$1"', 'sh', path])
  const size = Number(metadata.body.toString().trim())
  if (metadata.exitCode !== 0 || !Number.isSafeInteger(size) || size < 0) throw new Error('not a single regular file')
  if (size > TERMINAL_MAX_FILE_BYTES) throw new Error('file is too large')
  const file = await execOutput(container, ['/bin/cat', path])
  if (file.exitCode !== 0) throw new Error('download source not found')
  if (file.body.length > TERMINAL_MAX_FILE_BYTES) throw new Error('file is too large')
  return file.body
}

async function writeContainerFile(container, path, body) {
  const exec = await container.exec({
    Cmd: ['/bin/sh', '-c', 'umask 077; cat > "$1" && case "$1" in /home/dsh/*) chown 1000:1000 "$1" ;; esac', 'sh', path],
    AttachStdin: true, AttachStdout: true, AttachStderr: true,
    Tty: false, User: '0:0', Privileged: true,
  })
  const stream = await exec.start({ hijack: true, stdin: true })
  await new Promise((resolve, reject) => {
    stream.once('end', resolve)
    stream.once('error', reject)
    stream.end(body)
  })
  if (await execExitCode(exec) !== 0) throw new Error('write failed')
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
    Privileged: true,
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
    try { await managedRunningContainer(instance) }
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
    let container
    try { container = await managedRunningContainer(instance) }
    catch (error) { return reply.code(error.message === 'instance is not running' ? 409 : 403).send({ error: error.message }) }
    try {
      await writeContainerFile(container, path, req.body)
      return { ok: true, bytes: req.body.length, path }
    } catch (error) {
      return reply.code(400).send({ error: 'upload failed' })
    }
  })

  app.get('/api/admin/terminal/instances/:id/download', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const instance = getInstanceById(Number(req.params.id))
    const path = containerPath(req.query?.path)
    if (!instance) return reply.code(404).send({ error: 'not found' })
    if (!path) return reply.code(400).send({ error: 'invalid download' })
    let container
    try { container = await managedRunningContainer(instance) }
    catch (error) { return reply.code(error.message === 'instance is not running' ? 409 : 403).send({ error: error.message }) }
    try {
      const body = await readContainerFile(container, path)
      const name = basename(path).replace(/[\r\n"\\]/g, '_') || 'download'
      const fallback = name.replace(/[^\x20-\x7e]/g, '_') || 'download'
      reply.type('application/octet-stream').header('Content-Disposition', `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`)
      return reply.send(body)
    } catch (error) {
      if (error?.message === 'file is too large') return reply.code(413).send({ error: 'file is too large' })
      if (error?.message === 'not a single regular file') return reply.code(400).send({ error: 'download must be a regular file' })
      return reply.code(404).send({ error: 'download source not found' })
    }
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
