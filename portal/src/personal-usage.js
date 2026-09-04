import { createHash } from 'node:crypto'
import { db, getInstanceByUserId } from './db.js'
import { dshRpc } from './gateway-dsh.js'
import { gatewayDay } from './gateway-store.js'

const locks = new Map()
const recentlySynced = new Map()
const MAX_HISTORY_PAGES = 20
const PAGE_SIZE = 100

export const personalModelKey = (provider, model) => `personal-${createHash('sha256').update(`${provider}\0${model}`).digest('hex').slice(0, 24)}`

const nonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0

export function personalUsageFromEvents(userId, sessionId, events) {
  const records = []
  for (const event of events) {
    const source = event?.data?.message?.source
    const usage = event?.data?.usage
    if (event?.type !== 'assistant/message' || source?.provider === 'portal-gateway'
        || typeof source?.provider !== 'string' || typeof source?.model !== 'string'
        || source.provider.length > 160 || source.model.length > 160
        || !nonNegativeInteger(event.seq) || !nonNegativeInteger(event.time)
        || !nonNegativeInteger(usage?.inputTokens) || !nonNegativeInteger(usage?.outputTokens)
        || !nonNegativeInteger(usage?.cacheReadTokens ?? 0) || !nonNegativeInteger(usage?.reasoningTokens ?? 0)) continue
    records.push({
      id: `personal:${userId}:${sessionId}:${event.seq}`,
      userId, sessionId, eventSeq: event.seq, provider: source.provider, modelId: source.model,
      modelKey: personalModelKey(source.provider, source.model), day: gatewayDay(event.time), occurredAt: event.time,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens ?? 0, reasoningTokens: usage.reasoningTokens ?? 0,
    })
  }
  return records
}

export const recordPersonalUsage = db.transaction((records) => {
  const insert = db.prepare(`INSERT OR IGNORE INTO personal_usage_records
    (id,user_id,session_id,event_seq,provider,model_id,model_key,day,occurred_at,input_tokens,output_tokens,cache_read_tokens,reasoning_tokens)
    VALUES(@id,@userId,@sessionId,@eventSeq,@provider,@modelId,@modelKey,@day,@occurredAt,@inputTokens,@outputTokens,@cacheReadTokens,@reasoningTokens)`)
  return records.reduce((added, record) => added + insert.run(record).changes, 0)
})

async function syncUnlocked(userId) {
  const instance = getInstanceByUserId(userId)
  if (!instance || instance.status !== 'running') return { status: 'unavailable', added: 0 }
  try {
    const listed = await dshRpc(instance.host_port, 'session.list', {})
    let added = 0, scanned = 0
    for (const { sessionId } of listed.items ?? []) {
      let beforeSeq
      for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
        const history = await dshRpc(instance.host_port, 'session.history', {
          sessionId, maxMessages: PAGE_SIZE, ...(beforeSeq === undefined ? {} : { beforeSeq }),
        })
        const events = history.events?.map((item) => item.event) ?? []
        added += recordPersonalUsage(personalUsageFromEvents(userId, sessionId, events))
        scanned += events.length
        const sequences = events.map((event) => event.seq).filter(Number.isSafeInteger)
        if (!history.hasMore || sequences.length === 0) break
        const next = Math.min(...sequences)
        if (beforeSeq !== undefined && next >= beforeSeq) break
        beforeSeq = next
      }
    }
    recentlySynced.set(userId, Date.now())
    return { status: 'ok', added, scanned }
  } catch {
    return { status: 'unavailable', added: 0 }
  }
}

export function syncPersonalUsage(userId, { force = false } = {}) {
  if (!force && Date.now() - (recentlySynced.get(userId) ?? 0) < 30000) return Promise.resolve({ status: 'cached', added: 0 })
  const previous = locks.get(userId) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(() => syncUnlocked(userId))
  locks.set(userId, current)
  return current.finally(() => { if (locks.get(userId) === current) locks.delete(userId) })
}
