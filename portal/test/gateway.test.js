import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'

const dir = mkdtempSync(join(tmpdir(), 'dsh-gateway-test-'))
Object.assign(process.env, { DATA_DIR: dir, MODEL_GATEWAY_ENABLED: 'true' })
const { db, createUser, setSetting, deleteUser } = await import('../src/db.js')
const store = await import('../src/gateway-store.js')
const { buildGateway, prepareRequest } = await import('../src/gateway.js')
const { registerGatewayAdmin } = await import('../src/gateway-admin.js')
const { gatewayAnalytics } = await import('../src/gateway-analytics.js')
const { personalUsageFromEvents, recordPersonalUsage, personalModelKey } = await import('../src/personal-usage.js')
const { config } = await import('../src/config.js')
let mode = 'success'
let upstreamCalls = 0
let observed
const upstream = Fastify()
const providers = new Map()
upstream.get('/api/providers', async () => ({ providers: [] }))
upstream.get('/api/providers/:id', async (req, reply) => providers.has(req.params.id) ? providers.get(req.params.id) : reply.code(404).send({ error: 'not found' }))
upstream.post('/api/providers', async (req) => { providers.set(req.body.provider, req.body); return {} })
upstream.put('/api/providers/:id', async (req) => { providers.set(req.params.id, req.body); return {} })
upstream.get('/api/providers/:id/keys', async () => ({ keys: null, total: 0 }))
upstream.post('/api/providers/:id/keys', async (req) => { assert.ok(req.body.value); return { key: { id: 'test-key' } } })
upstream.post('/api/governance/virtual-keys', async (req) => {
  assert.equal(req.body.provider_configs[0].allowed_models[0], 'test-upstream')
  return { virtual_key: { id: 'test-vk', value: 'sk-bf-fixture-secret' } }
})
upstream.put('/api/governance/virtual-keys/:id', async () => ({}))
upstream.post('/v1/chat/completions', async (req, reply) => {
  upstreamCalls++
  observed = { body: req.body, headers: req.headers }
  if (mode === 'slow') await new Promise((r) => setTimeout(r, 80))
  if (mode === 'error') return reply.code(401).send({ error: { message: 'private upstream key SECRET' } })
  if (mode === 'timeout') { await new Promise((r) => setTimeout(r, 500)); return {} }
  if (mode === 'missing') return { choices: [{ message: { content: 'hello' } }] }
  const usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
  if (req.body.stream) {
    reply.hijack()
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream' })
    const event = `data: ${JSON.stringify({ choices: [{ delta: { content: '你好', ...(req.body.tools ? { tool_calls: [{ index: 0, id: 'call-test', type: 'function', function: { name: 'echo', arguments: '{"text":"OK"}' } }] } : {}) } }] })}\r\n\r\n`
    const bytes = Buffer.from(event)
    reply.raw.write(bytes.subarray(0, bytes.length - 6))
    reply.raw.write(bytes.subarray(bytes.length - 6))
    if (mode === 'partial-usage') reply.raw.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 0 } })}\n\n`)
    else if (mode === 'early-usage') reply.raw.write(`data: ${JSON.stringify({ choices: [], usage })}\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: 'more' } }] })}\n\ndata: [DONE]\n\n`)
    else if (mode !== 'truncated') reply.raw.write(`data: ${JSON.stringify({ choices: mode === 'bifrost-usage' ? [{ delta: {} }] : [], usage })}\n\ndata: [DONE]\n\n`)
    reply.raw.end()
    return
  }
  return { choices: [{ message: { content: 'hello' } }], usage }
})
await upstream.listen({ host: '127.0.0.1', port: 0 })
const gateway = buildGateway({ upstream: `http://127.0.0.1:${upstream.server.address().port}`, headers: () => ({ authorization: 'Basic test-gateway' }), timeoutMs: 200 })
const admin = Fastify()
registerGatewayAdmin(admin, {
  requireAdmin: (req, reply) => req.headers.authorization === 'admin' ? { id: 1 } : (reply.code(403).send({ error: 'admin only' }), null),
  requireUser: (req) => ({ id: Number(req.headers['test-user']) }),
})
let uid, other, model, token
test.beforeEach(() => {
  db.exec('DELETE FROM personal_usage_records; DELETE FROM gateway_requests; DELETE FROM gateway_users; DELETE FROM gateway_models; DELETE FROM users;')
  uid = Number(createUser({ username: 'alice', name: 'Alice' }))
  other = Number(createUser({ username: 'bob', name: 'Bob' }))
  db.prepare(`INSERT INTO gateway_models(id,name,base_url,upstream_model,secret,max_output_tokens,updated_at)
    VALUES('m-test','Test','http://upstream/v1','test-upstream',?,100,?)`).run(store.encrypt('upstream-SECRET'), Date.now())
  model = store.getModel('m-test')
  store.savePolicy(uid, { enabled: true, models: [model.id], dailyTokens: 100000 })
  store.savePolicy(other, { enabled: false, models: [], dailyTokens: 100000 })
  token = store.decrypt(store.getPolicy(uid).secret)
  mode = 'success'; upstreamCalls = 0
  setSetting('gateway_enabled', 'true')
})
test.after(async () => { await gateway.close(); await upstream.close(); await admin.close(); db.close(); rmSync(dir, { recursive: true, force: true }) })
const body = (extra = {}) => ({ model: 'm-test', messages: [{ role: 'user', content: 'hello' }], max_tokens: 20, ...extra })
const call = (payload = body(), key = token) => gateway.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${key}` }, payload })

test('real HTTP adapter settles measured input/output; encrypted secrets are never returned by admin or user APIs', async () => {
  const result = await call()
  assert.equal(result.statusCode, 200)
  assert.equal(result.json().usage.total_tokens, 18)
  assert.equal(store.usage(uid).chargedTokens, 18)
  assert.equal(store.usage(other).chargedTokens, 0)
  assert.notEqual(model.secret, 'upstream-SECRET')
  assert.notEqual(store.getPolicy(uid).token_hash, token)
  const self = await admin.inject({ url: '/api/gateway/me', headers: { 'test-user': String(uid) } })
  assert.ok(!self.body.includes(token) && !self.body.includes('SECRET'))
  const stats = await admin.inject({ url: '/api/admin/gateway/usage', headers: { authorization: 'admin' } })
  assert.equal(stats.json().rows[0].inputTokens, 11)
  assert.equal(stats.json().rows[0].outputTokens, 7)
})

test('unauthorized model, forged key, disabled policy and admin access are blocked before upstream I/O', async () => {
  assert.equal((await call(body(), 'bad-key')).statusCode, 401)
  assert.equal((await call(body({ model: 'other-model' }))).statusCode, 403)
  assert.equal((await call(body(), store.decrypt(store.getPolicy(other).secret))).statusCode, 401)
  assert.equal((await admin.inject({ url: '/api/admin/gateway' })).statusCode, 403)
  assert.equal((await gateway.inject({ url: '/api/providers', headers: { authorization: `Bearer ${token}` } })).statusCode, 404)
  assert.equal(upstreamCalls, 0)
})

test('parallel requests cannot reserve the same token balance', async () => {
  const cost = prepareRequest(body(), model).reservation
  store.savePolicy(uid, { enabled: true, models: [model.id], dailyTokens: cost })
  mode = 'slow'
  const results = await Promise.all([call(), call(), call()])
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 429, 429])
  assert.equal(upstreamCalls, 1)
  assert.equal(store.usage(uid).reservedTokens, 0)
  store.savePolicy(uid, { enabled: true, models: [model.id], dailyTokens: 0 })
  assert.equal((await call()).statusCode, 429)
})

test('SSE chunks preserve text and tool calls, consume final usage exactly once', async () => {
  mode = 'bifrost-usage'
  const r = await call(body({ stream: true, tools: [{ type: 'function', function: { name: 'echo', parameters: { type: 'object' } } }] }))
  assert.equal(r.statusCode, 200)
  assert.match(r.body, /你好/)
  assert.match(r.body, /tool_calls/)
  assert.match(r.body, /call-test/)
  assert.match(r.body, /\[DONE\]/)
  assert.equal(observed.body.stream_options.include_usage, true)
  assert.equal(store.usage(uid).chargedTokens, 18)
  assert.equal(store.usage(uid).requests, 1)
})

test('missing usage, interrupted SSE and timeout keep a conservative charge; upstream errors are redacted', async () => {
  mode = 'missing'
  assert.equal((await call()).statusCode, 200)
  assert.equal(store.usage(uid).chargedTokens, prepareRequest(body(), model).reservation)
  mode = 'truncated'
  const broken = await call(body({ stream: true }))
  assert.match(broken.body, /响应中断/)
  assert.doesNotMatch(broken.body, /\[DONE\]/)
  mode = 'partial-usage'
  await call(body({ stream: true }))
  mode = 'early-usage'
  await call(body({ stream: true }))
  mode = 'timeout'
  assert.equal((await call()).statusCode, 502)
  assert.equal(store.usage(uid).uncertainRequests, 5)
  mode = 'error'
  const rejected = await call()
  assert.equal(rejected.statusCode, 502)
  assert.ok(!rejected.body.includes('SECRET'))
  assert.equal(store.usage(uid).uncertainRequests, 5)
})

test('calendar days reset at Shanghai midnight, reservations settle against their original day after midnight or restart', () => {
  const before = Date.parse('2026-09-03T15:59:59Z')
  const after = Date.parse('2026-09-03T16:00:00Z')
  assert.equal(store.gatewayDay(before), '2026-09-03')
  assert.equal(store.gatewayDay(after), '2026-09-04')
  const id = store.reserve(uid, model.id, 1000, before)
  store.settle(id, { prompt_tokens: 200, completion_tokens: 100 })
  store.settle(id, { prompt_tokens: 500, completion_tokens: 100 })
  assert.equal(store.usage(uid, '2026-09-03').chargedTokens, 300)
  assert.equal(store.usage(uid, '2026-09-04').chargedTokens, 0)
  store.reserve(uid, model.id, 500, after)
  store.recoverPending()
  assert.equal(store.usage(uid, '2026-09-04').chargedTokens, 500)
  assert.equal(store.usage(uid, '2026-09-04').reservedTokens, 0)
})

test('caller cannot override routing, upstream credentials, retries, usage collection or token count multiplier', async () => {
  await call(body({ api_key: 'attacker-key', api_base: 'http://evil', user: String(other), fallbacks: ['evil'], metadata: { user_id: other }, stream: true, stream_options: { include_usage: false } }))
  for (const key of ['api_key', 'api_base', 'user', 'fallbacks', 'metadata']) assert.equal(observed.body[key], undefined)
  assert.equal(observed.body.model, 'portal-m-test/test-upstream')
  assert.equal(observed.headers.authorization, 'Basic test-gateway')
  for (const bad of [body({ n: 2 }), body({ max_tokens: 101 }), body({ max_tokens: -1 }), body({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://example.com' } }] }] })]) {
    assert.equal((await call(bad)).statusCode, 400)
  }
})

test('rotation, account deletion and the global switch revoke platform access without resetting usage', async () => {
  await call()
  store.rotateToken(uid)
  assert.equal((await call()).statusCode, 401)
  token = store.decrypt(store.getPolicy(uid).secret)
  assert.equal((await call()).statusCode, 200)
  assert.equal(store.usage(uid).chargedTokens, 36)
  setSetting('gateway_enabled', 'false')
  assert.equal((await call()).statusCode, 503)
  setSetting('gateway_enabled', 'true')
  deleteUser(uid)
  assert.equal((await call()).statusCode, 401)
})

test('invalid quotas, inaccessible models and malformed settings do not change policy', async () => {
  const valid = { enabled: true, models: [model.id], dailyTokens: 100000 }
  for (const patch of [{ dailyTokens: -1 }, { dailyTokens: 1.2 }, { dailyTokens: '20' }, { models: [] }, { models: ['missing'] }, { models: [model.id, model.id] }]) {
    const r = await admin.inject({ method: 'POST', url: `/api/admin/gateway/users/${uid}`, headers: { authorization: 'admin' }, payload: { ...valid, ...patch } })
    assert.equal(r.statusCode, 400)
    assert.equal(store.getPolicy(uid).daily_tokens, 100000)
  }
  config.gatewayEnabled = false
  assert.equal((await call()).statusCode, 503)
  config.gatewayEnabled = true
})

test('Bifrost v2 null-key bootstrap, inference credentials and exact endpoint paths are handled', async () => {
  const { syncModel, bifrostHeaders } = await import('../src/bifrost.js')
  const old = config.bifrostUrl
  config.bifrostUrl = `http://127.0.0.1:${upstream.server.address().port}`
  try {
    await syncModel(model)
    const p = providers.get('portal-m-test')
    assert.equal(p.network_config.base_url, 'http://upstream/v1')
    assert.equal(p.custom_provider_config.request_path_overrides.chat_completion, '/chat/completions')
    assert.equal(p.custom_provider_config.request_path_overrides.chat_completion_stream, '/chat/completions')
    assert.equal(p.network_config.max_retries, 0)
    assert.equal(bifrostHeaders(model).authorization, 'Bearer sk-bf-fixture-secret')
    const detail = await admin.inject({ url: '/api/admin/gateway', headers: { authorization: 'admin' } })
    assert.equal(detail.json().healthy, true)
    assert.ok(!detail.body.includes('fixture-secret') && !detail.body.includes('upstream-SECRET') && !detail.body.includes(token))
  } finally { config.bifrostUrl = old }
})

