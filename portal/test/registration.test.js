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
const restarted = []
const running = new Set()
mock.module('../src/orchestrator.js', { namedExports: {
  allocatePort: async () => { await new Promise((r) => setTimeout(r, 5)); if (full) throw new Error('full'); return port++ },
  containerName: (slug) => `dsh-${slug}`, containerRunning: async (name) => running.has(name), waitHealthy: async () => true,
  containerLogs: async () => '', dshWebToken: async () => 't'.repeat(43), provision: async (id) => { provisioned.push(id) },
  removeContainer: async () => {}, removeInstanceResources: async () => {}, restartContainer: async (name) => { restarted.push(name); running.add(name) },
  scanInstancePlugins: async () => ({ plugins: [], updatedAt: Date.now() }),
  startContainer: async () => {}, stopContainer: async () => {}, verifyDockerRuntime: async () => {},
  uninstallInstancePlugin: async () => ({ plugins: [], updatedAt: Date.now(), recovered: true }),
} })
const { fastify } = await import('../src/index.js')
if (!fastify.server.listening) await once(fastify.server, 'listening')
const { createDshRelease, createUser, db, getUserByUsername, setSetting, setInviteCode, updateDshRelease } = await import('../src/db.js')
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

test('users can restart only their own instance and administrators can restart any instance', async () => {
  const userLogin = await post('/api/auth/login', { username: 'alice', password: 'replacement-password' })
  const userCookie = userLogin.headers.get('set-cookie').split(';')[0]
  const userSession = await userLogin.json()
  const adminLogin = await post('/api/auth/login', { username: 'admin', password: process.env.ADMIN_PASSWORD })
  const adminCookie = adminLogin.headers.get('set-cookie').split(';')[0]
  const adminSession = await adminLogin.json()
  const instance = db.prepare('SELECT * FROM instances WHERE user_id=?').get(getUserByUsername('alice').id)

  assert.equal((await post('/api/instance/restart', {}, { cookie: userCookie })).status, 403)
  assert.equal((await post('/api/instance/restart', {}, { cookie: userCookie, 'x-csrf-token': userSession.csrfToken })).status, 200)
  assert.equal(restarted.at(-1), instance.container_name)
  assert.ok(db.prepare('SELECT last_active FROM instances WHERE id=?').get(instance.id).last_active >= instance.created_at)
  assert.equal((await post(`/api/admin/instances/${instance.id}/restart`, {}, { cookie: userCookie, 'x-csrf-token': userSession.csrfToken })).status, 403)
  assert.equal((await post(`/api/admin/instances/${instance.id}/restart`, {}, { cookie: adminCookie, 'x-csrf-token': adminSession.csrfToken })).status, 200)
  assert.equal(restarted.at(-1), instance.container_name)
  assert.ok(db.prepare('SELECT last_active FROM instances WHERE id=?').get(instance.id).last_active >= instance.created_at)
})

test('administrator can create exactly one replacement instance for a user without one', async () => {
  const userId = createUser({ username: 'replacement', name: 'Replacement' })
  const adminLogin = await post('/api/auth/login', { username: 'admin', password: process.env.ADMIN_PASSWORD })
  const adminCookie = adminLogin.headers.get('set-cookie').split(';')[0]
  const adminSession = await adminLogin.json()
  const path = `/api/admin/users/${userId}/instance`

  const created = await post(path, {}, { cookie: adminCookie, 'x-csrf-token': adminSession.csrfToken })
  assert.equal(created.status, 200)
  const result = await created.json()
  assert.equal(result.instance.user_id, userId)
  assert.equal(result.instance.status, 'provisioning')
  assert.ok(provisioned.includes(result.instance.id))
  assert.equal((await post(path, {}, { cookie: adminCookie, 'x-csrf-token': adminSession.csrfToken })).status, 409)
  assert.equal(db.prepare('SELECT count(*) AS n FROM instances WHERE user_id=?').get(userId).n, 1)
})

for (const contentType of ['application/json', 'application/x-www-form-urlencoded']) {
  test(`logout accepts ${contentType}, redirects home and revokes sessions`, async () => {
    const login = await post('/api/auth/login', { username: 'admin', password: process.env.ADMIN_PASSWORD })
    const cookie = login.headers.get('set-cookie').split(';')[0]
    const { csrfToken } = await login.json()
    const otherLogin = await post('/api/auth/login', { username: 'admin', password: process.env.ADMIN_PASSWORD })
    const otherCookie = otherLogin.headers.get('set-cookie').split(';')[0]
    const logout = (token, requestOrigin = origin) => fetch(origin + '/api/auth/logout', {
      method: 'POST', redirect: 'manual',
      headers: { cookie, origin: requestOrigin, 'content-type': contentType },
      body: contentType === 'application/json' ? JSON.stringify({ _csrf: token }) : new URLSearchParams({ _csrf: token }),
    })
    assert.equal((await fetch(origin + '/api/auth/logout', { headers: { cookie } })).status, 404)
    assert.equal((await logout('wrong-token')).status, 403)
    assert.equal((await logout(csrfToken, 'http://other.example')).status, 403)
    assert.equal((await fetch(origin + '/api/auth/me', { headers: { cookie } })).status, 200)
    const response = await logout(csrfToken)
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('location'), '/')
    assert.match(response.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/i)
    for (const revokedCookie of [cookie, otherCookie]) {
      assert.equal((await fetch(origin + '/api/auth/me', { headers: { cookie: revokedCookie } })).status, 401)
    }
    assert.equal((await logout(csrfToken)).status, 303)
  })
}

