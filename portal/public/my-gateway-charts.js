/* Personal gateway analytics. The API already scopes every result to the signed-in user. */
let myUsageData = null
let myUsageRequest = 0
let myUsageChartType = 'line'
let myUsagePage = 0
const myUsageCharts = new Map()
const myUsageEl = (id) => document.getElementById(id)
const myUsageColors = ['#7199ff', '#36d6ad', '#c29aff', '#f4ba68', '#55c8e5', '#f38aa8']
const myShortUsage = (n) => Math.abs(n) >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n)
const myUsageDay = (ms) => new Date(ms).toISOString().slice(0, 10)
const myShanghaiToday = () => myUsageDay(Date.now() + 8 * 3600000)
const myUsageGrains = { hour: '小时', day: '日', week: '周', month: '月' }

function myUsagePreset(range) {
  const today = myShanghaiToday(), ms = Date.parse(today), d = new Date(ms)
  let from = today, to = today
  if (range === 'yesterday') from = to = myUsageDay(ms - 86400000)
  else if (range === 'week') from = myUsageDay(ms - ((d.getUTCDay() + 6) % 7) * 86400000)
  else if (range === 'month') from = today.slice(0, 7) + '-01'
  else if (range === 'year') from = today.slice(0, 4) + '-01-01'
  else if (/^\d+$/.test(range)) from = myUsageDay(ms - (Number(range) - 1) * 86400000)
  const form = myUsageEl('my-gateway-usage-filter')
  form.elements.from.value = from; form.elements.to.value = to; form.elements.grain.value = 'auto'
  document.querySelectorAll('[data-my-range]').forEach((button) => {
    button.classList.toggle('active', button.dataset.myRange === range)
    button.setAttribute('aria-pressed', String(button.dataset.myRange === range))
  })
}

function myUsageChange(current, previous) {
  return previous ? `${current >= previous ? '↑' : '↓'} ${Math.abs((current - previous) / previous * 100).toFixed(1)}%` : current ? '上期无用量' : '与上期持平'
}

function myUsageChart(id, option, hasData = true) {
  const target = myUsageEl(id)
  if (!window.echarts) { target.textContent = '图表组件加载失败，请刷新页面；下方明细仍可查看。'; return null }
  let chart = myUsageCharts.get(id)
  if (!chart) {
    chart = window.echarts.init(target, null, { renderer: 'canvas' })
    myUsageCharts.set(id, chart)
    new ResizeObserver(() => { if (target.clientWidth) chart.resize() }).observe(target)
  }
  const base = { animation: false, color: myUsageColors, backgroundColor: 'transparent',
    textStyle: { color: '#aab8ce', fontFamily: 'system-ui, sans-serif' }, aria: { enabled: true },
    tooltip: { trigger: 'axis', renderMode: 'richText', confine: true, backgroundColor: '#202a40', borderColor: '#3a4962', textStyle: { color: '#f0f4fc' } },
    legend: { top: 0, type: 'scroll', textStyle: { color: '#b8c6dc' }, inactiveColor: '#48556b' },
    grid: { left: 12, right: 20, top: 42, bottom: 24, containLabel: true } }
  chart.setOption(hasData ? { ...base, ...option } : { ...base, series: [], graphic: { type: 'text', left: 'center', top: 'middle', style: { text: '暂无符合条件的用量', fill: '#8e9bb2', fontSize: 14 } } }, true)
  return chart
}

const myUsageAxis = (type, data) => ({ type, ...(data ? { data } : {}), axisLine: { lineStyle: { color: '#34405a' } }, axisTick: { show: false }, axisLabel: { color: '#91a1bb', ...(type === 'value' ? { formatter: myShortUsage } : {}) }, splitLine: { show: type === 'value', lineStyle: { color: '#252f44', type: 'dashed' } } })
const myUsageZoom = (count) => count > 40 ? [{ type: 'inside' }, { type: 'slider', bottom: 0, height: 15, borderColor: '#34405a', textStyle: { color: '#91a1bb' } }] : []
const myUsagePeriodLabel = (period) => myUsageData.grain === 'hour' ? (myUsageData.days === 1 ? period.slice(11) : period.slice(5)) : myUsageData.grain === 'month' ? period.slice(0, 7) : period.slice(5)

