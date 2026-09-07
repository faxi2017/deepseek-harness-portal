/* DeepSeek Harness Portal — client */
const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => [...document.querySelectorAll(sel)]

let me = null
let csrfToken = ''
let authMode = 'login' // 'login' | 'register'
let instancesCache = []
let usersCache = []
let dshReleasesCache = []
let myDshReleases = []
let myDshUpgrades = []
let myInstance = null
let cfg = { domain: '', instanceDomain: '', registrationEnabled: true, inviteCodeRequired: false }

const THEME_STORAGE_KEY = 'dsh-portal-theme'
const themeRoot = document.documentElement

function savedTheme() {
  try {
    const value = globalThis.localStorage?.getItem(THEME_STORAGE_KEY)
    return ['light', 'dark', 'system'].includes(value) ? value : 'system'
  } catch { return 'system' }
}

function systemTheme() {
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(preference) {
  const theme = ['light', 'dark', 'system'].includes(preference) ? preference : 'system'
  if (themeRoot?.dataset) {
    if (theme === 'system') {
      delete themeRoot.dataset.theme
      themeRoot.dataset.systemTheme = systemTheme()
    } else {
      themeRoot.dataset.theme = theme
      delete themeRoot.dataset.systemTheme
    }
  }
  $$('[data-theme-select]').forEach((select) => { select.value = theme })
}

function initThemePicker() {
  applyTheme(savedTheme())
  $$('[data-theme-select]').forEach((select) => select.addEventListener('change', () => {
    const preference = select.value
    try { globalThis.localStorage?.setItem(THEME_STORAGE_KEY, preference) } catch { /* theme still applies for this visit */ }
    applyTheme(preference)
  }))
  globalThis.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (savedTheme() === 'system') applyTheme('system')
  })
}

// ---- inline icons (feather-style) ----
const ICONS = {
  server: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  play: '<polygon points="5 3 19 12 5 21 5 3"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  key: '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>',
}

function icon(name, size = 16) {
  const body = ICONS[name] || ''
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
}

// inject icons into [data-icon] placeholders
function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = icon(el.dataset.icon) })
}

const ERROR_MESSAGES = {
  'not authenticated': '登录已失效，请重新登录',
  'admin only': '此操作需要管理员权限',
  'invalid request host': '访问地址不正确，请从管理平台入口重新进入',
  'invalid request origin': '请求来源不正确，请刷新页面后重试',
  'cross-site request rejected': '请求来源校验失败，请刷新页面后重试',
  'application/json required': '请求格式不正确，请刷新页面后重试',
  'invalid CSRF token': '登录验证已过期，请刷新页面或重新登录',
  'too many attempts; try again later': '操作过于频繁，请稍后重试',
  'registration is disabled': '管理员已关闭新用户注册',
  'username: 3-32 chars (letters, digits, . _ -)': '账号须为 3–32 位英文字母、数字、点、下划线或连字符',
  'password: at least 8 characters, at most 72 bytes': '密码至少 8 个字符，最长 72 字节（中文等字符会占用多个字节）',
  'password must be at least 8 characters': '密码至少 8 个字符，最长 72 字节',
  'invalid invitation code': '邀请码不正确',
  'username already taken': '该账号已被使用，请换一个账号',
  'no instance capacity available; contact admin': '暂时没有可用的实例名额，请联系管理员',
  'invalid username or password': '账号或密码不正确',
  'name must be 1-64 characters': '显示名称须为 1–64 个字符',
  'current password is incorrect': '当前密码不正确',
  'nothing to update': '没有需要保存的修改',
  'no instance': '暂未创建实例，请联系管理员',
  'instance failed; contact admin': '实例启动失败，请联系管理员',
  'instance deletion is in progress': '实例正在删除，请稍后再试',
  'instance upgrade is in progress': 'DSH 正在升级或回退，请稍后再试',
  'instance is not ready for an upgrade': '实例当前状态无法升级，请先恢复为运行中或已停止',
  'instance upgrade is already in progress': '该实例已有升级或回退任务在执行',
  'DSH release is not available for self-service': '此 DSH 版本未开放个人自助升级',
  'DSH release not found': 'DSH 版本不存在或已不可用',
  'DSH rollback snapshot not found': '找不到可用的 DSH 回退快照',
  'DSH upgrade could not be started': '无法启动 DSH 升级，请稍后重试',
  'DSH rollback could not be started': '无法启动 DSH 回退，请稍后重试',
  'DSH image build could not be started': '无法开始构建 DSH 镜像，请检查是否已有构建任务',
  'invalid DSH release settings': 'DSH 版本设置无效',
  'a default DSH release is required': '必须保留一个新用户默认 DSH 版本',
  'registrationEnabled must be boolean': '注册设置无效，请刷新页面后重新设置',
  'not found': '该用户或实例不存在，请刷新页面',
  'cannot delete an admin account': '不能删除管理员账号',
  'deletion failed; retry the operation': '删除失败，请重试',
  'instance deletion failed; data was retained': '实例删除失败，请联系管理员查看日志',
  'health check timed out': '实例启动超时，请联系管理员查看日志',
  'instance health check timed out': '实例启动超时，请稍后重试或联系管理员',
}

function errorMessage(message) {
  return ERROR_MESSAGES[message] || '操作失败，请稍后重试；如仍失败，请联系管理员查看日志'
}

async function api(path, opts = {}) {
  const method = String(opts.method ?? 'GET').toUpperCase()
  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method)
  const body = opts.body !== undefined ? JSON.stringify(opts.body) : (unsafe ? '{}' : undefined)
  const headers = { ...(opts.headers ?? {}) }
  if (unsafe) headers['content-type'] = 'application/json'
  if (unsafe && csrfToken) headers['x-csrf-token'] = csrfToken
  const { body: _body, headers: _headers, ...rest } = opts
  const res = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...rest,
    headers,
    body,
  }).catch(() => { throw new Error('无法连接服务，请检查网络和服务是否已启动') })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(errorMessage(data.error))
  return data
}

async function withButtonLoading(btn, loadingText, fn) {
  const original = btn.innerHTML
  btn.disabled = true
  btn.innerHTML = `<span class="spinner"></span> ${loadingText}`
  try { return await fn() } finally { btn.disabled = false; btn.innerHTML = original }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// ---- toasts ----
function toast(message, type = 'info') {
  const el = document.createElement('div')
  el.className = `toast ${type}`
  el.innerHTML = `${icon(type === 'ok' ? 'check' : type === 'err' ? 'alert' : 'info')}<span>${escapeHtml(message)}</span>`
  $('#toasts').appendChild(el)
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .25s'; setTimeout(() => el.remove(), 250) }, 3200)
}

// ---- modal ----
function openModal({ title, body, footer, wide = false }) {
  const root = $('#modal-root')
  root.classList.remove('hidden')
  root.innerHTML = `<div class="modal ${wide ? 'modal-wide' : ''}">
    <div class="modal-head"><span class="modal-title">${escapeHtml(title)}</span>
      <button class="modal-x" data-close aria-label="关闭">&times;</button></div>
    <div class="modal-body">${body}</div>
    ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
  </div>`
  hydrateIcons(root)
  root.querySelector('[data-close]')?.addEventListener('click', closeModal)
  root.addEventListener('click', (e) => { if (e.target === root) closeModal() })
  document.addEventListener('keydown', escHandler)
  return root
}
function closeModal() {
  $('#modal-root').classList.add('hidden')
  $('#modal-root').innerHTML = ''
  document.removeEventListener('keydown', escHandler)
}
function escHandler(e) { if (e.key === 'Escape') closeModal() }

// delegated password visibility toggle (works for static + modal fields)
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.pw-toggle')
  if (!btn) return
  const input = btn.closest('.pw-row')?.querySelector('input')
  if (!input) return
  const show = input.type === 'password'
  input.type = show ? 'text' : 'password'
  btn.querySelector('.nav-icon').innerHTML = icon(show ? 'eye-off' : 'eye')
  btn.title = show ? '隐藏密码' : '显示密码'
})