test('gateway admin routes retain session, role, origin and CSRF protection; users see only their own allowance', async () => {
  const login = await post('/api/auth/login', { username: 'alice', password: 'replacement-password' })
  const aliceCookie = login.headers.get('set-cookie').split(';')[0]
  const aliceSession = await login.json()
  const adminLogin = await post('/api/auth/login', { username: 'admin', password: process.env.ADMIN_PASSWORD })
  const adminCookie = adminLogin.headers.get('set-cookie').split(';')[0]
  const adminSession = await adminLogin.json()
  const id = getUserByUsername('alice').id
  const path = `/api/admin/gateway/users/${id}`
  const policy = { enabled: false, dailyTokens: 100, models: [] }
  assert.equal((await fetch(origin + '/api/admin/gateway')).status, 401)
  assert.equal((await post(path, policy, { cookie: aliceCookie, 'x-csrf-token': aliceSession.csrfToken })).status, 403)
  assert.equal((await post(path, policy, { cookie: adminCookie })).status, 403)
  assert.equal((await post(path, policy, { cookie: adminCookie, 'x-csrf-token': adminSession.csrfToken, origin: 'http://other.example' })).status, 403)
  assert.equal((await post(path, policy, { cookie: adminCookie, 'x-csrf-token': adminSession.csrfToken })).status, 200)
  const self = await fetch(origin + '/api/gateway/me?userId=1', { headers: { cookie: aliceCookie } }).then((r) => r.json())
  assert.equal(self.userId, id)
  assert.equal(self.dailyTokens, 100)
  assert.equal(self.secret, undefined)
})

test('plugin management requires an admin session, same origin and CSRF token', async () => {
  const login = await post('/api/auth/login', { username: 'admin', password: process.env.ADMIN_PASSWORD })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const { csrfToken } = await login.json()
  assert.equal((await fetch(origin + '/api/admin/plugins')).status, 401)
  const body = { commands: 'dsh plugin --profile web add dshmarket' }
  assert.equal((await post('/api/admin/plugins', body, { cookie })).status, 403)
  assert.equal((await post('/api/admin/plugins', body, { cookie, 'x-csrf-token': csrfToken, origin: 'http://other.example' })).status, 403)
  assert.equal((await post('/api/admin/plugins', body, { cookie, 'x-csrf-token': csrfToken })).status, 200)
  const user = await post('/api/auth/login', { username: 'alice', password: 'replacement-password' })
  const userCookie = user.headers.get('set-cookie').split(';')[0]
  assert.equal((await fetch(origin + '/api/admin/plugins', { headers: { cookie: userCookie } })).status, 403)
})

test('DSH release inventory is admin-only and a user sees only versions explicitly opened for self-service', async () => {
  const release = createDshRelease({ version: '8.8.8', imageId: `sha256:${'b'.repeat(64)}` })
  const userLogin = await post('/api/auth/login', { username: 'alice', password: 'replacement-password' })
  const userCookie = userLogin.headers.get('set-cookie').split(';')[0]
  const userSession = await userLogin.json()
  const adminLogin = await post('/api/auth/login', { username: 'admin', password: process.env.ADMIN_PASSWORD })
  const adminCookie = adminLogin.headers.get('set-cookie').split(';')[0]
  const adminSession = await adminLogin.json()

  assert.equal((await fetch(origin + '/api/admin/dsh/releases', { headers: { cookie: userCookie } })).status, 403)
  assert.equal((await post(`/api/admin/dsh/releases/${release.id}`, { selfService: true }, {
    cookie: userCookie, 'x-csrf-token': userSession.csrfToken,
  })).status, 403)
  assert.equal((await post(`/api/admin/dsh/releases/${release.id}`, { selfService: true }, {
    cookie: adminCookie, 'x-csrf-token': adminSession.csrfToken,
  })).status, 200)
  assert.equal(updateDshRelease(release.id, { self_service: 0 }), true)
  const hidden = await fetch(origin + '/api/instance', { headers: { cookie: userCookie } }).then((r) => r.json())
  assert.ok(!hidden.releases.some((item) => item.id === release.id))
  updateDshRelease(release.id, { self_service: 1 })
  const opened = await fetch(origin + '/api/instance', { headers: { cookie: userCookie } }).then((r) => r.json())
  assert.ok(opened.releases.some((item) => item.id === release.id))
})
