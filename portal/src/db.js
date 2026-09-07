import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.js'

mkdirSync(config.dataDir, { recursive: true })
export const db = new Database(join(config.dataDir, 'portal.db'))
db.pragma('journal_mode = WAL')

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,
  username TEXT UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS otps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  slug TEXT UNIQUE NOT NULL,
  container_name TEXT UNIQUE NOT NULL,
  host_port INTEGER UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'provisioning',
  error TEXT,
  created_at INTEGER NOT NULL,
  last_active INTEGER,
  request_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  scope TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(scope, subject_hash)
);
CREATE TABLE IF NOT EXISTS personal_usage_records (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL,
  event_seq INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_key TEXT NOT NULL,
  day TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, session_id, event_seq)
);
CREATE INDEX IF NOT EXISTS personal_usage_user_day_idx ON personal_usage_records(user_id, day);
CREATE INDEX IF NOT EXISTS personal_usage_day_model_idx ON personal_usage_records(day, user_id, model_key);
CREATE TABLE IF NOT EXISTS personal_usage_checkpoints (
  user_id INTEGER NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL,
  event_seq INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  PRIMARY KEY(user_id, session_id)
);

CREATE TABLE IF NOT EXISTS dsh_releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL,
  image_id TEXT NOT NULL UNIQUE,
  is_default INTEGER NOT NULL DEFAULT 0,
  self_service INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS dsh_releases_default_idx ON dsh_releases(is_default, created_at DESC);

CREATE TABLE IF NOT EXISTS dsh_release_builds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requested_version TEXT NOT NULL,
  status TEXT NOT NULL,
  release_id INTEGER REFERENCES dsh_releases(id),
  requested_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  message TEXT
);
CREATE INDEX IF NOT EXISTS dsh_release_builds_status_idx ON dsh_release_builds(status, created_at DESC);