test('invalid statistics dates and unsafe model base URLs are rejected without exposing inputs', async () => {
  for (const from of ['2026-99-01', '2026-02-30', 'bad', '2020-01-01']) {
    const r = await admin.inject({ url: `/api/admin/gateway/usage?from=${from}&to=2026-09-03`, headers: { authorization: 'admin' } })
    assert.equal(r.statusCode, 400)
  }
  const { normalizeBaseUrl } = await import('../src/gateway-admin.js')
  assert.equal(normalizeBaseUrl('http://example.com/v1/chat/completions'), 'http://example.com/v1')
  for (const url of ['file:///tmp/data', 'http://name:password@example.com', 'http://example.com/?key=secret']) assert.throws(() => normalizeBaseUrl(url))
})

test('analytics returns one filtered snapshot with zero-filled trends, comparisons and dimensions', async () => {
  db.prepare(`INSERT INTO gateway_models(id,name,base_url,upstream_model,secret,max_output_tokens,updated_at)
    VALUES('m-other','Other','http://other/v1','other-upstream',?,100,?)`).run(store.encrypt('other-key'), Date.now())
  const add = (id, user, modelId, day, startedAt, input, output, charged, reserved, state) => db.prepare(`INSERT INTO gateway_requests
    (id,user_id,model_id,day,started_at,finished_at,reserved,input_tokens,output_tokens,charged_tokens,state)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, user, modelId, day, startedAt, startedAt + 1000, reserved, input, output, charged, state)
  add('prev', uid, model.id, '2026-08-30', Date.parse('2026-08-30T01:00:00Z'), 10, 5, 15, 100, 'completed')
  add('d1', uid, model.id, '2026-08-31', Date.parse('2026-08-31T01:30:00Z'), 100, 20, 120, 500, 'completed')
  add('d2', uid, model.id, '2026-09-01', Date.parse('2026-09-01T02:00:00Z'), 80, 40, 120, 500, 'completed')
  add('d3', other, 'm-other', '2026-09-01', Date.parse('2026-09-01T15:00:00Z'), 50, 10, 120, 200, 'uncertain')
  add('d4', other, 'm-other', '2026-09-02', Date.parse('2026-09-02T04:00:00Z'), 0, 0, 0, 100, 'failed')
  add('d5', other, 'm-other', '2026-09-02', Date.parse('2026-09-02T05:00:00Z'), 0, 0, 0, 900, 'pending')
  const response = await admin.inject({ url: '/api/admin/gateway/analytics?from=2026-08-31&to=2026-09-02&grain=day', headers: { authorization: 'admin' } })
  assert.equal(response.statusCode, 200)
  const data = response.json()
  assert.deepEqual(data.trend.map((r) => r.period), ['2026-08-31', '2026-09-01', '2026-09-02'])
  assert.equal(data.summary.actualTokens, 300)
  assert.equal(data.summary.chargedTokens, 360)
  assert.equal(data.summary.uncertainTokens, 120)
  assert.equal(data.summary.reservedTokens, 900)
  assert.equal(data.summary.requests, 5)
  assert.equal(data.summary.activeUsers, 2)
  assert.equal(data.previous.actualTokens, 15)
  assert.deepEqual(data.users.map((u) => u.name).sort(), ['alice', 'bob'])
  assert.deepEqual(data.models.map((m) => m.name).sort(), ['Other', 'Test'])
  assert.equal(data.heatmap.find((r) => r.weekday === 0 && r.hour === 9).actualTokens, 120)
  assert.ok(!response.body.includes('other-key') && !response.body.includes('SECRET'))
  const filtered = await admin.inject({ url: `/api/admin/gateway/analytics?from=2026-08-31&to=2026-09-02&userId=${uid}&modelId=m-test&grain=week`, headers: { authorization: 'admin' } })
  assert.equal(filtered.json().summary.actualTokens, 240)
  assert.deepEqual(filtered.json().trend.map((r) => r.period), ['2026-08-31'])
})

test('analytics rejects invalid filters and large hourly ranges through the admin guard', async () => {
  for (const query of ['from=2026-02-30&to=2026-03-01', 'from=2026-01-01&to=2027-01-02',
    'from=2026-01-01&to=2026-02-01&grain=hour', 'from=2026-01-01&to=2026-01-02&grain=minute',
    'from=2026-01-01&to=2026-01-02&userId=-1', 'from=2026-01-01&to=2026-01-02&modelId=bad%2Fmodel']) {
    const response = await admin.inject({ url: `/api/admin/gateway/analytics?${query}`, headers: { authorization: 'admin' } })
    assert.equal(response.statusCode, 400)
  }
  assert.equal((await admin.inject({ url: '/api/admin/gateway/analytics?from=2026-01-01&to=2026-01-02' })).statusCode, 403)
})

test('my analytics is limited to the signed-in user and omits identity fields', async () => {
  db.prepare(`INSERT INTO gateway_models(id,name,base_url,upstream_model,secret,max_output_tokens,updated_at)
    VALUES('m-other','Other','http://other/v1','other-upstream',?,100,?)`).run(store.encrypt('other-key'), Date.now())
  const add = (id, user, modelId, input, output) => db.prepare(`INSERT INTO gateway_requests
    (id,user_id,model_id,day,started_at,finished_at,reserved,input_tokens,output_tokens,charged_tokens,state)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, user, modelId, '2026-09-02', Date.parse('2026-09-02T02:00:00Z'), Date.parse('2026-09-02T02:00:01Z'), 100, input, output, input + output, 'completed')
  add('mine', uid, model.id, 80, 20)
  add('other-user', other, 'm-other', 900, 100)

  const response = await admin.inject({ url: '/api/gateway/analytics?from=2026-09-02&to=2026-09-02&grain=day', headers: { 'test-user': String(uid) } })
  assert.equal(response.statusCode, 200)
  const data = response.json()
  assert.equal(data.summary.actualTokens, 100)
  assert.equal(data.summary.requests, 1)
  assert.equal(data.users, undefined)
  assert.deepEqual(data.options.models.map(({ id, name }) => ({ id, name })), [{ id: 'm-test', name: 'Test' }])
  assert.ok(!response.body.includes('http://upstream') && !response.body.includes('test-upstream'))
  assert.deepEqual(data.rows[0].userId, undefined)
  assert.deepEqual(data.rows[0].username, undefined)
  assert.ok(!response.body.includes('bob') && !response.body.includes('Other') && !response.body.includes('other-key'))

  const blocked = await admin.inject({ url: `/api/gateway/analytics?from=2026-09-02&to=2026-09-02&userId=${other}`, headers: { 'test-user': String(uid) } })
  assert.equal(blocked.statusCode, 400)
})

