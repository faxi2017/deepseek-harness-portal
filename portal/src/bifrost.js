import { createHash } from 'node:crypto'
import { config } from './config.js'
import { decrypt, encrypt, getModel, serverKey } from './gateway-store.js'
import { getSetting, setSetting } from './db.js'

export const bifrostPassword = () => createHash('sha256').update(serverKey()).update('bifrost-admin').digest('hex')
export const bifrostHeaders = (model) => {
  if (model) {
    const saved = JSON.parse(getSetting(`bifrost_vk_${model.id}`, 'null'))
    if (!saved) throw new Error('Model gateway credential is not configured')
    return { authorization: `Bearer ${decrypt(saved.secret)}` }
  }
  return { authorization: `Basic ${Buffer.from(`portal:${bifrostPassword()}`).toString('base64')}` }
}

export async function bifrost(path, method = 'GET', body) {
  const response = await fetch(config.bifrostUrl + path, { method, headers: {
    ...bifrostHeaders(), 'content-type': 'application/json',
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000), redirect: 'error' })
  if (!response.ok) { const error = new Error('模型网关暂不可用，请检查网关服务后重试。'); error.status = response.status; throw error }
  return response.json()
}

const syncLocks = new Map()
export function syncModel(model) {
  const previous = syncLocks.get(model.id) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(() => syncModelUnlocked(getModel(model.id) ?? model))
  syncLocks.set(model.id, current)
  return current.finally(() => { if (syncLocks.get(model.id) === current) syncLocks.delete(model.id) })
}

async function syncModelUnlocked(model) {
  const provider = `portal-${model.id}`
  const payload = { network_config: { base_url: model.base_url, allow_private_network: true,
    max_retries: 0, default_request_timeout_in_seconds: 180 },
    concurrency_and_buffer_size: { concurrency: 10, buffer_size: 100 },
    custom_provider_config: { base_provider_type: 'openai', request_path_overrides: {
      chat_completion: '/chat/completions', chat_completion_stream: '/chat/completions', list_models: '/models',
    } },
    send_back_raw_request: false, send_back_raw_response: false, store_raw_request_response: false }
  try { await bifrost(`/api/providers/${provider}`) }
  catch (error) {
    if (error.status !== 404) throw error
    await bifrost('/api/providers', 'POST', { provider, ...payload })
  }
  await bifrost(`/api/providers/${provider}`, 'PUT', payload)
  const { keys } = await bifrost(`/api/providers/${provider}/keys`)
  const key = (keys ?? []).find((k) => k.name === 'portal-managed')
  const keyBody = { name: 'portal-managed', value: decrypt(model.secret), models: [model.upstream_model],
    weight: 1, enabled: Boolean(model.enabled) }
  await bifrost(`/api/providers/${provider}/keys${key ? `/${key.id}` : ''}`, key ? 'PUT' : 'POST', keyBody)
  let saved = JSON.parse(getSetting(`bifrost_vk_${model.id}`, 'null'))
  const virtualKey = { name: provider, is_active: Boolean(model.enabled), provider_configs: [{
    provider, weight: 1, allowed_models: [model.upstream_model], key_ids: ['*'],
  }] }
  if (saved) {
    try { await bifrost(`/api/governance/virtual-keys/${saved.id}`, 'PUT', virtualKey) }
    catch (error) { if (error.status !== 404) throw error; saved = null }
  }
  if (!saved) {
    const result = await bifrost('/api/governance/virtual-keys', 'POST', virtualKey)
    if (!result.virtual_key?.id || !result.virtual_key?.value) throw new Error('Invalid gateway virtual-key response')
    setSetting(`bifrost_vk_${model.id}`, JSON.stringify({ id: result.virtual_key.id, secret: encrypt(result.virtual_key.value) }))
  }
  return model.updated_at
}