function confirmModal(title, message, actionLabel = '删除', danger = true) {
  return new Promise((resolve) => {
    openModal({
      title,
      body: `<p>${escapeHtml(message)}</p>`,
      footer: `<button class="btn" data-no>取消</button>
               <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-yes>${escapeHtml(actionLabel)}</button>`,
    })
    const root = $('#modal-root')
    root.querySelector('[data-no]').addEventListener('click', () => { closeModal(); resolve(false) })
    root.querySelector('[data-yes]').addEventListener('click', () => { closeModal(); resolve(true) })
  })
}

// ---- formatting ----
const STATUS_LABELS = { running: '运行中', stopped: '已停止', provisioning: '创建中', upgrading: '升级 / 回退中', failed: '启动失败', deleting: '删除中' }
function statusBadge(status) {
  const label = STATUS_LABELS[status] || '未知状态'
  return `<span class="badge badge-${status}"><span class="dot"></span>${label}</span>`
}
function relTime(ms) {
  if (!ms) return '—'
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return `${s} 秒前`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}
function fmtDate(ms) { return ms ? new Date(ms).toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }) : '—' }
function fmtNum(n) {
  if (n == null) return '0'
  if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, '') + '亿'
  if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万'
  return String(n)
}
function instanceUrl(instance) { return instance.url }
function instanceLaunchUrl(instance) {
  const url = new URL(instance.url)
  url.searchParams.set('portal_bootstrap', '1')
  return url.href
}

function pluginInventoryHtml(data, admin = false) {
  const note = data.scanError
    ? `<p class="form-msg err">${escapeHtml(data.scanError)}</p>`
    : `<p class="hint">清单更新时间：${data.updatedAt ? new Date(data.updatedAt).toLocaleString('zh-CN') : '尚未读取'}</p>`
  const rows = data.plugins.map((plugin) => `<tr>
    <td class="cell-mono">${escapeHtml(plugin.name)}</td>
    <td>${escapeHtml(plugin.version || '未知')}</td>
    <td>${plugin.enabled ? '已启用' : '未启用'}</td>
    <td>${plugin.protected ? '平台默认插件' : `<button class="btn btn-danger btn-sm" data-uninstall-plugin="${escapeHtml(plugin.name)}">卸载并重启</button>`}</td>
  </tr>`).join('')
  return `${note}<div class="cell-actions"><button class="btn btn-ghost btn-sm" data-refresh-plugins>重新读取插件清单</button></div>
    ${rows ? `<div class="table-wrap"><table><thead><tr><th>插件</th><th>版本</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="empty">${data.updatedAt ? '没有检测到第三方插件。' : '尚无插件记录，请点击“重新读取插件清单”。'}</p>`}
    <p class="hint">卸载会短暂停止并重新启动${admin ? '该用户的' : '你的'}实例；工作文件、会话和模型配置不会删除。平台默认插件需由管理员统一维护。</p>`
}

// ---- views ----
function showApp() { $('#auth-view').classList.add('hidden'); $('#app-view').classList.remove('hidden') }
function showAuth() { $('#app-view').classList.add('hidden'); $('#auth-view').classList.remove('hidden') }

function setAdminTab(tab) {
  $$('#admin-nav .nav-item, #mobile-admin-nav .nav-item').forEach((n) => n.classList.toggle('active', n.dataset.tab === tab))
  $('#panel-instances').classList.toggle('hidden', tab !== 'instances')
  $('#panel-users').classList.toggle('hidden', tab !== 'users')
  $('#panel-settings').classList.toggle('hidden', tab !== 'settings')
  $('#panel-gateway').classList.toggle('hidden', tab !== 'gateway')
  $('#panel-plugins').classList.toggle('hidden', tab !== 'plugins')
  $('#panel-dsh-versions').classList.toggle('hidden', tab !== 'dsh-versions')
  const titles = { instances: '实例管理', users: '用户管理', settings: '平台设置', gateway: '模型网关', plugins: '默认插件', 'dsh-versions': 'DSH 版本管理' }
  $('#topbar-title').textContent = titles[tab] || '概览'
  if (tab === 'instances') renderInstances()
  else if (tab === 'users') renderUsers()
  else if (tab === 'settings') renderSettings()
  else if (tab === 'gateway') renderGateway()
  else if (tab === 'plugins') renderPlugins(true)
  else if (tab === 'dsh-versions') renderDshVersions()
}

function setUserTab(tab) {
  const gateway = tab === 'gateway'
  $$('#user-nav [data-user-tab], #mobile-user-nav [data-user-tab]').forEach((button) => {
    const active = button.dataset.userTab === tab
    button.classList.toggle('active', active)
    if (active) button.setAttribute('aria-current', 'page')
    else button.removeAttribute('aria-current')
  })
  $('#user-workspace-view').classList.toggle('hidden', gateway)
  $('#user-gateway-view').classList.toggle('hidden', !gateway)
  $('#topbar-title').textContent = gateway ? '模型网关' : '我的工作空间'
  if (gateway) renderMyGatewayUsage()
}

// ---- auth ----
function resetAuth() {
  $('#auth-msg').textContent = ''
  $('#login-form').reset()
  $('#register-form').reset()
  $('#register-invite-row').classList.toggle('hidden', !cfg.inviteCodeRequired)
  $('#tab-register').classList.toggle('hidden', !cfg.registrationEnabled)
  if (!cfg.registrationEnabled) authMode = 'login'
  renderAuthTabs()
}

function renderAuthTabs() {
  const login = authMode === 'login'
  $('#tab-login').classList.toggle('active', login)
  $('#tab-register').classList.toggle('active', !login)
  $('#login-form').classList.toggle('hidden', !login)
  $('#register-form').classList.toggle('hidden', login)
}

$('#tab-login').addEventListener('click', () => { authMode = 'login'; resetAuth() })
$('#tab-register').addEventListener('click', () => { authMode = 'register'; resetAuth() })

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const fd = new FormData(e.target)
  $('#auth-msg').textContent = ''
  const btn = e.target.querySelector('button[type="submit"]')
  try {
    await withButtonLoading(btn, '正在登录…', () =>
      api('/api/auth/login', { method: 'POST', body: { username: fd.get('username'), password: fd.get('password') } }))
    await boot()
  } catch (err) { $('#auth-msg').textContent = err.message }
})