CREATE TABLE IF NOT EXISTS dsh_upgrade_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER NOT NULL REFERENCES instances(id),
  from_release_id INTEGER REFERENCES dsh_releases(id),
  to_release_id INTEGER NOT NULL REFERENCES dsh_releases(id),
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_by INTEGER REFERENCES users(id),
  backup_home_volume TEXT,
  backup_workspace_volume TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  message TEXT
);
CREATE INDEX IF NOT EXISTS dsh_upgrade_history_instance_idx ON dsh_upgrade_history(instance_id, id DESC);
`)

const instanceColumns = new Set(db.pragma('table_info(instances)').map((row) => row.name))
if (!instanceColumns.has('release_id')) db.exec('ALTER TABLE instances ADD COLUMN release_id INTEGER REFERENCES dsh_releases(id)')

const dshReleaseBuildColumns = new Set(db.pragma('table_info(dsh_release_builds)').map((row) => row.name))
if (!dshReleaseBuildColumns.has('phase')) db.exec("ALTER TABLE dsh_release_builds ADD COLUMN phase TEXT NOT NULL DEFAULT 'queued'")
if (!dshReleaseBuildColumns.has('log_tail')) db.exec("ALTER TABLE dsh_release_builds ADD COLUMN log_tail TEXT NOT NULL DEFAULT ''")

/** Seed the image configured before version management was introduced. */
export function ensureConfiguredDshRelease() {
  if (!config.image) return null
  const existing = db.prepare('SELECT * FROM dsh_releases WHERE image_id = ?').get(config.image)
  if (existing) return existing
  const any = db.prepare('SELECT id FROM dsh_releases LIMIT 1').get()
  const result = db.prepare(`INSERT INTO dsh_releases
      (version,image_id,is_default,self_service,created_at) VALUES (?,?,?,?,?)`)
    .run('当前受控镜像', config.image, any ? 0 : 1, 0, Date.now())
  const release = getDshRelease(Number(result.lastInsertRowid))
  if (!any) db.prepare('UPDATE instances SET release_id=? WHERE release_id IS NULL').run(release.id)
  return release
}

export function getDshRelease(id) {
  if (!Number.isInteger(Number(id))) return null
  return db.prepare('SELECT * FROM dsh_releases WHERE id = ?').get(Number(id)) ?? null
}

export function getDshReleaseByImage(imageId) {
  return db.prepare('SELECT * FROM dsh_releases WHERE image_id = ?').get(imageId) ?? null
}

export function getDefaultDshRelease() {
  return db.prepare('SELECT * FROM dsh_releases WHERE is_default=1 ORDER BY id DESC LIMIT 1').get() ?? null
}

export function listDshReleases() {
  return db.prepare('SELECT * FROM dsh_releases ORDER BY is_default DESC, created_at DESC, id DESC').all()
}

export function updateDshRelease(id, fields) {
  const allowed = ['is_default', 'self_service', 'version']
  const entries = Object.entries(fields).filter(([key]) => allowed.includes(key))
  if (entries.length === 0) return false
  const run = db.transaction(() => {
    if (fields.is_default === 1) db.prepare('UPDATE dsh_releases SET is_default=0').run()
    const sets = entries.map(([key]) => `${key}=@${key}`).join(', ')
    return db.prepare(`UPDATE dsh_releases SET ${sets} WHERE id=@id`).run({ id: Number(id), ...fields }).changes === 1
  })
  return run()
}

export function createDshRelease({ version, imageId, createdBy = null }) {
  const existing = getDshReleaseByImage(imageId)
  if (existing) return existing
  const result = db.prepare(`INSERT INTO dsh_releases
      (version,image_id,is_default,self_service,created_at,created_by) VALUES (?,?,0,0,?,?)`)
    .run(version, imageId, Date.now(), createdBy)
  return getDshRelease(Number(result.lastInsertRowid))
}

export function createDshReleaseBuild({ requestedVersion, requestedBy }) {
  const result = db.prepare(`INSERT INTO dsh_release_builds
      (requested_version,status,requested_by,created_at) VALUES (?, 'queued', ?, ?)`)
    .run(requestedVersion, requestedBy, Date.now())
  return getDshReleaseBuild(Number(result.lastInsertRowid))
}

export function getDshReleaseBuild(id) {
  return db.prepare('SELECT * FROM dsh_release_builds WHERE id=?').get(Number(id)) ?? null
}

export function listDshReleaseBuilds(limit = 20) {
  return db.prepare('SELECT * FROM dsh_release_builds ORDER BY id DESC LIMIT ?').all(limit)
}

export function updateDshReleaseBuild(id, fields) {
  const keys = Object.keys(fields)
  if (keys.length === 0) return
  const sets = keys.map((key) => `${key}=@${key}`).join(', ')
  db.prepare(`UPDATE dsh_release_builds SET ${sets} WHERE id=@id`).run({ id: Number(id), ...fields })
}

export function createDshUpgrade({ instanceId, fromReleaseId, toReleaseId, operation, requestedBy }) {
  const now = Date.now()
  const result = db.prepare(`INSERT INTO dsh_upgrade_history
      (instance_id,from_release_id,to_release_id,operation,status,requested_by,created_at,started_at)
      VALUES (?,?,?,?, 'running', ?,?,?)`)
    .run(instanceId, fromReleaseId, toReleaseId, operation, requestedBy, now, now)
  return getDshUpgrade(Number(result.lastInsertRowid))
}

export function getDshUpgrade(id) {
  return db.prepare(`SELECT h.*, fr.version AS from_version, tr.version AS to_version
    FROM dsh_upgrade_history h
    LEFT JOIN dsh_releases fr ON fr.id=h.from_release_id
    LEFT JOIN dsh_releases tr ON tr.id=h.to_release_id WHERE h.id=?`).get(Number(id)) ?? null
}

export function listDshUpgrades(instanceId, limit = 10) {
  return db.prepare(`SELECT h.*, fr.version AS from_version, tr.version AS to_version
    FROM dsh_upgrade_history h
    LEFT JOIN dsh_releases fr ON fr.id=h.from_release_id
    LEFT JOIN dsh_releases tr ON tr.id=h.to_release_id
    WHERE h.instance_id=? ORDER BY h.id DESC LIMIT ?`).all(Number(instanceId), limit)
}

export function listDshUpgradeBackups(instanceId) {
  return db.prepare(`SELECT backup_home_volume,backup_workspace_volume FROM dsh_upgrade_history
    WHERE instance_id=? AND backup_home_volume IS NOT NULL AND backup_workspace_volume IS NOT NULL`).all(Number(instanceId))
}

export function updateDshUpgrade(id, fields) {
  const keys = Object.keys(fields)
  if (keys.length === 0) return
  const sets = keys.map((key) => `${key}=@${key}`).join(', ')
  db.prepare(`UPDATE dsh_upgrade_history SET ${sets} WHERE id=@id`).run({ id: Number(id), ...fields })
}

export function recoverInterruptedDshUpgrades() {
  const now = Date.now()
  const active = db.prepare("SELECT DISTINCT instance_id FROM dsh_upgrade_history WHERE status='running'").all()
  db.prepare(`UPDATE dsh_upgrade_history SET status='interrupted', finished_at=?,
    message='Portal 在升级过程中退出；请由管理员从升级记录执行回退。' WHERE status='running'`).run(now)
  const mark = db.prepare("UPDATE instances SET status='failed', error=? WHERE id=? AND status='upgrading'")
  for (const row of active) mark.run('升级被中断；请由管理员执行回退。', row.instance_id)
}

export function recoverInterruptedDshReleaseBuilds() {
  db.prepare(`UPDATE dsh_release_builds SET status='interrupted', finished_at=?,
    phase='interrupted', message='Portal 在构建过程中退出；请重新发起构建。' WHERE status IN ('queued','running')`).run(Date.now())
}

db.pragma('secure_delete = ON')

export function digestSessionToken(token) {
  return createHash('sha256').update(String(token ?? '')).digest('hex')
}

// Migrate the P0 plaintext-token table in one transaction. Browser cookies keep
// their raw random token; only the database representation changes to SHA-256.
const migrateSessions = db.transaction(() => {
  let columns = new Set(db.pragma('table_info(sessions)').map((row) => row.name))
  const hadPlaintextTokens = columns.has('token')
  if (hadPlaintextTokens) {
    db.prepare(`INSERT INTO settings(key,value) VALUES('session_token_cleanup_pending','true')
                ON CONFLICT(key) DO UPDATE SET value='true'`).run()
    db.exec('ALTER TABLE sessions RENAME COLUMN token TO token_hash')
    columns = new Set(db.pragma('table_info(sessions)').map((row) => row.name))
  }
  if (!columns.has('csrf_token')) db.exec('ALTER TABLE sessions ADD COLUMN csrf_token TEXT')
  if (!columns.has('last_seen_at')) db.exec('ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER')
  if (!columns.has('absolute_expires_at')) db.exec('ALTER TABLE sessions ADD COLUMN absolute_expires_at INTEGER')

  if (hadPlaintextTokens) {
    const updateHash = db.prepare('UPDATE sessions SET token_hash = ? WHERE token_hash = ?')
    for (const row of db.prepare('SELECT token_hash FROM sessions').all()) {
      updateHash.run(digestSessionToken(row.token_hash), row.token_hash)
    }
  }
  const now = Date.now()
  db.prepare(`UPDATE sessions SET
      csrf_token = CASE WHEN csrf_token IS NULL OR length(csrf_token) != 64 THEN lower(hex(randomblob(32))) ELSE csrf_token END,
      last_seen_at = COALESCE(last_seen_at, ?),
      absolute_expires_at = COALESCE(absolute_expires_at, created_at + ?)`)
    .run(now, config.sessionAbsoluteTtlMs)
  db.prepare('DELETE FROM sessions WHERE absolute_expires_at <= ?').run(now)
  return hadPlaintextTokens
})
const migratedPlaintextSessions = migrateSessions()
const tokenCleanupPending = migratedPlaintextSessions
  || db.prepare("SELECT value FROM settings WHERE key='session_token_cleanup_pending'").get()?.value === 'true'
if (tokenCleanupPending) {
  const [checkpoint] = db.pragma('wal_checkpoint(TRUNCATE)')
  if (!checkpoint || checkpoint.busy !== 0 || checkpoint.log !== 0) {
    throw new Error('session-token migration could not securely truncate the SQLite WAL; stop other database users and retry')
  }
  db.prepare(`INSERT INTO settings(key,value) VALUES('session_token_cleanup_pending','false')
              ON CONFLICT(key) DO UPDATE SET value='false'`).run()
}
db.exec(`
  CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(absolute_expires_at, last_seen_at);
  CREATE INDEX IF NOT EXISTS auth_rate_limits_cleanup_idx ON auth_rate_limits(updated_at);
