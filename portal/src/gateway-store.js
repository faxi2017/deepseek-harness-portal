import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.js'
import { db, getSetting, setSetting } from './db.js'

db.exec(`
  CREATE TABLE IF NOT EXISTS gateway_models (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL,
    upstream_model TEXT NOT NULL, secret TEXT NOT NULL, max_output_tokens INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, sync_error TEXT, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS gateway_users (
    user_id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0,
    daily_tokens INTEGER NOT NULL DEFAULT 100000, models TEXT NOT NULL DEFAULT '[]',
    token_hash TEXT UNIQUE NOT NULL, secret TEXT NOT NULL, sync_error TEXT,
    synced_at INTEGER, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS gateway_requests (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, model_id TEXT NOT NULL,
    day TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
    reserved INTEGER NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0, charged_tokens INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'pending'
  );
  CREATE INDEX IF NOT EXISTS gateway_usage_idx ON gateway_requests(user_id, day);
`)

let encryptionKey
export function serverKey() {
  if (encryptionKey) return encryptionKey
  const path = join(config.dataDir, 'gateway.key')
  try { encryptionKey = readFileSync(path) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    const key = randomBytes(32)
    try { writeFileSync(path, key, { flag: 'wx', mode: 0o600 }) } catch (e) { if (e.code !== 'EEXIST') throw e }
    encryptionKey = readFileSync(path)
  }
  if (encryptionKey.length !== 32) throw new Error('Invalid gateway encryption key')
  return encryptionKey
}

export function encrypt(value) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', serverKey(), iv)
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')
}

export function decrypt(value) {
  const data = Buffer.from(value, 'base64')
  const cipher = createDecipheriv('aes-256-gcm', serverKey(), data.subarray(0, 12))
  cipher.setAuthTag(data.subarray(12, 28))
  return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8')
}

export const hashToken = (value) => createHash('sha256').update(value).digest('hex')
export const gatewayDay = (now = Date.now()) => new Date(now + 8 * 3600000).toISOString().slice(0, 10)
export const gatewayEnabled = () => config.gatewayEnabled && getSetting('gateway_enabled', 'true') === 'true'
export const allModels = () => db.prepare('SELECT * FROM gateway_models ORDER BY name').all()
export const getModel = (id) => db.prepare('SELECT * FROM gateway_models WHERE id=?').get(id)
export const publicModel = ({ secret, ...row }) => ({ ...row, hasKey: Boolean(secret) })
export const getPolicy = (id) => db.prepare('SELECT * FROM gateway_users WHERE user_id=?').get(id)

export function ensurePolicy(userId) {
  if (!getPolicy(userId)) {
    const token = `sk-portal-${randomBytes(32).toString('hex')}`
    const defaults = JSON.parse(getSetting('gateway_defaults', '{"enabled":false,"dailyTokens":100000,"models":[]}'))
    db.prepare(`INSERT INTO gateway_users(user_id,enabled,daily_tokens,models,token_hash,secret,updated_at)
      VALUES(?,?,?,?,?,?,?)`).run(userId, Number(defaults.enabled), defaults.dailyTokens,
      JSON.stringify(defaults.models), hashToken(token), encrypt(token), Date.now())
  }
  return getPolicy(userId)
}

export function savePolicy(userId, input) {
  validatePolicy(input)
  ensurePolicy(userId)
  db.prepare('UPDATE gateway_users SET enabled=?,daily_tokens=?,models=?,updated_at=? WHERE user_id=?')
    .run(Number(input.enabled), input.dailyTokens, JSON.stringify(input.models), Math.max(Date.now(), getPolicy(userId).updated_at + 1), userId)
  return getPolicy(userId)
}

export function validatePolicy(input) {
  if (!input || typeof input.enabled !== 'boolean' || !Number.isSafeInteger(input.dailyTokens)
      || input.dailyTokens < 0 || input.dailyTokens > 1000000000 || !Array.isArray(input.models)
      || input.models.length > 100 || new Set(input.models).size !== input.models.length
      || input.models.some((id) => typeof id !== 'string' || !getModel(id))
      || (input.enabled && input.models.length === 0)) throw new Error('请填写有效的模型权限和每日 Token 限额（0 表示禁止调用）。')
}

