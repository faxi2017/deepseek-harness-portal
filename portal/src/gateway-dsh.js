import { randomUUID } from 'node:crypto'
import { config } from './config.js'
import { db, getInstanceByHostPort, getInstanceByUserId } from './db.js'
import { allModels, decrypt, ensurePolicy, getPolicy } from './gateway-store.js'
import { docker } from './docker.js'

const dshCookies = new Map()

async function dshCookie(port) {
  const instance = getInstanceByHostPort(port)
  if (!instance) throw new Error('DSH instance is unavailable')
  const { stdout = '', stderr = '' } = await docker(['logs', '--tail', '50', instance.container_name])
  const matches = [...`${stdout}\n${stderr}`.matchAll(/^dsh web: \S+\?token=([A-Za-z0-9_-]{43})(?:\s|$)/gm)]
  const token = matches.at(-1)?.[1]
  if (!token) throw new Error('DSH authentication is not ready')
  const response = await fetch(`http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`, {
    signal: AbortSignal.timeout(10000), redirect: 'manual',
  })
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
  if (!cookie) throw new Error('DSH authentication failed')
  dshCookies.set(port, cookie)
  return cookie
}

export async function dshRpc(port, method, payload, options = {}) {
  const rpcId = randomUUID()
  const endpoint = method.replaceAll('.', '/')
  let cookie = options.authCookie ?? dshCookies.get(port) ?? await dshCookie(port)
  const send = () => fetch(`http://127.0.0.1:${port}/api/${endpoint}`, { method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args: payload } }), signal: AbortSignal.timeout(10000) })
  let response = await send()
  if (response.status === 401 && options.authCookie === undefined) {
    dshCookies.delete(port)
    cookie = await dshCookie(port)
    response = await send()
  }
  if (!response.ok) throw new Error('DSH 配置接口不可用，请启动实例后重试；升级后请检查接口兼容性。')
  const result = await response.json()
  if (result.rpcId !== rpcId || !result.result?.ok) throw new Error('DSH 配置发生变化或接口不兼容，请刷新后重试。')
  return result.result.value
}

const syncLocks = new Map()
export function syncDsh(userId, options = {}) {
  const previous = syncLocks.get(userId) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(() => syncDshUnlocked(userId, options))
  syncLocks.set(userId, current)
  return current.finally(() => { if (syncLocks.get(userId) === current) syncLocks.delete(userId) })
}

async function syncDshUnlocked(userId, { setDefault = false, initial = false } = {}) {
  const policy = ensurePolicy(userId)
  if (initial && (policy.synced_at || !policy.enabled)) return
  const inst = getInstanceByUserId(userId)
  try {
    if (!inst || inst.status === 'deleting' || inst.status === 'provisioning') throw new Error('请先启动用户实例，再下发模型配置。')
    if (!config.gatewayEnabled || !config.gatewayTenantUrl) throw new Error('请先启用模型网关服务。')
    const enabled = new Set(JSON.parse(policy.models))
    const models = allModels().filter((m) => enabled.has(m.id) && m.enabled && !m.sync_error)
    if (!policy.enabled || !models.length) throw new Error('此用户尚未启用可用的平台模型。')
    const snapshot = await dshRpc(inst.host_port, 'settings.describe', {})
    const ns = snapshot.namespaces?.find((n) => n.ns === 'llm-pi-ai')
    if (!snapshot.writable || !ns) throw new Error('当前 DSH 不支持可写的自定义模型配置。')
    const existing = ns.value?.providers?.['portal-gateway']
    if (existing && existing.apiKeyEnv !== 'PORTAL_GATEWAY_API_KEY') throw new Error('DSH 中已有同名的个人配置，请先将 portal-gateway 重命名。')
    // Path mutation with a revision check preserves every personal provider, key and plugin.
    await dshRpc(inst.host_port, 'credentials.set', { ref: 'PORTAL_GATEWAY_API_KEY', value: decrypt(policy.secret) })
    await dshRpc(inst.host_port, 'settings.mutate', { ns: ns.ns, expectedRevision: ns.revision,
      ops: [{ op: 'set', path: ['providers', 'portal-gateway'], value: {
        displayName: '平台模型', api: 'openai-completions', baseURL: config.gatewayTenantUrl,
        apiKeyEnv: 'PORTAL_GATEWAY_API_KEY', models: models.map((m) => ({ id: m.id, name: m.upstream_model,
          maxTokens: m.max_output_tokens, contextWindow: 65536, input: ['text'] })),
      } }] })
    if (setDefault) {
      const defaults = snapshot.namespaces.find((n) => n.ns === 'agent-default-model')
      if (!defaults) throw new Error('模型已下发，但当前 DSH 不支持设置默认模型。')
      await dshRpc(inst.host_port, 'settings.mutate', { ns: defaults.ns, expectedRevision: defaults.revision,
        ops: [{ op: 'set', path: ['provider'], value: 'portal-gateway' }, { op: 'set', path: ['model'], value: models[0].id }] })
    }
    if (getPolicy(userId)?.updated_at !== policy.updated_at) throw new Error('DSH 下发期间用户权限或凭证已变化，请重新下发。')
    db.prepare('UPDATE gateway_users SET synced_at=?,sync_error=NULL WHERE user_id=?').run(Date.now(), userId)
  } catch (error) {
    const message = /^(DSH|请先|当前 DSH|此用户|模型已)/.test(error.message) ? error.message : '模型配置下发失败，请检查实例状态后重试。'
    db.prepare('UPDATE gateway_users SET sync_error=? WHERE user_id=?').run(message, userId)
    throw new Error(message)
  }
}