`)
ensureConfiguredDshRelease()

// ---- users ----

export function createUser({ email = null, username = null, name, passwordHash = null, role = 'user' }) {
  return db.prepare(
    'INSERT INTO users (email, username, name, password_hash, role, created_at) VALUES (?,?,?,?,?,?)',
  ).run(email, username, name, passwordHash, role, Date.now()).lastInsertRowid
}

export function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email) ?? null
}

export function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) ?? null
}

export function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) ?? null
}

export function updateUser(id, fields) {
  const keys = Object.keys(fields)
  if (keys.length === 0) return
  const sets = keys.map((k) => `${k} = @${k}`).join(', ')
  db.prepare(`UPDATE users SET ${sets} WHERE id = @id`).run({ id, ...fields })
}

export function setUserPassword(id, passwordHash) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id)
}

export function listUsers() {
  return db.prepare('SELECT id, email, username, name, role, created_at FROM users ORDER BY id').all()
}

// ---- settings (admin controls) ----

export function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  return row === undefined ? fallback : row.value
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value))
}

export function getEmailDomains() {
  return getSetting('email_domains', '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

export function otpRegistrationEnabled() {
  return getSetting('otp_registration_enabled', 'true') === 'true'
}

export function passwordLoginEnabled() {
  return getSetting('password_login_enabled', 'true') === 'true'
}

export function getInviteCode() {
  return getSetting('invite_code', '').trim()
}

export function setInviteCode(code) {
  setSetting('invite_code', String(code ?? '').trim())
}

// ---- instances ----

export function createInstanceRow({ userId, slug, containerName, hostPort, releaseId = getDefaultDshRelease()?.id ?? null }) {
  return db.prepare(
    `INSERT INTO instances (user_id, slug, container_name, host_port, release_id, status, created_at)
     VALUES (?,?,?,?,?, 'provisioning', ?)`,
  ).run(userId, slug, containerName, hostPort, releaseId, Date.now()).lastInsertRowid
}

export function getInstanceBySlug(slug) {
  return db.prepare('SELECT * FROM instances WHERE slug = ?').get(slug) ?? null
}

export function getInstanceByHostPort(hostPort) {
  return db.prepare('SELECT * FROM instances WHERE host_port = ?').get(hostPort) ?? null
}

export function getInstanceByUserId(userId) {
  return db.prepare('SELECT * FROM instances WHERE user_id = ?').get(userId) ?? null
}

export function getInstanceById(id) {
  return db.prepare('SELECT * FROM instances WHERE id = ?').get(id) ?? null
}

export function updateInstance(id, fields) {
  const keys = Object.keys(fields)
  if (keys.length === 0) return
  const sets = keys.map((k) => `${k} = @${k}`).join(', ')
  db.prepare(`UPDATE instances SET ${sets} WHERE id = @id`).run({ id, ...fields })
}

/** Preserve a deletion tombstone across concurrent start/stop/provision work. */
export function updateInstanceUnlessDeleting(id, fields) {
  const keys = Object.keys(fields)
  if (keys.length === 0) return false
  const sets = keys.map((k) => `${k} = @${k}`).join(', ')
  return db.prepare(
    `UPDATE instances SET ${sets} WHERE id = @id AND status <> 'deleting'`,
  ).run({ id, ...fields }).changes === 1
}

export function deleteInstance(id) {
  db.prepare('DELETE FROM instances WHERE id = ?').run(id)
}

export function deleteUser(id) {
  db.prepare('DELETE FROM instances WHERE user_id = ?').run(id)
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id)
  db.prepare('DELETE FROM personal_usage_checkpoints WHERE user_id = ?').run(id)
  db.prepare('DELETE FROM personal_usage_records WHERE user_id = ?').run(id)
  db.prepare('DELETE FROM users WHERE id = ?').run(id)
}

export function listInstancesWithUsers() {
  return db.prepare(
    `SELECT i.*, u.email, u.username, u.name AS user_name, u.role AS user_role
     FROM instances i JOIN users u ON u.id = i.user_id
     ORDER BY i.id`,
  ).all()
}

export function touchInstanceRequest(slug) {
  db.prepare(
    `UPDATE instances SET request_count = request_count + 1, last_active = ?
     WHERE slug = ?`,
  ).run(Date.now(), slug)
}

// ---- sessions ----

export function insertSession(token, userId, csrfToken) {
  const now = Date.now()
  db.prepare(`INSERT INTO sessions
      (token_hash, user_id, csrf_token, created_at, last_seen_at, absolute_expires_at)
      VALUES (?,?,?,?,?,?)`)
    .run(digestSessionToken(token), userId, csrfToken, now, now, now + config.sessionAbsoluteTtlMs)
}

export function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digestSessionToken(token))
}

export function deleteAllSessionsForUser(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
}

export function purgeExpiredSessions(now = Date.now()) {
  db.prepare('DELETE FROM sessions WHERE absolute_expires_at <= ? OR last_seen_at + ? <= ?')
    .run(now, config.sessionIdleTtlMs, now)
}

export function sessionForToken(token, { touch = true } = {}) {
  if (!/^[a-f0-9]{64}$/.test(String(token ?? ''))) return null
  const tokenHash = digestSessionToken(token)
  const row = db.prepare(
    `SELECT u.*, s.csrf_token AS _csrf_token, s.last_seen_at AS _last_seen_at,
            s.absolute_expires_at AS _absolute_expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
  ).get(tokenHash)
  if (!row) return null

  const now = Date.now()
  if (row._absolute_expires_at <= now || row._last_seen_at + config.sessionIdleTtlMs <= now) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash)
    return null
  }
  if (touch && row._last_seen_at + config.sessionTouchIntervalMs <= now) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(now, tokenHash)
  }
  const {
    _csrf_token: csrfToken, _last_seen_at: _lastSeenAt,
    _absolute_expires_at: _absoluteExpiresAt, ...user
  } = row
  return { user, csrfToken }
}

export function userForSession(token, options) {
  return sessionForToken(token, options)?.user ?? null
}

// ---- seed admin ----

export function ensureAdmin() {
  const existing = db.prepare("SELECT * FROM users WHERE role = 'admin' LIMIT 1").get()
  if (existing) return

  const password = String(config.adminPassword ?? '')
  const placeholder = /^(?:change-?me(?:-?now)?|password|admin|example)$/i.test(password)
  if (!/^[a-z0-9._-]{3,32}$/i.test(config.adminName) || password.length < 16 || Buffer.byteLength(password) > 72 || placeholder) {
    throw new Error('no admin exists: set ADMIN_NAME (3-32 account characters) and ADMIN_PASSWORD (16+ characters, at most 72 bytes)')
  }
  createUser({
    email: null,
    username: config.adminName.toLowerCase(),
    name: config.adminName,
    passwordHash: bcrypt.hashSync(password, 10),
    role: 'admin',
  })
  console.log(`[portal] seeded admin "${config.adminName}"`)
}

// Preserve the old registration switch when upgrading an existing database.
export function registrationEnabled() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'registration_enabled'").get()
  return row ? row.value !== 'false' : otpRegistrationEnabled()
}