$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const fd = new FormData(e.target)
  $('#auth-msg').textContent = ''
  try {
    if (fd.get('password') !== fd.get('confirmPassword')) throw new Error('两次输入的密码不一致')
    await withButtonLoading($('#register-submit'), '正在注册…', () =>
      api('/api/auth/register', { method: 'POST', body: {
        username: fd.get('username'), password: fd.get('password'), inviteCode: fd.get('inviteCode'),
      } }))
    await boot()
  } catch (err) { $('#auth-msg').textContent = err.message }
})

$$('.logout-form').forEach((form) => form.addEventListener('submit', async (e) => {
  e.preventDefault()
  const btn = form.querySelector('button[type="submit"]')
  try {
    await withButtonLoading(btn, '正在退出…', () =>
      api('/api/auth/logout', { method: 'POST', body: { _csrf: csrfToken } }))
    window.location.replace('/')
  } catch (err) { toast(err.message, 'err') }
}))

// ---- profile (modal) ----
async function openProfile() {
  try {
    const p = await api('/api/profile')
    openModal({
      title: '个人设置',
      body: `<form id="profile-form" class="form">
        <div class="field"><label>显示名称</label><input name="name" value="${escapeHtml(p.name ?? '')}" /></div>
        <div class="field"><label>账号（用于登录）</label><input name="username" value="${escapeHtml(p.username ?? '')}" autocomplete="username" /></div>
        <div class="field"><label>新密码（留空则不修改）</label><div class="pw-row"><input name="newPassword" type="password" autocomplete="new-password" /><button type="button" class="pw-toggle" title="显示密码"><span class="nav-icon" data-icon="eye"></span></button></div></div>
        <div class="field"><label>当前密码（修改密码时必填）</label><div class="pw-row"><input name="currentPassword" type="password" autocomplete="current-password" /><button type="button" class="pw-toggle" title="显示密码"><span class="nav-icon" data-icon="eye"></span></button></div></div>
        <p id="profile-msg" class="form-msg"></p>
      </form>`,
      footer: `<button class="btn" id="profile-save">保存</button>`,
    })
    $('#profile-save').addEventListener('click', async () => {
      const fd = new FormData($('#profile-form'))
      const msg = $('#profile-msg')
      msg.textContent = ''
      try {
        const updated = await api('/api/profile', { method: 'POST', body: {
          name: fd.get('name'),
          username: fd.get('username') || undefined,
          newPassword: fd.get('newPassword') || undefined,
          currentPassword: fd.get('currentPassword') || undefined,
        }})
        if (updated.csrfToken) {
          csrfToken = updated.csrfToken
          $$('.csrf-token').forEach((input) => { input.value = csrfToken })
        }
        msg.textContent = '保存成功'
        msg.className = 'form-msg ok'
        setTimeout(() => { closeModal(); boot() }, 600)
      } catch (err) { msg.textContent = err.message; msg.className = 'form-msg err' }
    })
  } catch (err) { toast(err.message, 'err') }
}

// ---- user view ----
async function renderUser() {
  try {
    const { instance, releases = [], upgrades = [] } = await api('/api/instance')
    const body = $('#instance-body'), empty = $('#instance-empty')
    if (!instance) {
      myInstance = null
      body.classList.add('hidden'); empty.classList.remove('hidden')
      empty.textContent = '暂未创建实例，请联系管理员。'
      return
    }
    empty.classList.add('hidden'); body.classList.remove('hidden')
    myInstance = instance
    $('#i-slug').textContent = instance.slug
    $('#i-status').innerHTML = statusBadge(instance.status)
    const url = instanceUrl(instance)
    $('#i-url').textContent = url
    $('#i-url').href = url
    $('#i-launch').href = instanceLaunchUrl(instance)
    $('#i-requests').textContent = fmtNum(instance.request_count ?? 0)
    $('#i-active').textContent = relTime(instance.last_active)
    myDshReleases = releases
    myDshUpgrades = upgrades
    $('#i-dsh-version').textContent = instance.dshRelease?.version ?? '未识别'
    $('#i-dsh-upgrade').disabled = instance.status === 'upgrading'
    $('#i-error').textContent = instance.error ? errorMessage(instance.error) : ''
    $('#i-error').style.display = instance.error ? '' : 'none'
    renderMyGateway()
    if (!$('#my-plugins').dataset.loaded) renderMyPlugins()
  } catch (err) {
    $('#instance-empty').textContent = err.message
  }
}

$('#i-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#i-url').textContent); toast('地址已复制', 'ok') }
  catch { toast('复制失败，请手动复制', 'err') }
})

async function renderMyPlugins(refresh = false) {
  const root = $('#my-plugins')
  root.dataset.loaded = 'true'
  root.innerHTML = '<h3>我的插件</h3><p><span class="spinner"></span> 正在读取…</p>'
  try {
    const data = await api(`/api/profile/plugins${refresh ? '?refresh=1' : ''}`)
    root.innerHTML = `<h3>我的插件</h3>${pluginInventoryHtml(data)}`
    root.querySelector('[data-refresh-plugins]').addEventListener('click', (e) => withButtonLoading(e.currentTarget, '正在读取…', () => renderMyPlugins(true)))
    root.querySelectorAll('[data-uninstall-plugin]').forEach((button) => button.addEventListener('click', async () => {
      const packageName = button.dataset.uninstallPlugin
      const ok = await confirmModal('卸载插件并重启', `确定卸载 ${packageName} 吗？实例会短暂停止并重新启动。`, '确认卸载')
      if (!ok) return
      try {
        await withButtonLoading(button, '正在卸载…', () => api('/api/profile/plugins/uninstall', { method: 'POST', body: { packageName } }))
        toast('插件已卸载，实例已尝试恢复', 'ok'); await renderMyPlugins(true); renderUser()
      } catch (err) { toast(err.message, 'err') }
    }))
  } catch (err) { root.innerHTML = `<h3>我的插件</h3><p class="form-msg err">${escapeHtml(err.message)}</p>` }
}

$('#i-restart').addEventListener('click', async (e) => {
  const ok = await confirmModal('重启服务', '将停止并重新启动当前容器。文件、插件和配置会保留，当前连接会短暂中断。', '确认重启', false)
  if (!ok) return
  try {
    await withButtonLoading(e.currentTarget, '正在重启…', () => api('/api/instance/restart', { method: 'POST' }))
    toast('服务已重启', 'ok')
    renderUser()
  } catch (err) { toast(err.message, 'err') }
})

// ---- admin ----
async function renderStats() {
  try {
    const { stats } = await api('/api/admin/stats')
    const cards = [
      ['用户总数', stats.users, 'users'],
      ['实例总数', stats.instances, 'server'],
      ['运行中', stats.running, 'play'],
      ['累计请求', fmtNum(stats.totalRequests), 'refresh'],
    ]
    $('#admin-stats').innerHTML = cards.map(([label, value, ic]) => `<div class="stat-card">
      <div class="stat-label"><span class="nav-icon" data-icon="${ic}"></span> ${label}</div>
      <div class="stat-value">${value}</div>
    </div>`).join('')
    hydrateIcons($('#admin-stats'))
  } catch { /* ignore */ }
}