function drawMyUsageTrend() {
  if (!myUsageData) return
  const data = myUsageData, metric = myUsageEl('my-usage-metric').value, periods = data.trend.map((row) => row.period)
  const fields = metric === 'actualTokens' ? [['inputTokens', '输入 Token'], ['outputTokens', '输出 Token']]
    : metric === 'chargedTokens' ? [['actualTokens', '实际用量'], ['uncertainTokens', '待核实扣减']]
      : [['requests', '请求次数']]
  myUsageEl('my-usage-trend-note').textContent = `${metric === 'requests' ? '按请求次数' : '同一筛选口径，输入与输出分开展示'} · 周从周一开始，首尾仅计所选日期 · 点击图例可显隐`
  myUsageChart('my-usage-trend', { xAxis: myUsageAxis('category', periods.map(myUsagePeriodLabel)), yAxis: { ...myUsageAxis('value'), min: 0, minInterval: 1 }, dataZoom: myUsageZoom(periods.length), grid: { left: 12, right: 20, top: 45, bottom: periods.length > 40 ? 42 : 24, containLabel: true }, series: fields.map(([field, name]) => ({ name, type: myUsageChartType, data: data.trend.map((row) => row[field]), ...(myUsageChartType === 'bar' ? { stack: 'my-usage', barMaxWidth: 32 } : { showSymbol: periods.length <= 31, symbolSize: 5, lineStyle: { width: 2.5 }, areaStyle: { opacity: 0.06 } }) })) }, data.summary.requests > 0)
}

function myUsageTableRows() {
  const mode = myUsageEl('my-usage-table-mode').value, data = myUsageData
  const source = mode === 'model' ? data.models : mode === 'period' ? data.trend : data.rows
  return source.map((row) => [mode === 'model' ? row.name : row.period, ...(mode === 'detail' ? [row.modelName, row.source === 'personal' ? '个人模型' : '平台模型'] : []), row.inputTokens, row.outputTokens, row.actualTokens, row.chargedTokens, row.reservedTokens, row.requests, row.failedRequests, row.uncertainRequests])
}

function myUsageTableHeaders() {
  const mode = myUsageEl('my-usage-table-mode').value
  return [mode === 'model' ? '模型' : '时间', ...(mode === 'detail' ? ['模型', '来源'] : []), '输入 Token', '输出 Token', '实际 Token', '额度扣减', '进行中预留', '请求', '明确失败', '待核实']
}

