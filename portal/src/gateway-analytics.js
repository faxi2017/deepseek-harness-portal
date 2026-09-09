import { db } from './db.js'
import { gatewayDay } from './gateway-store.js'

const DAY = 86400000
const metrics = ['inputTokens', 'outputTokens', 'actualTokens', 'chargedTokens', 'reservedTokens',
  'uncertainTokens', 'requests', 'completedRequests', 'failedRequests', 'uncertainRequests', 'pendingRequests',
  'platformActualTokens', 'personalActualTokens', 'platformRequests', 'personalRequests']
const empty = () => Object.fromEntries(metrics.map((key) => [key, 0]))
const date = (ms) => new Date(ms).toISOString().slice(0, 10)
const bucketSql = (alias, timestamp) => ({
  hour: `strftime('%Y-%m-%d %H:00',${alias}.${timestamp}/1000,'unixepoch','+8 hours')`,
  day: `${alias}.day`,
  week: `date(${alias}.day,'-' || ((CAST(strftime('%w',${alias}.day) AS INTEGER)+6)%7) || ' days')`,
  month: `substr(${alias}.day,1,7) || '-01'`,
})
const platformSums = `SUM(input_tokens) AS inputTokens,SUM(output_tokens) AS outputTokens,
  SUM(input_tokens+output_tokens) AS actualTokens,SUM(charged_tokens) AS chargedTokens,
  SUM(CASE WHEN state='pending' THEN reserved ELSE 0 END) AS reservedTokens,
  SUM(CASE WHEN state='uncertain' THEN charged_tokens ELSE 0 END) AS uncertainTokens,
  COUNT(*) AS requests,SUM(state='completed') AS completedRequests,SUM(state='failed') AS failedRequests,
  SUM(state='uncertain') AS uncertainRequests,SUM(state='pending') AS pendingRequests`
const personalSums = `SUM(input_tokens) AS inputTokens,SUM(output_tokens) AS outputTokens,
  SUM(input_tokens+output_tokens) AS actualTokens,0 AS chargedTokens,0 AS reservedTokens,0 AS uncertainTokens,
  COUNT(*) AS requests,COUNT(*) AS completedRequests,0 AS failedRequests,0 AS uncertainRequests,0 AS pendingRequests`

export function parseAnalyticsQuery(query, today = gatewayDay()) {
  const from = query.from ?? date(Date.parse(today) - 29 * DAY)
  const to = query.to ?? today
  const validDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)
    && d >= '2000-01-01' && d <= '9998-12-31' && Number.isFinite(Date.parse(d)) && date(Date.parse(d)) === d
  if (!validDate(from) || !validDate(to) || from > to || Date.parse(to) - Date.parse(from) >= 366 * DAY) throw new Error('请选择有效的日期范围，最多 366 天。')
  const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1
  const grain = query.grain === undefined || query.grain === 'auto' ? (days === 1 ? 'hour' : days > 90 ? 'week' : 'day') : query.grain
  if (!['hour', 'day', 'week', 'month'].includes(grain) || (grain === 'hour' && days > 31)) throw new Error('请选择小时、日、周或月；小时视图最多查看 31 天。')
  const userId = query.userId === undefined || query.userId === '' ? null : Number(query.userId)
  if (userId !== null && (typeof query.userId !== 'string' || !/^\d+$/.test(query.userId) || !Number.isSafeInteger(userId) || userId < 1)) throw new Error('用户筛选无效。')
  const modelId = query.modelId === undefined || query.modelId === '' ? null : query.modelId
  if (modelId !== null && (typeof modelId !== 'string' || modelId.length > 160 || !/^[a-zA-Z0-9_.-]+$/.test(modelId))) throw new Error('模型筛选无效。')
  return { from, to, days, grain, userId, modelId }
}

function bucketKey(day, grain) {
  const d = new Date(day + 'T00:00:00Z')
  if (grain === 'month') return day.slice(0, 7) + '-01'
  if (grain === 'week') return date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY)
  return day
}

