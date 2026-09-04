/* Gateway analytics: every card, chart and export uses one filtered snapshot. */
let usageData = null
let usageRequest = 0
let usageChartType = 'line'
let usagePage = 0
const usageCharts = new Map()
const usageColors = ['#7199ff', '#36d6ad', '#c29aff', '#f4ba68', '#55c8e5', '#f38aa8', '#8fa2bb']
const usageEl = (id) => document.getElementById(id)
const shortUsage = (n) => Math.abs(n) >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n)
const usageDay = (ms) => new Date(ms).toISOString().slice(0, 10)
const shanghaiToday = () => usageDay(Date.now() + 8 * 3600000)
const usageGrains = { hour: '小时', day: '日', week: '周', month: '月' }

function usagePreset(range) {
  const today = shanghaiToday(), ms = Date.parse(today), d = new Date(ms)
  let from = today, to = today
  if (range === 'yesterday') from = to = usageDay(ms - 86400000)
  else if (range === 'week') from = usageDay(ms - ((d.getUTCDay() + 6) % 7) * 86400000)
  else if (range === 'month') from = today.slice(0, 7) + '-01'
  else if (range === 'year') from = today.slice(0, 4) + '-01-01'
  else if (/^\d+$/.test(range)) from = usageDay(ms - (Number(range) - 1) * 86400000)
  const form = usageEl('gateway-usage-filter')
  form.elements.from.value = from; form.elements.to.value = to
  form.elements.grain.value = 'auto'
  document.querySelectorAll('[data-range]').forEach((button) => {
    button.classList.toggle('active', button.dataset.range === range)
    button.setAttribute('aria-pressed', String(button.dataset.range === range))
  })
}

async function renderGatewayUsage() {
  const sequence = ++usageRequest, form = usageEl('gateway-usage-filter')
  if (!form.elements.from.value) usagePreset('30')
  const params = new URLSearchParams(new FormData(form))
  usageEl('usage-query-status').textContent = '正在更新用量…'
  usageEl('usage-dashboard').setAttribute('aria-busy', 'true')
  usageEl('usage-export').disabled = true
  try {
    const data = await api(`/api/admin/gateway/analytics?${params}`)
    if (sequence !== usageRequest) return
    usageData = data; usagePage = 0
    for (const [field, items, label] of [['userId', data.options.users, '全部用户'], ['modelId', data.options.models, '全部模型']]) {
      const select = form.elements[field], value = select.value
      select.innerHTML = `<option value="">${label}</option>` + items.map((item) => `<option value="${escapeHtml(String(item.id))}">${escapeHtml(item.name)}</option>`).join('')
      if (value && !items.some((item) => String(item.id) === value)) select.add(new Option(`未找到：${value}`, value))
      select.value = value
    }
    usageEl('usage-dashboard').classList.remove('hidden')
    usageEl('usage-query-status').textContent = `${data.from} — ${data.to} · 北京时间 · 按${usageGrains[data.grain]}汇总 · ${data.summary.requests ? '数据已更新' : '所选范围暂无模型调用'} · ${new Date(data.generatedAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`
    drawUsageDashboard()
    usageEl('usage-export').disabled = data.rows.length === 0
  } catch (error) {
    if (sequence !== usageRequest) return
    usageData = null
    usageEl('usage-dashboard').classList.add('hidden')
    usageEl('usage-query-status').textContent = `统计加载失败：${error.message} 请调整筛选或重新查询。`
  } finally {
    if (sequence === usageRequest) usageEl('usage-dashboard').setAttribute('aria-busy', 'false')
  }
}

function usageChange(current, previous) {
  return previous ? `${current >= previous ? '↑' : '↓'} ${Math.abs((current - previous) / previous * 100).toFixed(1)}%` : current ? '上期无用量' : '与上期持平'
}

