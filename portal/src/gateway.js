import Fastify from 'fastify'
import { config } from './config.js'
import { authorize, getRoute, reserve, routesForModel, settle, recoverPending, gatewayEnabled } from './gateway-store.js'
import { bifrostHeaders } from './bifrost.js'

const fail = (reply, status, message) => reply.code(status).send({ error: { message, type: 'gateway_error' } })
const allowedFields = ['messages', 'tools', 'tool_choice', 'parallel_tool_calls', 'temperature', 'top_p',
  'stop', 'presence_penalty', 'frequency_penalty', 'response_format', 'reasoning_effort']

export function prepareRequest(body, model) {
  if (!body || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 2048
      || (body.stream !== undefined && typeof body.stream !== 'boolean')
      || (body.n !== undefined && body.n !== 1)) throw new Error('请求格式不正确；每次只支持一个回复。')
  for (const message of body.messages) {
    if (!message || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)
        || (message.content != null && typeof message.content !== 'string'
          && !(Array.isArray(message.content) && message.content.every((part) => part?.type === 'text' && typeof part.text === 'string')))) {
      throw new Error('平台额度目前支持文本和工具调用；图片、音频请使用个人模型。')
    }
  }
  const max = body.max_completion_tokens ?? body.max_tokens ?? model.max_output_tokens
  if (!Number.isSafeInteger(max) || max < 1 || max > model.max_output_tokens) throw new Error('输出 Token 上限超出该模型的平台设置。')
  const payload = Object.fromEntries(allowedFields.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]))
  payload.messages = [...payload.messages]
  const identityAt = payload.messages.findIndex((message) => !['system', 'developer'].includes(message.role))
  payload.messages.splice(identityAt < 0 ? payload.messages.length : identityAt, 0, { role: 'system',
    content: `当前平台模型名称是 ${JSON.stringify(model.name)}。当用户询问你是谁、由哪个模型驱动或正在使用什么模型时，请使用这个名称回答；${model.id} 只是内部路由 ID，不是模型名称。` })
  // Conservative text allowance, including tool schemas and provider framing. This is a
  // reservation, never presented as measured usage. Returned usage replaces it at settlement.
  // DSH requests include sizeable system instructions and tool schemas. Reserving
  // two tokens per UTF-8 byte rejects normal fresh chats before any usage exists.
  // One token per two bytes remains conservative for mixed prose/code while
  // leaving room for the configured output ceiling; settlement uses exact usage.
  const inputAllowance = Math.ceil(Buffer.byteLength(JSON.stringify(payload), 'utf8') / 2) + body.messages.length * 32 + 1024
  payload.model = `portal-${model.gateway_model_id}/${model.upstream_model}`
  payload.max_tokens = max
  payload.stream = body.stream === true
  if (payload.stream) payload.stream_options = { include_usage: true }
  return { payload, reservation: inputAllowance + max }
}

