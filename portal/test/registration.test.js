import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'dsh-registration-test-'))
Object.assign(process.env, { DATA_DIR: dataDir, NODE_ENV: 'production', DOMAIN: '127.0.0.1',
  HOST: '127.0.0.1', PORT: '27570', PORTAL_ORIGIN: 'http://127.0.0.1:27570',
  INSTANCE_ROUTING: 'ports', INSTANCE_PORT_START: '27571', PORT_RANGE_START: '18570', PORT_RANGE_END: '18570',
  DSH_IMAGE: `sha256:${'a'.repeat(64)}`, ADMIN_NAME: 'admin', ADMIN_PASSWORD: 'test-admin-password-123',
  SMTP_HOST: '', SMTP_FROM: '', OTP_DEV_MODE: 'false',
})
let full = false
let port = 18570
const provisioned = []
mock.module('../src/orchestrator.js', { namedExports: {
  allocatePort: async () => { await new Promise((r) => setTimeout(r, 5)); if (full) throw new Error('full'); return port++ },
  containerName: (slug) => `dsh-${slug}`, containerRunning: async () => false, waitHealthy: async () => true,
  containerLogs: async () => '', provision: async (id) => { provisioned.push(id) },
  removeContainer: async () => {}, startContainer: async () => {}, stopContainer: async () => {}, verifyDockerRuntime: async () => {},
} })
const { fastify } = await import('../src/index.js')
if (!fastify.server.listening) await once(fastify.server, 'listening')
const { db, getUserByUsername, setSetting, setInviteCode } = await import('../src/db.js')
const origin = process.env.PORTAL_ORIGIN
const post = (path, body, headers = {}) => fetch(origin + path, { method: 'POST', headers: {
  'content-type': 'application/json', origin, ...headers,
}, body: JSON.stringify(body) })
test.beforeEach(() => db.prepare('DELETE FROM auth_rate_limits').run())
test.after(async () => { await fastify.close(); db.close(); rmSync(dataDir, { recursive: true, force: true }) })

test('production starts without SMTP; account/password registers, provisions and logs in', async () => {
  const response = await post('/api/auth/register', { username: ' Alice ', password: 'account-password' })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('set-cookie'), /HttpOnly/i)
  const result = await response.json()
  assert.equal(result.user.username, 'alice')
  assert.equal(result.user.role, 'user')
  assert.equal(getUserByUsername('alice').email, null)
  assert.notEqual(getUserByUsername('alice').password_hash, 'account-password')
  assert.ok(provisioned.includes(result.instance.id))
  assert.equal(result.instance.url, 'http://127.0.0.1:27571')
  assert.equal((await post('/api/auth/login', { username: 'ALICE', password: 'account-password' })).status, 200)
  assert.equal((await post('/api/auth/login', { username: 'alice', password: 'wrong' })).status, 401)
  assert.equal((await post('/api/auth/register', { username: 'alice', password: 'account-password' })).status, 409)
})

test('invalid credentials, disabled registration, invitation and cross-origin attempts are rejected', async () => {
  for (const body of [{}, { username: 'a b', password: 'valid-password' }, { username: 'b'.repeat(33), password: 'valid-password' },
    { username: 'valid', password: 'short' }, { username: 'valid', password: '密'.repeat(25) }]) {
    assert.equal((await post('/api/auth/register', body)).status, 400)
  }
  setSetting('registration_enabled', 'false')
  assert.equal((await post('/api/auth/register', { username: 'valid', password: 'valid-password' })).status, 403)
  setSetting('registration_enabled', 'true')
  setInviteCode('invitation')
  assert.equal((await post('/api/auth/register', { username: 'invited', password: 'valid-password' })).status, 403)
  assert.equal((await post('/api/auth/register', { username: 'invited', password: 'valid-password', inviteCode: 'invitation' })).status, 200)
  setInviteCode('')
  assert.equal((await post('/api/auth/register', { username: 'forged', password: 'valid-password' }, { origin: 'http://127.0.0.1:27571' })).status, 403)
})

test('capacity failure leaves no account, concurrent duplicate registration creates one instance', async () => {
  full = true
  assert.equal((await post('/api/auth/register', { username: 'capacity', password: 'valid-password' })).status, 503)
  assert.equal(getUserByUsername('capacity'), null)
  full = false
  const results = await Promise.all([1, 2].map(() => post('/api/auth/register', { username: 'concurrent', password: 'valid-password' })))
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
  assert.equal(db.prepare('SELECT count(*) AS n FROM instances WHERE user_id=?').get(getUserByUsername('concurrent').id).n, 1)
})

test('retired email endpoints are unavailable and registration is rate limited', async () => {
  for (const path of ['/api/auth/register/request', '/api/auth/register/verify', '/api/auth/login/request', '/api/auth/login/verify', '/api/profile/email-change/request']) {
    assert.equal((await post(path, {})).status, 404)
  }
  for (let i = 0; i < 10; i++) await post('/api/auth/register', { username: `bad-${i}`, password: 'x' })
  assert.equal((await post('/api/auth/register', { username: 'limited', password: 'valid-password' })).status, 429)
})

test('administrator can recover a password without email and revokes old sessions', async () => {
  const login = await post('/api/auth/login', { username: 'alice', password: 'account-password' })
  const oldCookie = login.headers.get('set-cookie').split(';')[0]
  const admin = await post('/api/auth/login', { username: 'admin', password: process.env.ADMIN_PASSWORD })
  const adminCookie = admin.headers.get('set-cookie').split(';')[0]
  const { csrfToken } = await admin.json()
  const path = `/api/admin/users/${getUserByUsername('alice').id}/reset-password`
  assert.equal((await post(path, { password: 'replacement-password' }, { cookie: oldCookie })).status, 403)
  assert.equal((await post(path, { password: 'replacement-password' }, { cookie: adminCookie, 'x-csrf-token': csrfToken })).status, 200)
  assert.equal((await fetch(origin + '/api/auth/me', { headers: { cookie: oldCookie } })).status, 401)
  assert.equal((await post('/api/auth/login', { username: 'alice', password: 'replacement-password' })).status, 200)
})