function add(target, row) {
  for (const key of metrics) target[key] += row[key] ?? 0
  if (row.source === 'platform') {
    target.platformActualTokens += row.actualTokens ?? 0
    target.platformRequests += row.requests ?? 0
  } else if (row.source === 'personal') {
    target.personalActualTokens += row.actualTokens ?? 0
    target.personalRequests += row.requests ?? 0
  }
}

function mergeHeatmap(rows) {
  const merged = new Map()
  for (const row of rows) {
    const key = `${row.weekday}-${row.hour}`
    if (!merged.has(key)) merged.set(key, { weekday: row.weekday, hour: row.hour, ...empty() })
    add(merged.get(key), row)
  }
  return [...merged.values()]
}

export function gatewayAnalytics(query) {
  const filter = parseAnalyticsQuery(query)
  const { from, to, days, grain, userId, modelId } = filter
  const platformWhere = `r.day>=? AND r.day<=?${userId === null ? '' : ' AND r.user_id=?'}${modelId === null ? '' : ' AND r.model_id=?'}`
  const personalWhere = `p.day>=? AND p.day<=?${userId === null ? '' : ' AND p.user_id=?'}${modelId === null ? '' : ' AND p.model_key=?'}`
  const params = (start, end) => [start, end, ...(userId === null ? [] : [userId]), ...(modelId === null ? [] : [modelId])]
  const platformBucket = bucketSql('r', 'started_at')[grain]
  const personalBucket = bucketSql('p', 'occurred_at')[grain]
  // A read transaction keeps summary, charts and comparison on one SQLite snapshot.
  return db.transaction(() => {
    const platformRows = db.prepare(`SELECT ${platformBucket} AS period,r.user_id AS userId,
      COALESCE(u.username,'已删除用户 #' || r.user_id) AS username,r.model_id AS modelId,
      COALESCE(mr.name,r.model_id) AS modelName,${platformSums}
      FROM gateway_requests r LEFT JOIN users u ON u.id=r.user_id LEFT JOIN gateway_model_routes mr ON mr.id=r.model_id
      WHERE ${platformWhere} GROUP BY period,r.user_id,r.model_id ORDER BY period,r.user_id,r.model_id`).all(...params(from, to))
      .map((row) => ({ ...row, source: 'platform' }))
    const personalRows = db.prepare(`SELECT ${personalBucket} AS period,p.user_id AS userId,
      COALESCE(u.username,'已删除用户 #' || p.user_id) AS username,p.model_key AS modelId,
      p.provider || ' / ' || p.model_id AS modelName,${personalSums}
      FROM personal_usage_records p LEFT JOIN users u ON u.id=p.user_id
      WHERE ${personalWhere} GROUP BY period,p.user_id,p.model_key ORDER BY period,p.user_id,p.model_key`).all(...params(from, to))
      .map((row) => ({ ...row, source: 'personal' }))
    const rows = [...platformRows, ...personalRows]
    const summary = empty(), users = new Map(), models = new Map(), trend = new Map()
    for (let ms = Date.parse(from); ms <= Date.parse(to); ms += DAY) {
      const day = date(ms)
      const periods = grain === 'hour' ? Array.from({ length: 24 }, (_, h) => `${day} ${String(h).padStart(2, '0')}:00`) : [bucketKey(day, grain)]
      for (const period of periods) if (!trend.has(period)) trend.set(period, { period, ...empty() })
    }
    for (const row of rows) {
      add(summary, row)
      if (trend.has(row.period)) add(trend.get(row.period), row)
      if (!users.has(row.userId)) users.set(row.userId, { id: row.userId, name: row.username, ...empty() })
      if (!models.has(row.modelId)) models.set(row.modelId, { id: row.modelId, name: row.modelName, ...empty() })
      add(users.get(row.userId), row); add(models.get(row.modelId), row)
    }
    const previousFrom = date(Date.parse(from) - days * DAY), previousTo = date(Date.parse(from) - DAY)
    const previous = empty()
    add(previous, { ...db.prepare(`SELECT ${platformSums} FROM gateway_requests r WHERE ${platformWhere}`).get(...params(previousFrom, previousTo)), source: 'platform' })
    add(previous, { ...db.prepare(`SELECT ${personalSums} FROM personal_usage_records p WHERE ${personalWhere}`).get(...params(previousFrom, previousTo)), source: 'personal' })
    const heatmap = mergeHeatmap([
      ...db.prepare(`SELECT (CAST(strftime('%w',r.started_at/1000,'unixepoch','+8 hours') AS INTEGER)+6)%7 AS weekday,
        CAST(strftime('%H',r.started_at/1000,'unixepoch','+8 hours') AS INTEGER) AS hour,${platformSums}
        FROM gateway_requests r WHERE ${platformWhere} GROUP BY weekday,hour`).all(...params(from, to)).map((row) => ({ ...row, source: 'platform' })),
      ...db.prepare(`SELECT (CAST(strftime('%w',p.occurred_at/1000,'unixepoch','+8 hours') AS INTEGER)+6)%7 AS weekday,
        CAST(strftime('%H',p.occurred_at/1000,'unixepoch','+8 hours') AS INTEGER) AS hour,${personalSums}
        FROM personal_usage_records p WHERE ${personalWhere} GROUP BY weekday,hour`).all(...params(from, to)).map((row) => ({ ...row, source: 'personal' })),
    ])
    const options = {
      users: db.prepare(`SELECT id,COALESCE(username,'已删除用户 #' || id) AS name FROM
        (SELECT u.id,u.username FROM users u WHERE u.role<>'admin'
         UNION SELECT r.user_id,u.username FROM gateway_requests r LEFT JOIN users u ON u.id=r.user_id
         UNION SELECT p.user_id,u.username FROM personal_usage_records p LEFT JOIN users u ON u.id=p.user_id) ORDER BY name`).all(),
      models: db.prepare(`SELECT id,COALESCE(name,id) AS name FROM
        (SELECT id,name FROM gateway_model_routes WHERE enabled=1
         UNION SELECT r.model_id,mr.name FROM gateway_requests r LEFT JOIN gateway_model_routes mr ON mr.id=r.model_id
         UNION SELECT p.model_key,p.provider || ' / ' || p.model_id FROM personal_usage_records p) ORDER BY name`).all(),
    }
    return { ...filter, timezone: 'Asia/Shanghai', generatedAt: Date.now(), options, summary: { ...summary,
      activeUsers: users.size, activeModels: models.size, dailyAverage: summary.actualTokens / days },
    previous: { from: previousFrom, to: previousTo, ...previous }, trend: [...trend.values()],
    users: [...users.values()].sort((a, b) => b.actualTokens - a.actualTokens || a.id - b.id),
    models: [...models.values()].sort((a, b) => b.actualTokens - a.actualTokens || a.id.localeCompare(b.id)), heatmap, rows }
  })()
}

// The user-facing view is deliberately derived from the same filtered snapshot as
// the admin view, then strips every cross-user field before it leaves the server.
export function gatewayAnalyticsForUser(userId, query) {
  const { userId: ignoredUserId, ...filters } = query
  const analytics = gatewayAnalytics({ ...filters, userId: String(userId) })
  const { users, options, rows, ...safe } = analytics
  const models = new Map(analytics.models.map(({ id, name }) => [id, { id, name }]))
  for (const model of db.prepare(`SELECT model_key AS id,provider || ' / ' || model_id AS name
    FROM personal_usage_records WHERE user_id=? GROUP BY model_key,provider,model_id`).all(userId)) models.set(model.id, model)
  return {
    ...safe,
    options: { models: [...models.values()].sort((a, b) => a.name.localeCompare(b.name)) },
    rows: rows.map(({ userId: ignoredId, username, ...row }) => row),
  }
}