function usageChart(id, option, hasData = true) {
  if (!window.echarts) {
    usageEl(id).textContent = '图表组件加载失败，请刷新页面；下方明细仍可查看。'
    return null
  }
  let chart = usageCharts.get(id)
  if (!chart) {
    chart = echarts.init(usageEl(id), null, { renderer: 'canvas' })
    usageCharts.set(id, chart)
    new ResizeObserver(() => { if (usageEl(id).clientWidth) chart.resize() }).observe(usageEl(id))
  }
  const base = { animation: false, color: usageColors, backgroundColor: 'transparent',
    textStyle: { color: '#aab8ce', fontFamily: 'system-ui, sans-serif' }, aria: { enabled: true },
    tooltip: { trigger: 'axis', renderMode: 'richText', confine: true, backgroundColor: '#202a40', borderColor: '#3a4962', textStyle: { color: '#f0f4fc' } },
    legend: { top: 0, type: 'scroll', textStyle: { color: '#b8c6dc' }, inactiveColor: '#48556b' },
    grid: { left: 12, right: 20, top: 42, bottom: 24, containLabel: true } }
  chart.setOption(hasData ? { ...base, ...option } : { ...base, series: [], graphic: { type: 'text', left: 'center', top: 'middle', style: { text: '暂无符合条件的用量', fill: '#8e9bb2', fontSize: 14 } } }, true)
  return chart
}
const usageAxis = (type, data) => ({ type, ...(data ? { data } : {}), axisLine: { lineStyle: { color: '#34405a' } },
  axisTick: { show: false }, axisLabel: { color: '#91a1bb', ...(type === 'value' ? { formatter: shortUsage } : {}) },
  splitLine: { show: type === 'value', lineStyle: { color: '#252f44', type: 'dashed' } } })
const usagePeriodLabel = (period) => usageData.grain === 'hour' ? (usageData.days === 1 ? period.slice(11) : period.slice(5)) : usageData.grain === 'month' ? period.slice(0, 7) : period.slice(5)
const usageZoom = (count) => count > 40 ? [{ type: 'inside' }, { type: 'slider', bottom: 0, height: 15, borderColor: '#34405a', textStyle: { color: '#91a1bb' } }] : []

