import { randomUUID } from 'node:crypto'
import { config } from './config.js'
import { db, getUserById, listUsers, getSetting, setSetting } from './db.js'
import { allModels, encrypt, getModel, publicModel, publicPolicy, savePolicy, saveDefaults,
  deleteModelConfig, rotateToken, gatewayEnabled, gatewayDay, routesForModel, saveModelRoutes } from './gateway-store.js'
import { deleteModel, syncModel, bifrost } from './bifrost.js'
import { syncDsh } from './gateway-dsh.js'
import { gatewayAnalytics, gatewayAnalyticsForUser } from './gateway-analytics.js'
import { syncPersonalUsage } from './personal-usage.js'

export function normalizeBaseUrl(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请输入有效的 HTTP(S) 模型接口地址。')
  return url.href.replace(/\/+$/, '').replace(/\/chat\/completions$/, '')
}

export function registerGatewayAdmin(app, { requireAdmin, requireUser }) {
  const guarded = (handler) => async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    try { return await handler(req, reply) }
    catch (error) { return reply.code(error.gatewayValidation ? 400 : 502).send({ error: error.gatewayValidation ? error.message : '网关操作未完成，请检查服务、模型配置或实例状态后重试。' }) }
  }
  const invalid = (message) => { const error = new Error(message); error.gatewayValidation = true; throw error }
  const userId = (req) => {
    const id = Number(req.params.id)
    if (!Number.isSafeInteger(id) || !getUserById(id)) invalid('用户不存在。')
    return id
  }
  app.get('/api/admin/gateway', guarded(async () => {
    let healthy = false
    if (config.gatewayEnabled) { try { await bifrost('/api/providers'); healthy = true } catch {} }
    return { available: config.gatewayEnabled, enabled: gatewayEnabled(), healthy, engine: 'Bifrost v2.0.0',
      models: allModels().map(publicModel), users: listUsers().filter((u) => u.role !== 'admin').map((u) => ({ ...u, ...publicPolicy(u.id) })),
      defaults: JSON.parse(getSetting('gateway_defaults', '{"enabled":false,"dailyTokens":100000,"models":[]}')), day: gatewayDay() }
  }))
  app.post('/api/admin/gateway/settings', guarded(async (req) => {
    if (typeof req.body?.enabled !== 'boolean') invalid('启用状态必须为布尔值。')
    try { saveDefaults(req.body.defaults) } catch (e) { invalid(e.message) }
    setSetting('gateway_enabled', String(req.body.enabled))
    return { ok: true }
  }))
  app.post('/api/admin/gateway/models', guarded(async (req) => {
    const body = req.body ?? {}
    if (body.id !== undefined && typeof body.id !== 'string') invalid('模型 ID 无效。')
    const existing = body.id ? getModel(body.id) : null
    if (body.id && !existing) invalid('模型不存在。')
    const upstreamModels = (Array.isArray(body.upstreamModels) ? body.upstreamModels
      : typeof body.upstreamModel === 'string' ? body.upstreamModel.split(',') : []).map((value) => value.trim()).filter(Boolean)
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100
        || !upstreamModels.length || upstreamModels.length > 50 || new Set(upstreamModels).size !== upstreamModels.length
        || upstreamModels.some((value) => !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,150}$/.test(value))
        || !Number.isSafeInteger(body.maxOutputTokens) || body.maxOutputTokens < 1 || body.maxOutputTokens > 65536
        || typeof body.enabled !== 'boolean' || typeof body.baseUrl !== 'string' || body.baseUrl.length > 2048
        || (body.apiKey !== undefined && (typeof body.apiKey !== 'string' || body.apiKey.length > 4096))) invalid('请检查模型名称、模型 ID、接口地址和输出 Token 上限。')
    if (!existing && !body.apiKey?.trim()) invalid('新增模型需要填写 API Key。')
    let baseUrl
    try { baseUrl = normalizeBaseUrl(body.baseUrl) } catch { invalid('接口地址应为 HTTP(S) 基础地址，可以包含 /v1。') }
    const id = existing?.id ?? `m-${randomUUID()}`
    const secret = body.apiKey?.trim() ? encrypt(body.apiKey.trim()) : existing.secret
    db.prepare(`INSERT INTO gateway_models(id,name,base_url,upstream_model,secret,max_output_tokens,enabled,sync_error,updated_at)
      VALUES(?,?,?,?,?,?,?,'待同步',?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,base_url=excluded.base_url,
      upstream_model=excluded.upstream_model,secret=excluded.secret,max_output_tokens=excluded.max_output_tokens,
      enabled=excluded.enabled,sync_error='待同步',updated_at=excluded.updated_at`)
      .run(id, body.name.trim(), baseUrl, upstreamModels[0], secret, body.maxOutputTokens, Number(body.enabled), Math.max(Date.now(), (existing?.updated_at ?? 0) + 1))
    saveModelRoutes(id, upstreamModels)
    try {
      const syncedRevision = await syncModel(getModel(id))
      db.prepare('UPDATE gateway_models SET sync_error=NULL WHERE id=? AND updated_at=?').run(id, syncedRevision)
    } catch {
      db.prepare('UPDATE gateway_models SET sync_error=? WHERE id=?').run('网关同步失败；配置已保存，请重试同步。', id)
    }
    return { model: publicModel(getModel(id)) }
  }))
  app.post('/api/admin/gateway/models/:id/sync', guarded(async (req) => {
    const model = getModel(req.params.id)
    if (!model) invalid('模型不存在。')
    if (!config.gatewayEnabled) invalid('服务器尚未启用模型网关，请先启动 Bifrost 并设置 MODEL_GATEWAY_ENABLED=true。')
    const syncedRevision = await syncModel(model)
    db.prepare('UPDATE gateway_models SET sync_error=NULL WHERE id=? AND updated_at=?').run(model.id, syncedRevision)
    return { ok: true }
  }))
  app.delete('/api/admin/gateway/models/:id', guarded(async (req) => {
    const model = getModel(req.params.id)
    if (!model) invalid('模型不存在。')
    if (config.gatewayEnabled) await deleteModel(model)
    deleteModelConfig(model.id)
    return { ok: true }
  }))
  app.post('/api/admin/gateway/users/:id', guarded(async (req) => {
    const id = userId(req)
    try { savePolicy(id, req.body) } catch (e) { invalid(e.message) }
    return { policy: publicPolicy(id) }
  }))
  app.post('/api/admin/gateway/users/:id/sync', guarded(async (req) => {
    const id = userId(req)
    if (req.body?.setDefault !== undefined && typeof req.body.setDefault !== 'boolean') invalid('默认模型设置无效。')
    try { await syncDsh(id, { setDefault: req.body?.setDefault === true }) } catch (e) { invalid(e.message) }
    return { policy: publicPolicy(id) }
  }))
  app.post('/api/admin/gateway/users/:id/rotate', guarded(async (req) => {
    const id = userId(req)
    rotateToken(id)
    return { policy: publicPolicy(id) }
  }))
  app.get('/api/admin/gateway/usage', guarded(async (req) => {
    const from = req.query.from ?? gatewayDay(Date.now() - 29 * 86400000)
    const to = req.query.to ?? gatewayDay()
    if (![from, to].every((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)
      && Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d)
        || from > to || Date.parse(to) - Date.parse(from) > 366 * 86400000) invalid('日期范围须有效且不超过一年。')
    return { from, to, rows: db.prepare(`SELECT r.user_id AS userId,u.username,r.model_id AS modelId,
      mr.name AS modelName,r.day,SUM(input_tokens) AS inputTokens,SUM(output_tokens) AS outputTokens,
      SUM(charged_tokens) AS chargedTokens,SUM(CASE WHEN state='pending' THEN reserved ELSE 0 END) AS reservedTokens,
      COUNT(*) AS requests,SUM(state='uncertain') AS uncertainRequests,SUM(state='failed') AS failedRequests
      FROM gateway_requests r LEFT JOIN users u ON u.id=r.user_id LEFT JOIN gateway_model_routes mr ON mr.id=r.model_id
      WHERE r.day>=? AND r.day<=? GROUP BY r.user_id,r.model_id,r.day ORDER BY r.day DESC,r.user_id`).all(from, to) }
  }))
  app.get('/api/admin/gateway/analytics', guarded(async (req) => {
    try {
      await Promise.all(listUsers().filter((user) => user.role !== 'admin').map((user) => syncPersonalUsage(user.id)))
      return gatewayAnalytics(req.query)
    }
    catch (error) {
      if (/^(请选择|用户筛选|模型筛选)/.test(error.message)) invalid(error.message)
      throw error
    }
  }))
  app.get('/api/gateway/analytics', async (req, reply) => {
    const user = requireUser(req, reply)
    if (!user) return
    if (req.query.userId !== undefined) return reply.code(400).send({ error: '我的用量不支持用户筛选。' })
    try {
      const personalSync = await syncPersonalUsage(user.id)
      const analytics = gatewayAnalyticsForUser(user.id, req.query)
      const policy = publicPolicy(user.id)
      const models = new Map(analytics.options.models.map((model) => [model.id, model]))
      for (const model of allModels()) if (policy.models.includes(model.id)) {
        for (const route of routesForModel(model.id)) models.set(route.id, { id: route.id, name: route.name })
      }
      return { ...analytics, personalSync, options: { models: [...models.values()].sort((a, b) => a.name.localeCompare(b.name)) } }
    }
    catch (error) {
      if (/^(请选择|模型筛选)/.test(error.message)) return reply.code(400).send({ error: error.message })
      throw error
    }
  })
  app.get('/api/gateway/me', async (req, reply) => {
    const user = requireUser(req, reply)
    if (!user) return
    const policy = publicPolicy(user.id)
    return { ...policy, gatewayEnabled: gatewayEnabled(), models: allModels().filter((m) => policy.models.includes(m.id))
      .flatMap((m) => routesForModel(m.id).map((route) => ({ id: route.id, name: route.name,
        enabled: Boolean(m.enabled) && !m.sync_error }))) }
  })
  app.post('/api/gateway/me/sync', async (req, reply) => {
    const user = requireUser(req, reply)
    if (!user) return
    try { await syncDsh(user.id); return { ok: true } }
    catch (e) { return reply.code(409).send({ error: e.message }) }
  })
}