async function renderInstances() {
  try {
    const { instances } = await api('/api/admin/instances')
    instancesCache = instances
    drawInstances()
  } catch (err) { $('#instances-table').innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>` }
}

function drawInstances() {
  const q = ($('#search-instances').value || '').toLowerCase()
  const rows = instancesCache
    .filter((i) => !q || [i.slug, i.username, i.user_name, i.status, STATUS_LABELS[i.status]].some((v) => String(v ?? '').toLowerCase().includes(q)))
    .map((i) => {
      const url = instanceUrl(i)
      const id = i.username || i.user_name || '—'
      return `<tr>
        <td class="cell-mono">${escapeHtml(i.slug)}</td>
        <td>${escapeHtml(id)}</td>
        <td>${statusBadge(i.status)}</td>
        <td>${escapeHtml(i.dshRelease?.version ?? '未识别')}</td>
        <td class="cell-mono">${i.host_port}</td>
        <td>${fmtNum(i.request_count ?? 0)}</td>
        <td>${relTime(i.last_active)}</td>
        <td><div class="cell-actions">
          <a class="btn btn-ghost btn-sm" href="${instanceLaunchUrl(i)}" target="_blank" rel="noopener">${icon('external', 14)} 进入</a>
          <button class="btn btn-ghost btn-sm" data-act="logs" data-id="${i.id}">${icon('terminal', 14)} 日志</button>
          <button class="btn btn-ghost btn-sm" data-act="plugins" data-id="${i.id}">${icon('sliders', 14)} 插件</button>
          <button class="btn btn-ghost btn-sm" data-act="restart" data-id="${i.id}">${icon('refresh', 14)} 重启服务</button>
          <button class="btn btn-ghost btn-sm" data-act="dsh" data-id="${i.id}" ${i.status === 'upgrading' ? 'disabled' : ''}>${icon('refresh', 14)} DSH 版本</button>
          <button class="btn btn-ghost btn-sm" data-act="reprovision" data-id="${i.id}" title="删除旧容器并按当前镜像新建；用户数据卷会保留。">${icon('refresh', 14)} 重建容器</button>
          <button class="btn btn-danger btn-sm" data-act="delete" data-id="${i.id}">${icon('trash', 14)} 删除</button>
        </div></td>
      </tr>`
    }).join('')
  $('#instances-table').innerHTML = rows
    ? `<div class="table-wrap"><table><thead><tr><th>实例</th><th>所属用户</th><th>状态</th><th>DSH 版本</th><th>内部端口</th><th>请求次数</th><th>最近活跃</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<p class="empty">暂无符合条件的实例。</p>`
}

async function renderUsers() {
  try {
    const { users } = await api('/api/admin/users')
    usersCache = users
    drawUsers()
  } catch (err) { $('#users-table').innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>` }
}

function drawUsers() {
  const q = ($('#search-users').value || '').toLowerCase()
  const rows = usersCache
    .filter((u) => !q || [u.username, u.name, u.role, u.role === 'admin' ? '管理员' : '普通用户'].some((v) => String(v ?? '').toLowerCase().includes(q)))
    .map((u) => `<tr>
      <td>${escapeHtml(u.username || '—')}</td>
      <td>${escapeHtml(u.name || '')}</td>
      <td><span class="badge ${u.role === 'admin' ? 'badge-running' : 'badge-stopped'}">${u.role === 'admin' ? '管理员' : '普通用户'}</span></td>
      <td>${fmtDate(u.created_at)}</td>
      <td>${u.role !== 'admin' ? `<button class="btn btn-ghost btn-sm" data-uid="${u.id}" data-act="reset-password">${icon('key', 14)} 重置密码</button> <button class="btn btn-danger btn-sm" data-uid="${u.id}" data-act="deluser">${icon('trash', 14)} 删除</button>` : ''}</td>
    </tr>`).join('')
  $('#users-table').innerHTML = rows
    ? `<div class="table-wrap"><table><thead><tr><th>账号</th><th>显示名称</th><th>角色</th><th>注册日期</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<p class="empty">暂无符合条件的用户。</p>`
}

async function renderSettings() {
  try {
    const s = await api('/api/admin/settings')
    $('#set-invite').value = s.inviteCode ?? ''
    $('#settings-form').elements.registrationEnabled.checked = s.registrationEnabled
  } catch (err) { $('#settings-msg').textContent = err.message; $('#settings-msg').className = 'form-msg err' }
}

$('#gen-invite').addEventListener('click', () => {
  const code = 'dsh-' + Math.random().toString(36).slice(2, 8).toUpperCase()
  $('#set-invite').value = code
})
$('#copy-invite').addEventListener('click', async () => {
  const v = $('#set-invite').value
  if (!v) { toast('请先填写或生成邀请码', 'err'); return }
  try { await navigator.clipboard.writeText(v); toast('邀请码已复制', 'ok') }
  catch { toast('复制失败，请手动复制', 'err') }
})

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const fd = new FormData(e.target)
  const msg = $('#settings-msg')
  msg.textContent = ''
  const btn = e.target.querySelector('button[type="submit"]')
  try {
    await withButtonLoading(btn, '正在保存…', () => api('/api/admin/settings', { method: 'POST', body: {
      inviteCode: fd.get('inviteCode'),
      registrationEnabled: fd.get('registrationEnabled') === 'on',
    }}))
    msg.textContent = '保存成功'
    msg.className = 'form-msg ok'
    await boot()
    setTimeout(() => { msg.textContent = '' }, 2000)
  } catch (err) { msg.textContent = err.message; msg.className = 'form-msg err' }
})

// ---- admin actions ----
$('#instances-table').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]')
  if (!btn) return
  const { act, id } = btn.dataset
  try {
    if (act === 'logs') {
      openModal({ title: '实例日志', body: '<p><span class="spinner"></span> 正在加载…</p>', wide: true })
      const { logs } = await api(`/api/admin/instances/${id}/logs`)
      $('#modal-root .modal-body').innerHTML = `<pre class="log-view">${escapeHtml(logs || '（暂无日志）')}</pre>`
      return
    }
    if (act === 'plugins') {
      const instance = instancesCache.find((row) => String(row.id) === id)
      openPluginRecovery(instance)
      return
    }
    if (act === 'dsh') {
      const instance = instancesCache.find((row) => String(row.id) === id)
      await openDshVersionDialog(instance, { admin: true })
      return
    }
    if (act === 'delete') {
      const ok = await confirmModal('删除实例', '确定删除此实例及其全部数据吗？此操作无法撤销。')
      if (!ok) return
    }
    if (act === 'reprovision') {
      const ok = await confirmModal('重建容器', '将删除旧容器并按当前镜像和平台配置新建。用户文件、插件及配置会保留；若只需让插件生效，请使用“重启服务”。', '确认重建', false)
      if (!ok) return
    }
    if (act === 'restart') {
      const ok = await confirmModal('重启服务', '将停止并重新启动当前容器。文件、插件和配置会保留，当前连接会短暂中断。', '确认重启', false)
      if (!ok) return
      await withButtonLoading(btn, '正在重启…', () => api(`/api/admin/instances/${id}/restart`, { method: 'POST' }))
      toast('服务已重启', 'ok')
    } else {
      await api(`/api/admin/instances/${id}/${act}`, { method: 'POST' })
      toast(act === 'delete' ? '实例已删除' : '实例正在重建', 'ok')
    }
    renderStats(); renderInstances()
  } catch (err) { toast(err.message, 'err') }
})