test('completed personal-model events are idempotent, visible in analytics, and never consume platform quota', async () => {
  const occurredAt = Date.parse('2026-09-02T03:00:00Z')
  const records = personalUsageFromEvents(uid, 'session-personal', [
    { type: 'assistant/message', seq: 7, time: occurredAt, data: { message: { source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }, usage: { inputTokens: 80, outputTokens: 20, cacheReadTokens: 30, reasoningTokens: 4 } } },
    { type: 'assistant/message', seq: 8, time: occurredAt, data: { message: { source: { provider: 'portal-gateway', model: 'm-test' } }, usage: { inputTokens: 1, outputTokens: 1 } } },
  ])
  assert.equal(records.length, 1)
  assert.equal(records[0].modelKey, personalModelKey('deepseek-official', 'deepseek-v4-flash'))
  assert.equal(recordPersonalUsage(records), 1)
  assert.equal(recordPersonalUsage(records), 0)

  const analytics = gatewayAnalytics({ from: '2026-09-02', to: '2026-09-02', grain: 'day', userId: String(uid) })
  assert.equal(analytics.summary.actualTokens, 100)
  assert.equal(analytics.summary.personalActualTokens, 100)
  assert.equal(analytics.summary.platformActualTokens, 0)
  assert.equal(analytics.summary.personalRequests, 1)
  assert.equal(analytics.summary.chargedTokens, 0)
  assert.equal(analytics.models[0].name, 'deepseek-official / deepseek-v4-flash')
  assert.equal(analytics.rows[0].source, 'personal')

  const response = await admin.inject({ url: '/api/gateway/analytics?from=2026-09-02&to=2026-09-02&grain=day', headers: { 'test-user': String(uid) } })
  assert.equal(response.statusCode, 200)
  const data = response.json()
  assert.equal(data.summary.personalActualTokens, 100)
  assert.equal(data.rows[0].source, 'personal')
  assert.equal(data.rows[0].userId, undefined)
  assert.ok(!response.body.includes('cacheReadTokens') && !response.body.includes('reasoningTokens'))
  assert.equal(store.usage(uid, '2026-09-02').chargedTokens, 0)
})