export function saveDefaults(input) {
  validatePolicy(input)
  setSetting('gateway_defaults', JSON.stringify(input))
}

export function rotateToken(userId) {
  ensurePolicy(userId)
  const token = `sk-portal-${randomBytes(32).toString('hex')}`
  db.prepare('UPDATE gateway_users SET token_hash=?,secret=?,synced_at=NULL,updated_at=? WHERE user_id=?')
    .run(hashToken(token), encrypt(token), Math.max(Date.now(), getPolicy(userId).updated_at + 1), userId)
}

export function usage(userId, day = gatewayDay()) {
  return db.prepare(`SELECT COALESCE(SUM(input_tokens),0) AS inputTokens,
    COALESCE(SUM(output_tokens),0) AS outputTokens, COALESCE(SUM(charged_tokens),0) AS chargedTokens,
    COALESCE(SUM(CASE WHEN state='pending' THEN reserved ELSE 0 END),0) AS reservedTokens,
    COUNT(*) AS requests, COALESCE(SUM(state='uncertain'),0) AS uncertainRequests
    FROM gateway_requests WHERE user_id=? AND day=?`).get(userId, day)
}

export function publicPolicy(userId) {
  const row = ensurePolicy(userId)
  const today = usage(userId)
  return { userId, enabled: Boolean(row.enabled), dailyTokens: row.daily_tokens,
    models: JSON.parse(row.models), syncedAt: row.synced_at, syncError: row.sync_error,
    day: gatewayDay(), ...today, remainingTokens: Math.max(0, row.daily_tokens - today.chargedTokens - today.reservedTokens) }
}

export function authorize(token) {
  if (!gatewayEnabled() || !/^sk-portal-[a-f0-9]{64}$/.test(token)) return null
  return db.prepare(`SELECT g.* FROM gateway_users g JOIN users u ON u.id=g.user_id
    WHERE token_hash=? AND enabled=1`).get(hashToken(token)) ?? null
}

// The transaction runs before any upstream I/O; parallel calls cannot spend the same balance.
export const reserve = db.transaction((userId, modelId, tokens, now = Date.now()) => {
  const policy = getPolicy(userId)
  const model = getModel(modelId)
  if (!policy?.enabled || !model?.enabled || model.sync_error || !JSON.parse(policy.models).includes(modelId)) return null
  const day = gatewayDay(now)
  const spent = usage(userId, day)
  if (tokens > policy.daily_tokens - spent.chargedTokens - spent.reservedTokens) return null
  const id = randomUUID()
  db.prepare('INSERT INTO gateway_requests(id,user_id,model_id,day,started_at,reserved) VALUES(?,?,?,?,?,?)')
    .run(id, userId, modelId, day, now, tokens)
  db.prepare('UPDATE instances SET last_active=? WHERE user_id=?').run(now, userId)
  return id
})

export function settle(id, reported, failed = false) {
  const valid = reported && Number.isSafeInteger(reported.prompt_tokens) && reported.prompt_tokens >= 0
    && Number.isSafeInteger(reported.completion_tokens) && reported.completion_tokens >= 0
    && Number.isSafeInteger(reported.prompt_tokens + reported.completion_tokens)
  const state = valid ? 'completed' : failed ? 'failed' : 'uncertain'
  db.prepare(`UPDATE gateway_requests SET input_tokens=?,output_tokens=?,
    charged_tokens=CASE WHEN ?='uncertain' THEN reserved ELSE ? END,state=?,finished_at=? WHERE id=? AND state='pending'`)
    .run(valid ? reported.prompt_tokens : 0, valid ? reported.completion_tokens : 0, state,
      valid ? reported.prompt_tokens + reported.completion_tokens : 0, state, Date.now(), id)
}

export function recoverPending() {
  // Never refund a call whose upstream outcome was lost during a process restart.
  db.prepare("UPDATE gateway_requests SET state='uncertain',charged_tokens=reserved,finished_at=? WHERE state='pending'").run(Date.now())
}