function drawMyUsageTable() {
  if (!myUsageData) return
  const rows = myUsageTableRows(), start = myUsagePage * 20, page = rows.slice(start, start + 20)
  myUsageEl('my-gateway-usage').innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr>${myUsageTableHeaders().map((head) => `<th>${head}</th>`).join('')}</tr></thead><tbody>${page.map((row) => `<tr>${row.map((value) => `<td>${typeof value === 'number' ? exactTokens(value) : escapeHtml(value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<p class="empty">暂无符合条件的明细，请调整日期或模型。</p>'
  myUsageEl('my-usage-pagination').innerHTML = `<span>共 ${rows.length} 行 · 第 ${myUsagePage + 1} / ${Math.max(1, Math.ceil(rows.length / 20))} 页</span><button class="btn btn-ghost btn-sm" data-my-usage-page="-1" ${myUsagePage === 0 ? 'disabled' : ''}>上一页</button><button class="btn btn-ghost btn-sm" data-my-usage-page="1" ${start + 20 >= rows.length ? 'disabled' : ''}>下一页</button>`
}

function drawMyUsageDashboard() {
  const data = myUsageData, summary = data.summary, previous = data.previous
  const cards = [
    ['实际 Token', exactTokens(summary.actualTokens), `输入 ${exactTokens(summary.inputTokens)} · 输出 ${exactTokens(summary.outputTokens)}`, myUsageChange(summary.actualTokens, previous.actualTokens)],
    ['模型请求', exactTokens(summary.requests), `平台 ${exactTokens(summary.platformRequests)} · 个人 ${exactTokens(summary.personalRequests)}`, myUsageChange(summary.requests, previous.requests)],
    ['使用模型', exactTokens(summary.activeModels), `已选范围内 ${summary.requests} 次模型请求`, '平台与个人模型'],
    ['日均实际 Token', exactTokens(Math.round(summary.dailyAverage)), `覆盖 ${data.days} 天，包含无调用日期`, `对比区间 ${previous.from} — ${previous.to}`],
  ]
  myUsageEl('my-usage-kpis').innerHTML = cards.map(([label, value, detail, comparison], index) => `<article class="usage-kpi ${index === 0 ? 'usage-kpi-primary' : ''}"><span>${label}</span><strong title="${value}">${value}</strong><small>${detail}</small><div class="usage-comparison">${comparison}</div></article>`).join('')
  myUsageEl('my-usage-accounting').innerHTML = `<span>个人模型 <b>${exactTokens(summary.personalActualTokens)}</b> Token · ${summary.personalRequests} 次</span><span>平台额度已扣减 <b>${exactTokens(summary.chargedTokens)}</b></span><span class="usage-warning">其中待核实 <b>${exactTokens(summary.uncertainTokens)}</b> · ${summary.uncertainRequests} 次</span><span>进行中预留 <b>${exactTokens(summary.reservedTokens)}</b> · ${summary.pendingRequests} 次</span><span>对比使用上个等长日期区间。</span>`
  drawMyUsageTrend()
  const modelChart = myUsageChart('my-usage-models-chart', { tooltip: { trigger: 'item', renderMode: 'richText', confine: true, formatter: (p) => `${p.name}\n${exactTokens(p.value)} Token · ${p.percent}%` }, legend: { bottom: 0, top: 'auto', type: 'scroll', textStyle: { color: '#b8c6dc' } }, series: [{ type: 'pie', radius: ['43%', '68%'], center: ['50%', '43%'], label: { color: '#b8c6dc', formatter: '{d}%' }, labelLine: { length: 10 }, data: data.models.filter((model) => model.actualTokens > 0).map((model) => ({ name: model.name, value: model.actualTokens, modelId: model.id })) }] }, summary.actualTokens > 0)
  modelChart?.off('click'); modelChart?.on('click', (event) => { myUsageEl('my-gateway-usage-filter').elements.modelId.value = event.data.modelId; renderMyGatewayUsage() })
  const heat = new Map(data.heatmap.map((row) => [`${row.weekday}-${row.hour}`, row.actualTokens]))
  myUsageChart('my-usage-heatmap', { grid: { left: 42, right: 12, top: 10, bottom: 68 }, legend: { show: false }, xAxis: myUsageAxis('category', Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`)), yAxis: { ...myUsageAxis('category', ['周一', '周二', '周三', '周四', '周五', '周六', '周日']), inverse: true }, visualMap: { min: 0, max: Math.max(1, ...data.heatmap.map((row) => row.actualTokens)), calculable: false, orient: 'horizontal', bottom: 0, left: 'center', inRange: { color: ['#202b43', '#3e65b3', '#739bff', '#8ce8d0'] }, text: ['高', '低'], textStyle: { color: '#91a1bb' } }, tooltip: { position: 'top', renderMode: 'richText', confine: true, formatter: (p) => `${['周一', '周二', '周三', '周四', '周五', '周六', '周日'][p.value[1]]} ${String(p.value[0]).padStart(2, '0')}:00\n${exactTokens(p.value[2])} Token` }, series: [{ type: 'heatmap', data: Array.from({ length: 168 }, (_, i) => [i % 24, Math.floor(i / 24), heat.get(`${Math.floor(i / 24)}-${i % 24}`) ?? 0]), itemStyle: { borderWidth: 2, borderColor: '#151e2e', borderRadius: 3 }, emphasis: { itemStyle: { borderColor: '#d6e8ff' } } }] }, summary.requests > 0)
  myUsageChart('my-usage-requests-chart', { xAxis: myUsageAxis('category', data.trend.map((row) => myUsagePeriodLabel(row.period))), yAxis: { ...myUsageAxis('value'), minInterval: 1 }, dataZoom: myUsageZoom(data.trend.length), grid: { left: 12, right: 12, top: 42, bottom: data.trend.length > 40 ? 42 : 24, containLabel: true }, series: [['completedRequests', '已收到用量', '#36d6ad'], ['failedRequests', '明确失败', '#f38aa8'], ['uncertainRequests', '待核实', '#f4ba68'], ['pendingRequests', '进行中', '#7199ff']].map(([key, name, color]) => ({ name, type: 'bar', stack: 'requests', barMaxWidth: 30, itemStyle: { color }, data: data.trend.map((row) => row[key]) })) }, summary.requests > 0)
  drawMyUsageTable()
}

async function renderMyGatewayUsage() {
  const sequence = ++myUsageRequest, form = myUsageEl('my-gateway-usage-filter')
  if (!form.elements.from.value) myUsagePreset('30')
  const params = new URLSearchParams(new FormData(form))
  myUsageEl('my-usage-query-status').textContent = '正在更新我的用量…'
  myUsageEl('my-usage-dashboard').setAttribute('aria-busy', 'true'); myUsageEl('my-usage-export').disabled = true
  try {
    const data = await api(`/api/gateway/analytics?${params}`)
    if (sequence !== myUsageRequest) return
    myUsageData = data; myUsagePage = 0
    const select = form.elements.modelId, value = select.value
    select.innerHTML = '<option value="">全部模型</option>' + data.options.models.map((model) => `<option value="${escapeHtml(String(model.id))}">${escapeHtml(model.name)}</option>`).join('')
    if (value && !data.options.models.some((model) => String(model.id) === value)) select.add(new Option(`未找到：${value}`, value))
    select.value = value
    myUsageEl('my-usage-dashboard').classList.remove('hidden')
    const sync = data.personalSync?.status === 'ok' && data.personalSync.added
      ? ` · 已同步 ${data.personalSync.added} 条个人模型用量`
      : data.personalSync?.status === 'unavailable' ? ' · 个人模型记录将在工作空间运行后同步' : ''
    myUsageEl('my-usage-query-status').textContent = `${data.from} — ${data.to} · 北京时间 · 按${myUsageGrains[data.grain]}汇总 · ${data.summary.requests ? '数据已更新' : '所选范围暂无模型调用'}${sync} · ${new Date(data.generatedAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`
    drawMyUsageDashboard(); myUsageEl('my-usage-export').disabled = data.rows.length === 0
  } catch (error) {
    if (sequence !== myUsageRequest) return
    myUsageData = null; myUsageEl('my-usage-dashboard').classList.add('hidden')
    myUsageEl('my-usage-query-status').textContent = `统计加载失败：${error.message} 请调整筛选或重新查询。`
  } finally { if (sequence === myUsageRequest) myUsageEl('my-usage-dashboard').setAttribute('aria-busy', 'false') }
}

function exportMyUsage() {
  if (!myUsageData) return
  const cell = (value) => `"${String(typeof value === 'string' && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value).replaceAll('"', '""')}"`
  const text = '\uFEFF' + [myUsageTableHeaders(), ...myUsageTableRows()].map((row) => row.map(cell).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a'); link.href = url; link.download = `my-token-usage-${myUsageData.from}-${myUsageData.to}-${myUsageEl('my-usage-table-mode').value}.csv`; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

document.querySelectorAll('[data-my-range]').forEach((button) => button.addEventListener('click', () => { myUsagePreset(button.dataset.myRange); renderMyGatewayUsage() }))
myUsageEl('my-gateway-usage-filter').addEventListener('submit', (event) => { event.preventDefault(); renderMyGatewayUsage() })
myUsageEl('my-gateway-usage-filter').addEventListener('change', (event) => {
  if (['from', 'to'].includes(event.target.name)) document.querySelectorAll('[data-my-range]').forEach((button) => { button.classList.remove('active'); button.setAttribute('aria-pressed', 'false') })
  if (myUsageEl('my-gateway-usage-filter').reportValidity()) renderMyGatewayUsage()
})
myUsageEl('my-usage-reset').addEventListener('click', () => { myUsageEl('my-gateway-usage-filter').reset(); myUsagePreset('30'); renderMyGatewayUsage() })
myUsageEl('my-usage-metric').addEventListener('change', drawMyUsageTrend)
document.querySelectorAll('[data-my-chart-type]').forEach((button) => button.addEventListener('click', () => {
  myUsageChartType = button.dataset.myChartType
  document.querySelectorAll('[data-my-chart-type]').forEach((item) => { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', String(item === button)) })
  drawMyUsageTrend()
}))
myUsageEl('my-usage-table-mode').addEventListener('change', () => { myUsagePage = 0; drawMyUsageTable() })
myUsageEl('my-usage-pagination').addEventListener('click', (event) => { const button = event.target.closest('[data-my-usage-page]'); if (button) { myUsagePage += Number(button.dataset.myUsagePage); drawMyUsageTable() } })
myUsageEl('my-usage-export').addEventListener('click', exportMyUsage)
