import { createHash } from 'node:crypto'
import { db, getInstanceByUserId } from './db.js'
import { dshRpc } from './gateway-dsh.js'
import { gatewayDay } from './gateway-store.js'
import { docker } from './docker.js'

const locks = new Map()
const recentlySynced = new Map()
const MAX_HISTORY_PAGES = 20
const PAGE_SIZE = 100

export const personalModelKey = (provider, model) => `personal-${createHash('sha256').update(`${provider}\0${model}`).digest('hex').slice(0, 24)}`

const nonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0
const isPlatformProvider = (value) => typeof value === 'string'
  && (value === 'portal-gateway' || value.startsWith('portal-gateway-'))

export function personalUsageFromEvents(userId, sessionId, events) {
  const records = []
  for (const event of events) {
    const source = event?.data?.message?.source
    const usage = event?.data?.usage
    if (event?.type !== 'assistant/message' || isPlatformProvider(source?.provider)
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

export const recordPersonalUsageSnapshots = db.transaction((userId, snapshots) => {
  const previous = db.prepare(`SELECT event_seq,input_tokens,output_tokens,cache_read_tokens
    FROM personal_usage_checkpoints WHERE user_id=? AND session_id=?`)
  const save = db.prepare(`INSERT INTO personal_usage_checkpoints
    (user_id,session_id,event_seq,input_tokens,output_tokens,cache_read_tokens) VALUES(?,?,?,?,?,?)
    ON CONFLICT(user_id,session_id) DO UPDATE SET event_seq=excluded.event_seq,input_tokens=excluded.input_tokens,
    output_tokens=excluded.output_tokens,cache_read_tokens=excluded.cache_read_tokens`)
  let added = 0
  for (const snapshot of snapshots) {
    if (isPlatformProvider(snapshot?.provider)
        || typeof snapshot?.sessionId !== 'string' || snapshot.sessionId.length > 200
        || typeof snapshot.provider !== 'string' || typeof snapshot.model !== 'string'
        || snapshot.provider.length > 160 || snapshot.model.length > 160
        || ![snapshot.seq, snapshot.occurredAt, snapshot.inputTokens, snapshot.outputTokens, snapshot.cacheReadTokens].every(nonNegativeInteger)) continue
    const prior = previous.get(userId, snapshot.sessionId)
    if (prior && snapshot.seq <= prior.event_seq) continue
    const delta = (value, old) => value >= old ? value - old : value
    const inputTokens = delta(snapshot.inputTokens, prior?.input_tokens ?? 0)
    const outputTokens = delta(snapshot.outputTokens, prior?.output_tokens ?? 0)
    const cacheReadTokens = delta(snapshot.cacheReadTokens, prior?.cache_read_tokens ?? 0)
    save.run(userId, snapshot.sessionId, snapshot.seq, snapshot.inputTokens, snapshot.outputTokens, snapshot.cacheReadTokens)
    if (inputTokens + outputTokens + cacheReadTokens === 0) continue
    added += recordPersonalUsage([{
      id: `personal-snapshot:${userId}:${snapshot.sessionId}:${snapshot.seq}`,
      userId, sessionId: `snapshot:${snapshot.sessionId}`, eventSeq: snapshot.seq,
      provider: snapshot.provider, modelId: snapshot.model, modelKey: personalModelKey(snapshot.provider, snapshot.model),
      day: gatewayDay(snapshot.occurredAt), occurredAt: snapshot.occurredAt,
      inputTokens: inputTokens + cacheReadTokens, outputTokens, cacheReadTokens, reasoningTokens: 0,
    }])
  }
  return added
})

async function readUsageSnapshots(instance) {
  const script = `const fs=require('fs'),p='/home/dsh/.dsh/storages/session_projcache/sessions';let out=[];
try{for(const name of fs.readdirSync(p)){if(!name.endsWith('.json'))continue;try{const file=p+'/'+name,x=JSON.parse(fs.readFileSync(file)),r=x.record?.rows,
u=r?.tokenUsage?.val?.totals,m=r?.modelSelection?.val?.lastUsed;if(!u||!m)continue;out.push({sessionId:name.slice(0,-5),seq:r.tokenUsage.seq,
occurredAt:Math.trunc(fs.statSync(file).mtimeMs),provider:m.provider,model:m.model,inputTokens:u.uncachedInputTokens,
outputTokens:u.outputTokens,cacheReadTokens:u.cacheReadTokens??0})}catch{}}}catch{}process.stdout.write(JSON.stringify(out))`
  const { stdout } = await docker(['exec', instance.container_name, 'node', '-e', script])
  const snapshots = JSON.parse(stdout)
  if (!Array.isArray(snapshots)) throw new Error('Invalid DSH usage snapshot')
  return snapshots
}

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
    try {
      const snapshots = await readUsageSnapshots(instance)
      const added = recordPersonalUsageSnapshots(userId, snapshots)
      recentlySynced.set(userId, Date.now())
      return { status: 'ok', source: 'snapshot', added, scanned: snapshots.length }
    } catch {
      return { status: 'unavailable', added: 0 }
    }
  }
}

export function syncPersonalUsage(userId, { force = false } = {}) {
  if (!force && Date.now() - (recentlySynced.get(userId) ?? 0) < 30000) return Promise.resolve({ status: 'cached', added: 0 })
  const previous = locks.get(userId) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(() => syncUnlocked(userId))
  locks.set(userId, current)
  return current.finally(() => { if (locks.get(userId) === current) locks.delete(userId) })
}