export function buildGateway({ upstream = config.bifrostUrl, headers = bifrostHeaders, timeoutMs = 180000 } = {}) {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 })
  app.setErrorHandler((error, req, reply) => fail(reply, error.statusCode === 413 ? 413 : 400, '模型请求无效或过大。'))
  app.addHook('onRequest', async (req, reply) => {
    if (!gatewayEnabled()) return fail(reply, 503, '平台模型暂未启用。')
    const token = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? ''
    req.policy = authorize(token)
    if (!req.policy) return fail(reply, 401, '平台模型凭证无效或已停用。')
  })
  app.get('/v1/models', async (req) => ({ object: 'list', data: JSON.parse(req.policy.models)
    .flatMap((modelId) => routesForModel(modelId)).map((route) => getRoute(route.id)).filter((m) => m?.enabled && !m.sync_error)
    .map((m) => ({ id: m.id, object: 'model', owned_by: m.provider_name })) }))

  app.post('/v1/chat/completions', async (req, reply) => {
    const model = typeof req.body?.model === 'string' ? getRoute(req.body.model) : null
    if (!model?.enabled || model.sync_error || !JSON.parse(req.policy.models).includes(model.gateway_model_id)) return fail(reply, 403, '未获授权使用此平台模型。')
    let prepared
    try { prepared = prepareRequest(req.body, model) }
    catch (error) { return fail(reply, 400, error.message) }
    const id = reserve(req.policy.user_id, model.id, prepared.reservation)
    if (!id) {
      reply.header('Retry-After', '60')
      return fail(reply, 429, '今日平台 Token 余额不足（含正在使用的预留额度）。请缩短上下文或输出，或联系管理员。')
    }
    let reported
    let definiteFailure = false
    try {
      const response = await fetch(upstream + '/v1/chat/completions', { method: 'POST',
        headers: { ...headers(model), 'content-type': 'application/json' }, body: JSON.stringify(prepared.payload),
        signal: AbortSignal.timeout(timeoutMs), redirect: 'error' })
      if (!response.ok) {
        definiteFailure = [400, 401, 403, 404, 422, 429].includes(response.status)
        await response.body?.cancel()
        return fail(reply, response.status === 429 ? 429 : 502, '模型服务暂时不可用，请稍后重试。')
      }
      if (!prepared.payload.stream) {
        const data = await response.json()
        if (!Array.isArray(data.choices) || data.error) return fail(reply, 502, '模型服务返回异常，请稍后重试。')
        reported = data.usage
        // Do not expose internal gateway metadata, routing details or upstream headers.
        return reply.send({ id: data.id, object: data.object, created: data.created, model: model.id,
          choices: data.choices, usage: data.usage })
      }
      if (!response.headers.get('content-type')?.includes('text/event-stream')) {
        await response.body?.cancel()
        return fail(reply, 502, '模型服务未返回有效的流式响应。')
      }
      reply.hijack()
      reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' })
      reply.raw.setTimeout(30000, () => reply.raw.destroy())
      let buffer = ''
      let done = false
      const decoder = new TextDecoder()
      const write = async (chunk) => {
        if (reply.raw.destroyed) return
        if (!reply.raw.write(chunk)) {
          await new Promise((resolve) => {
            const finish = () => { reply.raw.off('drain', finish); reply.raw.off('close', finish); resolve() }
            reply.raw.once('drain', finish)
            reply.raw.once('close', finish)
          })
        }
      }
      for await (const bytes of response.body) {
        buffer += decoder.decode(bytes, { stream: true })
        if (buffer.length > 2 * 1024 * 1024) throw new Error('stream frame too large')
        let pos
        while ((pos = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, pos).trimEnd()
          buffer = buffer.slice(pos + 1)
          if (!line.startsWith('data:')) continue
          const raw = line.slice(5).trim()
          if (raw === '[DONE]') { done = true; continue }
          if (!raw) continue
          const data = JSON.parse(raw)
          if (data.error) throw new Error('upstream stream failure')
          // Bifrost may retain an empty choice in its final usage frame. Only
          // the last data frame before a complete stream is a final receipt.
          reported = data.usage
          await write(`data: ${JSON.stringify({ id: data.id, object: data.object, created: data.created,
            model: model.id, choices: data.choices ?? [], ...(data.usage ? { usage: data.usage } : {}) })}\n\n`)
        }
      }
      if (!done || buffer.trim()) throw new Error('incomplete stream')
      settle(id, reported)
      await write('data: [DONE]\n\n')
      reply.raw.end()
    } catch {
      // A partial usage frame is not a final receipt. Truncated streams retain
      // the reservation even if the provider emitted an early zero/output count.
      if (prepared.payload.stream) reported = undefined
      if (reply.raw.headersSent) {
        if (!reply.raw.destroyed) reply.raw.end('data: {"error":{"message":"模型响应中断，请稍后重试。"}}\n\n')
      } else return fail(reply, 502, '模型服务暂时不可用，请稍后重试。')
    } finally {
      settle(id, reported, definiteFailure)
    }
  })
  return app
}

export async function startGateway() {
  recoverPending()
  const app = buildGateway()
  await app.listen({ host: config.gatewayHost, port: config.gatewayPort })
  return app
}