async function openPluginRecovery(instance) {
  if (!instance) return
  openModal({ title: `插件管理：${instance.username || instance.slug}`, body: '<div id="admin-plugin-inventory"><p><span class="spinner"></span> 正在读取…</p></div>', wide: true })
  const render = async (refresh = false) => {
    const root = $('#admin-plugin-inventory')
    try {
      const data = await api(`/api/admin/plugins/inventory?instanceId=${instance.id}${refresh ? '&refresh=1' : ''}`)
      root.innerHTML = pluginInventoryHtml(data, true)
      root.querySelector('[data-refresh-plugins]').addEventListener('click', (e) => withButtonLoading(e.currentTarget, '正在读取…', () => render(true)))
      root.querySelectorAll('[data-uninstall-plugin]').forEach((button) => button.addEventListener('click', async () => {
        const packageName = button.dataset.uninstallPlugin
        const ok = await confirmModal('代用户卸载插件', `确定从 ${instance.username || instance.slug} 的实例卸载 ${packageName} 吗？实例会重新启动。`, '确认卸载')
        if (!ok) return
        try {
          await api('/api/admin/plugins/uninstall', { method: 'POST', body: { instanceId: instance.id, packageName } })
          toast('插件已卸载，实例已尝试恢复', 'ok')
          openPluginRecovery(instance)
          renderInstances()
        } catch (err) { toast(err.message, 'err'); openPluginRecovery(instance) }
      }))
    } catch (err) { root.innerHTML = `<p class="form-msg err">${escapeHtml(err.message)}</p>` }
  }
  await render(true)
}

$('#users-table').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]')
  if (!btn) return
  if (btn.dataset.act === 'reset-password') {
    const user = usersCache.find((u) => String(u.id) === btn.dataset.uid)
    openModal({ title: `重置密码：${user?.username ?? ''}`,
      body: '<div class="field"><label for="reset-password">新密码（至少 8 个字符）</label><input id="reset-password" type="password" autocomplete="new-password" /></div><p id="reset-msg" class="form-msg"></p>',
      footer: '<button class="btn btn-primary" id="reset-save">重置密码</button>',
    })
    $('#reset-save').addEventListener('click', async () => {
      try {
        await withButtonLoading($('#reset-save'), '正在保存…', () => api(`/api/admin/users/${btn.dataset.uid}/reset-password`, {
          method: 'POST', body: { password: $('#reset-password').value },
        }))
        closeModal()
        toast('密码已重置，该用户的原有登录已失效', 'ok')
      } catch (err) { $('#reset-msg').textContent = err.message }
    })
    return
  }
  const ok = await confirmModal('删除用户', '确定删除此用户及其工作空间中的全部数据吗？此操作无法撤销。')
  if (!ok) return
  try {
    await api(`/api/admin/users/${btn.dataset.uid}/delete`, { method: 'POST' })
    toast('用户已删除', 'ok')
    renderStats(); renderUsers()
  } catch (err) { toast(err.message, 'err') }
})

$('#search-instances').addEventListener('input', drawInstances)
$('#search-users').addEventListener('input', drawUsers)

// ---- DSH versions ---------------------------------------------------------
function dshVersionLabel(release) {
  return release?.version || '未识别版本'
}