function drawUsageTrend() {
  if (!usageData) return
  const d = usageData, metric = usageEl('usage-metric').value, dimension = usageEl('usage-dimension').value
  const periods = d.trend.map((r) => r.period)
  let series
  if (dimension === 'total') {
    const fields = metric === 'actualTokens' ? [['inputTokens', '输入 Token'], ['outputTokens', '输出 Token']]
      : metric === 'chargedTokens' ? [['actualTokens', '实际用量'], ['uncertainTokens', '待核实扣减']] : [['requests', '请求次数']]
    series = fields.map(([field, name]) => ({ name, data: d.trend.map((r) => r[field]) }))
  } else {
    const groups = [...(dimension === 'user' ? d.users : d.models)].sort((a, b) => b[metric] - a[metric])
    const top = groups.slice(0, 5), keys = new Set(top.map((g) => g.id)), by = dimension === 'user' ? 'userId' : 'modelId'
    const maps = new Map(top.map((g) => [g.id, new Map()]))
    const rest = new Map()
    for (const row of d.rows) {
      const map = keys.has(row[by]) ? maps.get(row[by]) : rest
      map.set(row.period, (map.get(row.period) ?? 0) + row[metric])
    }
    series = top.map((g) => ({ name: `${g.name}${dimension === 'user' ? ` #${g.id}` : ''}`, data: periods.map((p) => maps.get(g.id).get(p) ?? 0) }))
    if (groups.length > 5) series.push({ name: '其他（合计）', data: periods.map((p) => rest.get(p) ?? 0) })
  }
  usageEl('usage-trend-note').textContent = `${dimension === 'total' ? '同一筛选口径，输入与输出分开展示' : '展示消耗前 5 位，其余合并为“其他”'} · 周从周一开始，首尾仅计所选日期 · 点击图例可显隐`
  usageChart('usage-trend', { xAxis: usageAxis('category', periods.map(usagePeriodLabel)), yAxis: { ...usageAxis('value'), min: 0, minInterval: 1 },
    aria: { enabled: true, description: `所选范围内按${usageGrains[d.grain]}展示的${metric === 'requests' ? '请求次数' : 'Token'}趋势。` },
    dataZoom: usageZoom(periods.length), grid: { left: 12, right: 20, top: 45, bottom: periods.length > 40 ? 42 : 24, containLabel: true },
    series: series.map((s) => ({ ...s, type: usageChartType, ...(usageChartType === 'bar' ? { stack: 'usage', barMaxWidth: 32 } : { showSymbol: periods.length <= 31, symbolSize: 5, lineStyle: { width: 2.5 }, areaStyle: { opacity: 0.06 } }) })) }, d.summary.requests > 0)
}

function drawUsageDashboard() {
  const d = usageData, s = d.summary, p = d.previous
  const cards = [
    ['实际 Token', exactTokens(s.actualTokens), `输入 ${exactTokens(s.inputTokens)} · 输出 ${exactTokens(s.outputTokens)}`, usageChange(s.actualTokens, p.actualTokens)],
    ['模型请求', exactTokens(s.requests), `平台 ${exactTokens(s.platformRequests)} · 个人 ${exactTokens(s.personalRequests)}`, usageChange(s.requests, p.requests)],
    ['调用用户', exactTokens(s.activeUsers), `使用 ${s.activeModels} 个模型`, '按当前筛选范围统计'],
    ['日均实际 Token', exactTokens(Math.round(s.dailyAverage)), `覆盖 ${d.days} 天，包含无调用日期`, `对比区间 ${p.from} — ${p.to}`],
  ]
  usageEl('usage-kpis').innerHTML = cards.map(([label, value, detail, comparison], i) => `<article class="usage-kpi ${i === 0 ? 'usage-kpi-primary' : ''}"><span>${label}</span><strong title="${value}">${value}</strong><small>${detail}</small><div class="usage-comparison">${comparison}</div></article>`).join('')
  usageEl('usage-accounting').innerHTML = `<span>个人模型 <b>${exactTokens(s.personalActualTokens)}</b> Token · ${s.personalRequests} 次</span><span>平台额度已扣减 <b>${exactTokens(s.chargedTokens)}</b></span><span class="usage-warning">其中待核实 <b>${exactTokens(s.uncertainTokens)}</b> · ${s.uncertainRequests} 次</span><span>进行中预留 <b>${exactTokens(s.reservedTokens)}</b> · ${s.pendingRequests} 次</span><span>对比使用上个等长日期区间，今日为截至当前的用量。</span>`
  drawUsageTrend()
  const ranking = d.users.filter((u) => u.actualTokens > 0).slice(0, 10)
  const userChart = usageChart('usage-users-chart', { legend: { show: false }, grid: { top: 12, left: 12, right: 62, bottom: 20, containLabel: true },
    xAxis: usageAxis('value'), yAxis: { ...usageAxis('category', ranking.map((u) => u.name)), inverse: true, axisLabel: { color: '#b8c6dc', width: 105, overflow: 'truncate' } },
    series: [{ name: '实际 Token', type: 'bar', barMaxWidth: 24, data: ranking.map((u) => ({ value: u.actualTokens, userId: u.id })), itemStyle: { borderRadius: [0, 4, 4, 0] }, label: { show: true, position: 'right', color: '#cbd7ea', formatter: (p) => shortUsage(p.value) } }] }, ranking.length > 0)
  userChart?.off('click'); userChart?.on('click', (event) => { usageEl('gateway-usage-filter').elements.userId.value = String(event.data.userId); renderGatewayUsage() })
  const modelChart = usageChart('usage-models-chart', { tooltip: { trigger: 'item', renderMode: 'richText', confine: true, formatter: (p) => `${p.name}\n${exactTokens(p.value)} Token · ${p.percent}%` },
    legend: { bottom: 0, top: 'auto', type: 'scroll', textStyle: { color: '#b8c6dc' } },
    series: [{ type: 'pie', radius: ['43%', '68%'], center: ['50%', '43%'], avoidLabelOverlap: true,
      label: { color: '#b8c6dc', formatter: '{d}%' }, labelLine: { length: 10 },
      data: d.models.filter((m) => m.actualTokens > 0).map((m) => ({ name: m.name, value: m.actualTokens, modelId: m.id })) }] }, s.actualTokens > 0)
  modelChart?.off('click'); modelChart?.on('click', (event) => { usageEl('gateway-usage-filter').elements.modelId.value = event.data.modelId; renderGatewayUsage() })
  const heat = new Map(d.heatmap.map((r) => [`${r.weekday}-${r.hour}`, r.actualTokens]))
  usageChart('usage-heatmap', { grid: { left: 42, right: 12, top: 10, bottom: 68 }, legend: { show: false },
    xAxis: usageAxis('category', Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`)),
    yAxis: { ...usageAxis('category', ['周一', '周二', '周三', '周四', '周五', '周六', '周日']), inverse: true },
    visualMap: { min: 0, max: Math.max(1, ...d.heatmap.map((r) => r.actualTokens)), calculable: false, orient: 'horizontal', bottom: 0, left: 'center', inRange: { color: ['#202b43', '#3e65b3', '#739bff', '#8ce8d0'] }, text: ['高', '低'], textStyle: { color: '#91a1bb' } },
    tooltip: { position: 'top', renderMode: 'richText', confine: true, formatter: (p) => `${['周一', '周二', '周三', '周四', '周五', '周六', '周日'][p.value[1]]} ${String(p.value[0]).padStart(2, '0')}:00\n${exactTokens(p.value[2])} Token` },
    series: [{ type: 'heatmap', data: Array.from({ length: 168 }, (_, i) => [i % 24, Math.floor(i / 24), heat.get(`${Math.floor(i / 24)}-${i % 24}`) ?? 0]), itemStyle: { borderWidth: 2, borderColor: '#151e2e', borderRadius: 3 }, emphasis: { itemStyle: { borderColor: '#d6e8ff' } } }] }, s.requests > 0)
  usageChart('usage-requests-chart', { xAxis: usageAxis('category', d.trend.map((r) => usagePeriodLabel(r.period))), yAxis: { ...usageAxis('value'), minInterval: 1 }, dataZoom: usageZoom(d.trend.length),
    aria: { enabled: true, description: '按时间展示已收到用量、明确失败、待核实和进行中的请求数量。' },
    grid: { left: 12, right: 12, top: 42, bottom: d.trend.length > 40 ? 42 : 24, containLabel: true },
    series: [['completedRequests', '已收到用量', '#36d6ad'], ['failedRequests', '明确失败', '#f38aa8'], ['uncertainRequests', '待核实', '#f4ba68'], ['pendingRequests', '进行中', '#7199ff']].map(([key, name, color]) => ({ name, type: 'bar', stack: 'requests', barMaxWidth: 30, itemStyle: { color }, data: d.trend.map((r) => r[key]) })) }, s.requests > 0)
  drawUsageTable()
}

function usageTableRows() {
  const mode = usageEl('usage-table-mode').value, d = usageData
  const source = mode === 'user' ? d.users : mode === 'model' ? d.models : mode === 'period' ? d.trend : d.rows
  return source.map((r) => [mode === 'user' || mode === 'model' ? r.name : r.period,
    ...(mode === 'detail' ? [r.username, r.modelName, r.source === 'personal' ? '个人模型' : '平台模型'] : []), r.inputTokens, r.outputTokens, r.actualTokens, r.chargedTokens, r.reservedTokens, r.requests, r.failedRequests, r.uncertainRequests])
}
function usageTableHeaders() {
  const mode = usageEl('usage-table-mode').value
  return [mode === 'user' ? '用户' : mode === 'model' ? '模型' : '时间', ...(mode === 'detail' ? ['用户', '模型', '来源'] : []), '输入 Token', '输出 Token', '实际 Token', '额度扣减', '进行中预留', '请求', '明确失败', '待核实']
}
function drawUsageTable() {
  if (!usageData) return
  const rows = usageTableRows(), start = usagePage * 20, page = rows.slice(start, start + 20)
  usageEl('gateway-usage').innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr>${usageTableHeaders().map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${page.map((row) => `<tr>${row.map((value) => `<td>${typeof value === 'number' ? exactTokens(value) : escapeHtml(value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<p class="empty">暂无符合条件的明细，请调整日期、用户或模型。</p>'
  usageEl('usage-pagination').innerHTML = `<span>共 ${rows.length} 行 · 第 ${usagePage + 1} / ${Math.max(1, Math.ceil(rows.length / 20))} 页</span><button class="btn btn-ghost btn-sm" data-usage-page="-1" ${usagePage === 0 ? 'disabled' : ''}>上一页</button><button class="btn btn-ghost btn-sm" data-usage-page="1" ${start + 20 >= rows.length ? 'disabled' : ''}>下一页</button>`
}

function exportUsage() {
  if (!usageData) return
  // Always export the complete current table, never just its visible page.
  const cell = (value) => `"${String(typeof value === 'string' && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value).replaceAll('"', '""')}"`
  const text = '\uFEFF' + [usageTableHeaders(), ...usageTableRows()].map((row) => row.map(cell).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a'); link.href = url; link.download = `token-usage-${usageData.from}-${usageData.to}-${usageEl('usage-table-mode').value}.csv`; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

for (const view of ['analytics', 'config']) usageEl(`gateway-${view}-tab`).addEventListener('click', () => {
  for (const name of ['analytics', 'config']) {
    usageEl(`gateway-${name}-view`).classList.toggle('hidden', name !== view)
    usageEl(`gateway-${name}-tab`).classList.toggle('active', name === view)
    usageEl(`gateway-${name}-tab`).setAttribute('aria-selected', String(name === view))
  }
  if (view === 'analytics') for (const chart of usageCharts.values()) chart.resize()
})
document.querySelectorAll('[data-range]').forEach((b) => b.addEventListener('click', () => { usagePreset(b.dataset.range); renderGatewayUsage() }))
usageEl('gateway-usage-filter').addEventListener('change', (event) => {
  if (['from', 'to'].includes(event.target.name)) document.querySelectorAll('[data-range]').forEach((b) => { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false') })
  if (usageEl('gateway-usage-filter').reportValidity()) renderGatewayUsage()
})
usageEl('usage-reset').addEventListener('click', () => { usageEl('gateway-usage-filter').reset(); usagePreset('30'); renderGatewayUsage() })
for (const id of ['usage-metric', 'usage-dimension']) usageEl(id).addEventListener('change', drawUsageTrend)
document.querySelectorAll('[data-chart-type]').forEach((b) => b.addEventListener('click', () => {
  usageChartType = b.dataset.chartType
  document.querySelectorAll('[data-chart-type]').forEach((button) => { button.classList.toggle('active', button === b); button.setAttribute('aria-pressed', String(button === b)) })
  drawUsageTrend()
}))
usageEl('usage-table-mode').addEventListener('change', () => { usagePage = 0; drawUsageTable() })
usageEl('usage-pagination').addEventListener('click', (e) => { const b = e.target.closest('[data-usage-page]'); if (b) { usagePage += Number(b.dataset.usagePage); drawUsageTable() } })
usageEl('usage-export').addEventListener('click', exportUsage)
