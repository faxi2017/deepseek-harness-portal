import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'

const dataDir = mkdtempSync(join(tmpdir(), 'dsh-proxy-test-'))
process.env.DATA_DIR = dataDir
mock.module('../src/orchestrator.js', { namedExports: {
  startContainer: async () => {}, containerRunning: async () => true, waitHealthy: async () => true,
  dshWebToken: async () => 't'.repeat(43),
} })
const { config } = await import('../src/config.js')
const { db, createUser, createInstanceRow, updateInstance } = await import('../src/db.js')
const { createSession } = await import('../src/auth.js')
const { setupProxy } = await import('../src/proxy.js')

test('real port listeners enforce ownership and origins, strip HTTP/WS credentials', async () => {
  let dshCookieName
  let dshCookie
  const upstream = http.createServer((req, res) => {
    if (req.url === `/?token=${'t'.repeat(43)}`) {
      res.statusCode = 303
      res.setHeader('location', '/')
      res.setHeader('set-cookie', [`${dshCookie}; HttpOnly; SameSite=Strict`, 'attacker=value'])
      res.end()
      return
    }
    res.setHeader('set-cookie', 'attacker=value')
    res.end(JSON.stringify(req.headers))
  })
  let wsHeaders
  upstream.on('upgrade', (req, socket) => {
    wsHeaders = req.headers
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSet-Cookie: attacker=value\r\n\r\n')
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  dshCookieName = `dsh-auth-${createHash('sha256').update(`127.0.0.1:${upstream.address().port}`).digest('base64url')}`
  dshCookie = `${dshCookieName}=v1.signed.value`
  Object.assign(config, { host: '127.0.0.1', port: 27470, instanceRouting: 'ports',
    portalOrigin: 'http://127.0.0.1:27470', instancePortStart: 27471,
    portRangeStart: upstream.address().port, portRangeEnd: upstream.address().port })
  const owner = createUser({ email: 'owner@example.com', name: 'owner' })
  const other = createUser({ email: 'other@example.com', name: 'other' })
  const id = createInstanceRow({ userId: owner, slug: 'owner', containerName: 'dsh-owner', hostPort: upstream.address().port })
  updateInstance(id, { status: 'running' })
  const ownerCookie = `portal_session=${createSession(owner).token}`
  const otherCookie = `portal_session=${createSession(other).token}`
  const app = Fastify()
  await app.register(cookie)
  setupProxy(app)
  app.get('/', async () => 'portal')
  try {
    await app.listen({ host: config.host, port: config.port })
    const url = 'http://127.0.0.1:27471'
    assert.equal(await (await fetch(config.portalOrigin)).text(), 'portal')
    assert.equal((await fetch(url, { redirect: 'manual' })).status, 302)
    assert.equal((await fetch(url, { headers: { cookie: otherCookie } })).status, 403)
    assert.equal((await fetch(url, { method: 'POST', headers: { cookie: ownerCookie, origin: config.portalOrigin } })).status, 403)
    const bootstrap = await fetch(`${url}/?portal_bootstrap=1`, { redirect: 'manual', headers: { cookie: ownerCookie } })
    assert.equal(bootstrap.status, 303)
    assert.match(bootstrap.headers.get('set-cookie'), new RegExp(`^${dshCookieName}=`))
    assert.doesNotMatch(bootstrap.headers.get('set-cookie'), /attacker/)
    const workspace = await fetch(url, { headers: { cookie: `${ownerCookie}; ${dshCookie}` } })
    assert.equal(workspace.status, 200)
    assert.equal((await workspace.json()).cookie, dshCookie)
    const response = await fetch(url, { method: 'POST', headers: { cookie: ownerCookie, origin: url, authorization: 'Bearer private', 'x-csrf-token': 'private' }, body: 'payload' })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('set-cookie'), null)
    const forwarded = await response.json()
    assert.equal(forwarded.origin, `http://127.0.0.1:${upstream.address().port}`)
    for (const key of ['cookie', 'authorization', 'x-csrf-token']) assert.equal(forwarded[key], undefined)
    const handshake = await new Promise((resolve, reject) => {
      const socket = net.connect(27471, '127.0.0.1')
      let result = ''
      socket.setTimeout(5000, () => socket.destroy(new Error('WS timeout')))
      socket.on('error', reject)
      socket.on('data', (chunk) => { result += chunk })
      socket.on('close', () => resolve(result))
      socket.on('connect', () => socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:27471\r\nOrigin: ${url}\r\nCookie: ${ownerCookie}; ${dshCookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`))
    })
    assert.match(handshake, /101 Switching Protocols/)
    assert.doesNotMatch(handshake, /set-cookie/i)
    assert.equal(wsHeaders.cookie, dshCookie)
    assert.equal(wsHeaders.origin, `http://127.0.0.1:${upstream.address().port}`)
  } finally {
    await app.close()
    upstream.closeAllConnections()
    await new Promise((resolve) => upstream.close(resolve))
    db.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