function dshUpgradeHistoryHtml(upgrades, admin, selfServiceReleaseIds = new Set()) {
  if (!upgrades?.length) return '<p class="hint">暂无升级记录。</p>'
  const rows = upgrades.map((upgrade) => `<tr>
    <td>${escapeHtml(upgrade.operation === 'rollback' ? '回退' : '升级')}</td>
    <td>${escapeHtml(upgrade.fromVersion)} → ${escapeHtml(upgrade.toVersion)}</td>
    <td>${escapeHtml({ running: '进行中', completed: '已完成', rolled_back: '已自动回退', failed: '失败', interrupted: '已中断' }[upgrade.status] || upgrade.status)}</td>
    <td>${fmtDate(upgrade.createdAt)}</td>
    <td>${upgrade.message ? escapeHtml(upgrade.message) : '—'}</td>
    <td>${admin || selfServiceReleaseIds.has(upgrade.fromReleaseId) ? `<button class="btn btn-ghost btn-sm" data-dsh-rollback="${upgrade.id}">${admin ? '回退到此快照' : '回退'}</button>` : '仅管理员可回退'}</td>
  </tr>`).join('')
  return `<div class="table-wrap"><table><thead><tr><th>操作</th><th>版本</th><th>结果</th><th>时间</th><th>说明</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
}

async function openDshVersionDialog(instance, { admin = false } = {}) {
  if (!instance) return
  let releases = admin ? dshReleasesCache : myDshReleases
  if (admin) {
    const data = await api('/api/admin/dsh/releases')
    dshReleasesCache = data.releases
    releases = data.releases
  }
  const current = instance.dshRelease
  const selectable = releases.filter((release) => release.id !== current?.id)
  const upgrades = admin ? instance.dshUpgrades : myDshUpgrades
  const options = selectable.map((release) => `<option value="${release.id}">${escapeHtml(dshVersionLabel(release))}${release.isDefault ? '（新用户默认）' : ''}</option>`).join('')
  openModal({
    title: `DSH 版本：${instance.username || instance.slug}`,
    wide: true,
    body: `<p>当前版本：<strong>${escapeHtml(dshVersionLabel(current))}</strong></p>
      ${options ? `<div class="field"><label for="dsh-target-release">目标版本</label><select id="dsh-target-release">${options}</select></div>
      <p class="hint">升级会暂时中断连接。系统先停止实例并备份 home、workspace 两个数据卷；目标版本健康检查失败时，会自动恢复旧版本和备份。</p>`
        : `<p class="hint">${admin ? '暂无其他已构建版本。请先在“DSH 版本管理”构建镜像。' : '管理员尚未开放其他版本供个人自助升级。'}</p>`}
      <h3>升级与回退记录</h3>${dshUpgradeHistoryHtml(upgrades, admin, new Set(releases.map((release) => release.id)))}`,
    footer: `${options ? '<button class="btn btn-primary" id="dsh-start-upgrade">开始升级</button>' : ''}<button class="btn" data-close>关闭</button>`,
  })
  const start = $('#dsh-start-upgrade')
  start?.addEventListener('click', async () => {
    const releaseId = Number($('#dsh-target-release').value)
    const chosen = selectable.find((release) => release.id === releaseId)
    const ok = await confirmModal('确认升级 DSH', `将 ${instance.username || instance.slug} 从 ${dshVersionLabel(current)} 升级到 ${dshVersionLabel(chosen)}。升级前会创建可回退的数据快照，服务会短暂中断。`, '确认升级', false)
    if (!ok) return
    try {
      await withButtonLoading(start, '正在提交…', () => api(admin
        ? `/api/admin/instances/${instance.id}/dsh-upgrade`
        : '/api/instance/dsh-upgrade', { method: 'POST', body: { releaseId } }))
      toast('DSH 升级已开始，可稍后刷新查看健康检查和回退结果', 'ok')
      if (admin) renderInstances(); else renderUser()
    } catch (err) { toast(err.message, 'err') }
  })
  $('#modal-root').querySelectorAll('[data-dsh-rollback]').forEach((button) => button.addEventListener('click', async () => {
    const id = button.dataset.dshRollback
    const ok = await confirmModal('确认回退 DSH', '将恢复此记录所保存的版本和数据快照。当前版本的数据会先备份；若回退健康检查失败，将自动恢复当前版本。', '确认回退', false)
    if (!ok) return
    try {
      await withButtonLoading(button, '正在提交…', () => api(admin
        ? `/api/admin/instances/${instance.id}/dsh-rollbacks/${id}`
        : `/api/instance/dsh-rollbacks/${id}`, { method: 'POST' }))
      toast('DSH 回退已开始，可稍后刷新查看结果', 'ok')
      if (admin) renderInstances(); else renderUser()
    } catch (err) { toast(err.message, 'err') }
  }))
}

async function renderDshVersions() {
  try {
    const data = await api('/api/admin/dsh/releases')
    dshReleasesCache = data.releases
    const active = data.builds.find((build) => ['queued', 'running'].includes(build.status))
    $('#dsh-build-status').textContent = active
      ? `正在构建 ${active.requestedVersion}，完成后请先选择一个测试实例灰度升级。`
      : '构建完成不会自动升级用户实例；请从“实例管理”逐个或分批操作。'
    $('#dsh-build-form').querySelector('button').disabled = Boolean(active)
    $('#dsh-releases').innerHTML = data.releases.length
      ? `<div class="table-wrap"><table><thead><tr><th>版本</th><th>镜像 ID</th><th>新用户默认</th><th>个人自助升级</th><th>创建时间</th><th>操作</th></tr></thead><tbody>${data.releases.map((release) => `<tr>
          <td>${escapeHtml(dshVersionLabel(release))}</td><td class="cell-mono">${escapeHtml(release.imageId.slice(0, 19))}…</td>
          <td>${release.isDefault ? '是' : '否'}</td><td>${release.selfService ? '已开放' : '仅管理员'}</td><td>${fmtDate(release.createdAt)}</td>
          <td><div class="cell-actions">${release.isDefault ? '' : `<button class="btn btn-ghost btn-sm" data-dsh-release="${release.id}" data-dsh-release-action="default">设为默认</button>`}
          <button class="btn btn-ghost btn-sm" data-dsh-release="${release.id}" data-dsh-release-action="self">${release.selfService ? '关闭自助' : '开放自助'}</button></div></td>
        </tr>`).join('')}</tbody></table></div>`
      : '<p class="empty">尚无可用的 DSH 镜像版本。</p>'
    $('#dsh-builds').innerHTML = data.builds.length
      ? `<div class="table-wrap"><table><thead><tr><th>请求版本</th><th>状态</th><th>时间</th><th>说明</th></tr></thead><tbody>${data.builds.map((build) => `<tr><td>${escapeHtml(build.requestedVersion)}</td><td>${escapeHtml({ queued: '排队中', running: '构建中', completed: '已完成', failed: '失败', interrupted: '已中断' }[build.status] || build.status)}</td><td>${fmtDate(build.createdAt)}</td><td>${escapeHtml(build.message || '—')}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="hint">尚无构建记录。</p>'
  } catch (err) { $('#dsh-build-status').textContent = err.message }
}

$('#dsh-build-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const button = e.target.querySelector('button[type="submit"]')
  try {
    await withButtonLoading(button, '正在提交…', () => api('/api/admin/dsh/releases/build', {
      method: 'POST', body: { version: new FormData(e.target).get('version') },
    }))
    toast('镜像构建已开始，请勿关闭 Portal 服务', 'ok'); renderDshVersions()
  } catch (err) { toast(err.message, 'err') }
})

$('#dsh-releases').addEventListener('click', async (e) => {
  const button = e.target.closest('[data-dsh-release]')
  if (!button) return
  const release = dshReleasesCache.find((item) => String(item.id) === button.dataset.dshRelease)
  if (!release) return
  const isDefault = button.dataset.dshReleaseAction === 'default'
  try {
    await withButtonLoading(button, '正在保存…', () => api(`/api/admin/dsh/releases/${release.id}`, {
      method: 'POST', body: isDefault ? { isDefault: true } : { selfService: !release.selfService },
    }))
    toast(isDefault ? '已设为新用户默认版本' : (release.selfService ? '已关闭个人自助升级' : '已开放个人自助升级'), 'ok')
    renderDshVersions()
  } catch (err) { toast(err.message, 'err') }
})

$('#i-dsh-upgrade').addEventListener('click', () => {
  openDshVersionDialog(myInstance).catch((err) => toast(err.message, 'err'))
})

// ---- nav ----
$$('#admin-nav .nav-item, #mobile-admin-nav .nav-item').forEach((n) => n.addEventListener('click', () => setAdminTab(n.dataset.tab)))
$$('#user-nav [data-user-tab], #mobile-user-nav [data-user-tab]').forEach((button) => button.addEventListener('click', () => setUserTab(button.dataset.userTab)))
$('#profile-btn').addEventListener('click', openProfile)
$('#mobile-profile-btn').addEventListener('click', openProfile)
$('#refresh-btn').addEventListener('click', () => {
  if (me?.role === 'admin' && !$('#panel-plugins').classList.contains('hidden')) { renderPlugins(); return }
  if (me?.role === 'admin' && !$('#panel-dsh-versions').classList.contains('hidden')) { renderDshVersions(); return }
  if (me?.role === 'admin' && !$('#panel-gateway').classList.contains('hidden')) { renderGateway(); return }
  if (me?.role !== 'admin' && !$('#user-gateway-view').classList.contains('hidden')) { renderMyGatewayUsage(); return }
  boot()
})

// ---- default plugins ----
async function renderPlugins(loadForm = false) {
  try {
    const data = await api('/api/admin/plugins')
    if (loadForm) $('#plugin-commands').value = data.commands
    $('#plugins-status').textContent = data.busy ? '正在逐个处理实例，可离开此页面，稍后回来查看结果。' : '新用户自动安装保存的默认插件；已有用户可批量安装或单独重试。'
    $('#plugins-save').disabled = data.busy
    $('#plugins-apply').disabled = data.busy || !data.commands
    const states = { queued: '等待安装', running: '正在安装', completed: '安装成功', failed: '安装失败' }
    $('#plugins-instances').innerHTML = data.instances.length ? `<div class="table-wrap"><table><thead><tr><th>用户</th><th>安装状态</th><th>已安装版本</th><th>说明</th><th>操作</th></tr></thead><tbody>${data.instances.map((i) => `<tr><td>${escapeHtml(i.username)}</td><td>${states[i.plugin?.state] ?? '尚未下发'}${i.plugin && i.plugin.revision !== data.revision ? ' · 默认配置已更新' : ''}</td><td>${escapeHtml(i.plugin ? JSON.parse(i.plugin.installed).map((p) => `${p.name}@${p.version}`).join('、') : '—')}</td><td>${escapeHtml(i.plugin?.message ?? '')}</td><td><button class="btn btn-ghost btn-sm" data-plugin-instance="${i.id}" ${['queued', 'running'].includes(i.plugin?.state) || !data.commands || i.status === 'deleting' ? 'disabled' : ''}>安装 / 重试</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">暂无子用户实例。</p>'
  } catch (err) { $('#plugins-status').textContent = err.message }
}
$('#plugins-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  try {
    await withButtonLoading($('#plugins-save'), '正在保存…', () => api('/api/admin/plugins', { method: 'POST', body: { commands: $('#plugin-commands').value } }))
    toast('默认插件已保存；已有实例请点击批量安装', 'ok'); renderPlugins(true)
  } catch (err) { toast(err.message, 'err') }
})
async function applyPlugins(instanceId) {
  try {
    await api('/api/admin/plugins/apply', { method: 'POST', body: instanceId ? { instanceId: Number(instanceId) } : {} })
    toast('安装任务已提交，成功后自动重启', 'ok'); renderPlugins()
  } catch (err) { toast(err.message, 'err') }
}
$('#plugins-apply').addEventListener('click', () => applyPlugins())
$('#plugins-instances').addEventListener('click', (e) => {
  const button = e.target.closest('[data-plugin-instance]')
  if (button) applyPlugins(button.dataset.pluginInstance)
})

// ---- model gateway ----
let gatewayCache = null
const exactTokens = (n) => Number(n ?? 0).toLocaleString('zh-CN')
function gatewayChecks(models, selected = []) {
  return models.map((m) => `<label class="check"><input type="checkbox" name="models" value="${escapeHtml(m.id)}" ${selected.includes(m.id) ? 'checked' : ''} /> ${escapeHtml(m.name)}${m.enabled ? '' : '（停用）'}</label>`).join('') || '<p class="hint">请先添加模型。</p>'
}
async function renderGateway() {
  try {
    const data = await api('/api/admin/gateway')
    gatewayCache = data
    $('#gateway-status').textContent = !data.available ? '模型网关服务尚未部署。请按部署文档启动 Bifrost 并启用模型入口。'
      : `${data.engine} · ${data.healthy ? '网关连接正常' : '网关连接异常'} · ${data.enabled ? '平台模型已启用' : '平台模型已停用'} · ${data.day}`
    $('#gateway-defaults').elements.enabled.checked = data.enabled
    $('#gateway-defaults').elements.defaultEnabled.checked = data.defaults.enabled
    $('#gateway-default-quota').value = data.defaults.dailyTokens
    $('#gateway-default-models').innerHTML = gatewayChecks(data.models, data.defaults.models)
    $('#gateway-models').innerHTML = data.models.length ? `<div class="table-wrap"><table><thead><tr><th>模型</th><th>接口地址</th><th>状态</th><th>操作</th></tr></thead><tbody>${data.models.map((m) => `<tr><td>${escapeHtml(m.name)}<div class="hint">${escapeHtml(m.upstream_model)}</div></td><td class="cell-mono">${escapeHtml(m.base_url)}</td><td>${m.sync_error ? escapeHtml(m.sync_error) : m.enabled ? '已启用' : '已停用'}<div class="hint">密钥${m.hasKey ? '已保存' : '未配置'}</div></td><td><div class="cell-actions"><button class="btn btn-ghost btn-sm" data-model="${m.id}" data-action="edit">编辑</button><button class="btn btn-ghost btn-sm" data-model="${m.id}" data-action="sync">重试同步</button></div></td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">尚未添加平台模型。</p>'
    $('#gateway-users').innerHTML = data.users.length ? `<div class="table-wrap"><table><thead><tr><th>用户</th><th>可用模型</th><th>今日用量 / 限额</th><th>配置状态</th><th>操作</th></tr></thead><tbody>${data.users.map((u) => `<tr><td>${escapeHtml(u.username)}<div class="hint">${u.enabled ? '已启用' : '未启用'}</div></td><td>${u.models.map((id) => escapeHtml(data.models.find((m) => m.id === id)?.name ?? id)).join('<br>') || '—'}</td><td>${exactTokens(u.chargedTokens)} / ${exactTokens(u.dailyTokens)}<div class="hint">预留 ${exactTokens(u.reservedTokens)} · 可用 ${exactTokens(u.remainingTokens)}</div></td><td>${u.syncError ? escapeHtml(u.syncError) : u.syncedAt ? '已下发' : '尚未下发'}</td><td><button class="btn btn-ghost btn-sm" data-policy="${u.id}">配置</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">注册用户后可在此分配模型和额度。</p>'
    const form = $('#gateway-usage-filter')
    if (!form.elements.from.value) form.elements.from.value = new Date(Date.parse(data.day) - 29 * 86400000).toISOString().slice(0, 10)
    if (!form.elements.to.value) form.elements.to.value = data.day
    await renderGatewayUsage()
  } catch (err) { $('#gateway-status').textContent = err.message }
}
function editGatewayModel(id) {
  const m = gatewayCache?.models.find((row) => row.id === id)
  openModal({ title: m ? '编辑平台模型' : '添加平台模型', body: `<form class="form" id="gateway-model-form">
    <div class="field"><label for="gm-name">显示名称</label><input id="gm-name" name="name" required value="${escapeHtml(m?.name ?? '')}" /></div>
    <div class="field"><label for="gm-model">上游模型 ID</label><input id="gm-model" name="upstreamModel" required value="${escapeHtml(m?.upstream_model ?? '')}" placeholder="MiniMax-M3" /></div>
    <div class="field"><label for="gm-url">接口基础地址（支持兼容 OpenAI 的服务）</label><input id="gm-url" name="baseUrl" required value="${escapeHtml(m?.base_url ?? '')}" placeholder="https://example.com/v1" /></div>
    <div class="field"><label for="gm-key">API Key${m ? '（留空保留现有密钥）' : ''}</label><input id="gm-key" name="apiKey" type="password" autocomplete="new-password" /></div>
    <div class="field"><label for="gm-output">单次最大输出 Token</label><input id="gm-output" name="maxOutputTokens" type="number" min="1" max="65536" required value="${m?.max_output_tokens ?? 4096}" /></div>
    <label class="check"><input name="enabled" type="checkbox" ${m?.enabled === 0 ? '' : 'checked'} /> 启用模型</label>
    <p class="hint">密钥保存在服务端，子用户只获得平台凭证。更改显示名称或输出上限后，可重新下发到用户 DSH。</p>
    <p id="gateway-modal-msg" class="form-msg" role="alert"></p></form>`, footer: '<button class="btn btn-primary" id="gateway-model-save">保存并同步</button>' })
  $('#gateway-model-save').addEventListener('click', async () => {
    const fd = new FormData($('#gateway-model-form'))
    try {
      const result = await withButtonLoading($('#gateway-model-save'), '正在保存…', () => api('/api/admin/gateway/models', { method: 'POST', body: {
        ...(m ? { id: m.id } : {}), name: fd.get('name'), upstreamModel: fd.get('upstreamModel'), baseUrl: fd.get('baseUrl'),
        apiKey: fd.get('apiKey'), maxOutputTokens: Number(fd.get('maxOutputTokens')), enabled: fd.get('enabled') === 'on',
      } }))
      $('#gm-key').value = ''
      closeModal(); await renderGateway()
      toast(result.model.sync_error || '模型已保存并同步', result.model.sync_error ? 'err' : 'ok')
    } catch (err) { $('#gateway-modal-msg').textContent = err.message }
  })
}
function editGatewayPolicy(id) {
  const u = gatewayCache.users.find((row) => String(row.id) === id)
  if (!u) return
  openModal({ title: `模型配置：${u.username}`, body: `<form id="gateway-policy-form" class="form">
    <label class="check"><input name="enabled" type="checkbox" ${u.enabled ? 'checked' : ''} /> 允许使用平台模型</label>
    <div class="field"><label for="gp-quota">每日 Token 限额（0 为禁止调用）</label><input id="gp-quota" name="dailyTokens" type="number" min="0" max="1000000000" value="${u.dailyTokens}" /></div>
    <fieldset class="gateway-model-checks"><legend>可用模型</legend>${gatewayChecks(gatewayCache.models, u.models)}</fieldset>
    <label class="check"><input name="setDefault" type="checkbox" /> 下发时将第一个平台模型设为 DSH 默认</label>
    <p class="hint">保存权限立即生效，不清空今日用量。下发只更新“平台模型”，保留个人模型、密钥和插件；DSH 需要处于运行状态。</p>
    <button type="button" class="btn btn-ghost btn-sm" id="gateway-rotate">重置此用户的平台凭证</button>
    <p id="gateway-policy-msg" class="form-msg" role="alert"></p></form>`,
    footer: '<button class="btn btn-ghost" id="gateway-policy-save">仅保存权限</button><button class="btn btn-primary" id="gateway-policy-sync">保存并下发</button>' })
  for (const sync of [false, true]) $(sync ? '#gateway-policy-sync' : '#gateway-policy-save').addEventListener('click', async (e) => {
    const fd = new FormData($('#gateway-policy-form'))
    try {
      await withButtonLoading(e.currentTarget, '正在处理…', async () => {
        await api(`/api/admin/gateway/users/${id}`, { method: 'POST', body: { enabled: fd.get('enabled') === 'on', dailyTokens: Number(fd.get('dailyTokens')), models: fd.getAll('models') } })
        if (sync) await api(`/api/admin/gateway/users/${id}/sync`, { method: 'POST', body: { setDefault: fd.get('setDefault') === 'on' } })
      })
      closeModal(); renderGateway(); toast(sync ? '权限已保存，模型已下发' : '权限已保存', 'ok')
    } catch (err) { $('#gateway-policy-msg').textContent = err.message }
  })
  $('#gateway-rotate').addEventListener('click', async (e) => {
    try {
      await withButtonLoading(e.currentTarget, '正在重置…', () => api(`/api/admin/gateway/users/${id}/rotate`, { method: 'POST' }))
      $('#gateway-policy-msg').textContent = '原凭证已失效。请点击“保存并下发”更新 DSH 中的平台凭证。'
    } catch (err) { $('#gateway-policy-msg').textContent = err.message }
  })
}
async function renderMyGateway() {
  try {
    const p = await api('/api/gateway/me')
    $('#my-gateway').innerHTML = `<h3>我的平台模型</h3><p>${!p.gatewayEnabled ? '平台模型服务未启用。' : !p.enabled ? '管理员尚未分配平台模型。' : `${p.models.map((m) => escapeHtml(m.name)).join('、')} · 今日已用 ${exactTokens(p.chargedTokens)} / ${exactTokens(p.dailyTokens)} Token · 预留 ${exactTokens(p.reservedTokens)}`}</p><div class="cell-actions">${p.enabled && p.gatewayEnabled ? '<button class="btn btn-ghost btn-sm" id="my-gateway-sync">更新平台模型配置</button>' : ''}<button class="btn btn-ghost btn-sm" id="my-gateway-usage-link">查看我的用量</button></div><p class="hint">${escapeHtml(p.syncError || '个人模型用量不计入平台额度。')}</p>`
    $('#my-gateway-sync')?.addEventListener('click', async (e) => {
      try { await withButtonLoading(e.currentTarget, '正在更新…', () => api('/api/gateway/me/sync', { method: 'POST' })); toast('平台模型已更新', 'ok') }
      catch (err) { toast(err.message, 'err') }
    })
    $('#my-gateway-usage-link')?.addEventListener('click', () => setUserTab('gateway'))
  } catch { $('#my-gateway').textContent = '' }
}
$('#gateway-add-model').addEventListener('click', () => editGatewayModel())
$('#gateway-models').addEventListener('click', async (e) => {
  const button = e.target.closest('[data-model]')
  if (!button) return
  if (button.dataset.action === 'edit') { editGatewayModel(button.dataset.model); return }
  try { await withButtonLoading(button, '正在同步…', () => api(`/api/admin/gateway/models/${button.dataset.model}/sync`, { method: 'POST' })); renderGateway(); toast('同步成功', 'ok') }
  catch (err) { toast(err.message, 'err') }
})
$('#gateway-users').addEventListener('click', (e) => { const b = e.target.closest('[data-policy]'); if (b) editGatewayPolicy(b.dataset.policy) })
$('#gateway-defaults').addEventListener('submit', async (e) => {
  e.preventDefault()
  const fd = new FormData(e.target)
  try {
    await withButtonLoading(e.target.querySelector('button[type="submit"]'), '正在保存…', () => api('/api/admin/gateway/settings', { method: 'POST', body: {
      enabled: fd.get('enabled') === 'on', defaults: { enabled: fd.get('defaultEnabled') === 'on', dailyTokens: Number(fd.get('dailyTokens')), models: fd.getAll('models') },
    } }))
    toast('默认配置已保存', 'ok'); renderGateway()
  } catch (err) { toast(err.message, 'err') }
})
$('#gateway-usage-filter').addEventListener('submit', (e) => { e.preventDefault(); renderGatewayUsage() })

// ---- boot ----
async function boot() {
  try {
    const c = await api('/api/config')
    cfg = { ...cfg, ...c }
  } catch { /* defaults */ }

  try {
    const { user, csrfToken: sessionCsrfToken } = await api('/api/auth/me')
    me = user
    csrfToken = sessionCsrfToken
    $$('.csrf-token').forEach((input) => { input.value = csrfToken })
    $('#whoami').textContent = user.username || user.name
    showApp()
    $('#admin-nav').classList.toggle('hidden', user.role !== 'admin')
    $('#mobile-admin-nav').classList.toggle('hidden', user.role !== 'admin')
    $('#user-nav').classList.toggle('hidden', user.role === 'admin')
    $('#mobile-user-nav').classList.toggle('hidden', user.role === 'admin')
    $('#user-view').classList.toggle('hidden', user.role === 'admin')
    $('#admin-view').classList.toggle('hidden', user.role !== 'admin')
    if (user.role === 'admin') {
      setAdminTab('instances')
      renderStats()
    } else {
      setUserTab('workspace')
      await renderUser()
    }
  } catch {
    me = null
    csrfToken = ''
    $$('.csrf-token').forEach((input) => { input.value = '' })
    showAuth()
    resetAuth()
  }
}

setInterval(async () => {
  if (!me) return
  if (me.role === 'admin') { renderStats(); if (!$('#panel-instances').classList.contains('hidden')) renderInstances(); if (!$('#panel-plugins').classList.contains('hidden')) renderPlugins(); if (!$('#panel-dsh-versions').classList.contains('hidden')) renderDshVersions() }
  else renderUser()
}, 6000)

hydrateIcons()
initThemePicker()
boot()
