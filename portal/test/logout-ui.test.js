import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext, runInContext } from 'node:vm'

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')

async function setup(logoutResponse) {
  const elements = new Map()
  const makeElement = () => ({
    listeners: {}, innerHTML: '退出登录', disabled: false, style: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {} }, reset() {},
    addEventListener(name, handler) { this.listeners[name] = handler },
    appendChild(child) { this.children.push(child) },
    querySelectorAll() { return [] },
    querySelector() { return this.button ??= makeElement() },
  })
  const forms = [makeElement(), makeElement()]
  const themeSelects = [makeElement(), makeElement()]
  const themeRoot = { dataset: {} }
  const stored = new Map()
  const requests = []
  const navigations = []
  const context = {
    document: {
      documentElement: themeRoot,
      querySelector(selector) {
        if (!elements.has(selector)) elements.set(selector, makeElement())
        return elements.get(selector)
      },
      querySelectorAll: (selector) => selector === '.logout-form' ? forms : selector === '[data-theme-select]' ? themeSelects : [],
      addEventListener() {}, removeEventListener() {}, createElement: makeElement,
    },
    setInterval() {}, setTimeout() {},
    window: { location: { replace: (url) => navigations.push(url) } },
    localStorage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    fetch: async (url, options) => {
      if (url === '/api/config') return { ok: true, json: async () => ({}) }
      if (url === '/api/auth/me') return { ok: false, json: async () => ({ error: 'not authenticated' }) }
      requests.push({ url, options })
      return logoutResponse()
    },
  }
  runInNewContext(source, context)
  await new Promise((resolve) => setImmediate(resolve))
  runInContext("csrfToken = 'test-csrf'", context)
  return { forms, requests, navigations, elements, stored, themeRoot, themeSelects }
}

test('theme picker follows the system by default and synchronizes manual choices', async () => {
  const { stored, themeRoot, themeSelects } = await setup(async () => ({ ok: true, json: async () => ({}) }))
  assert.equal(themeRoot.dataset.systemTheme, 'dark')
  assert.equal(themeSelects[0].value, 'system')
  assert.equal(themeSelects[1].value, 'system')

  themeSelects[0].value = 'light'
  themeSelects[0].listeners.change()
  assert.equal(themeRoot.dataset.theme, 'light')
  assert.equal(themeRoot.dataset.systemTheme, undefined)
  assert.equal(themeSelects[1].value, 'light')
  assert.equal(stored.get('dsh-portal-theme'), 'light')
})

test('both logout forms prevent native navigation and POST before returning home', async () => {
  const { forms, requests, navigations } = await setup(async () => ({
    ok: true, json: async () => { throw new SyntaxError('redirected to HTML') },
  }))
  for (const form of forms) {
    assert.equal(typeof form.listeners.submit, 'function')
    let prevented = false
    const pending = form.listeners.submit({ target: form, preventDefault() { prevented = true } })
    assert.equal(prevented, true)
    assert.equal(form.button.disabled, true)
    await pending
    assert.equal(form.button.disabled, false)
    const { url, options } = requests.at(-1)
    assert.equal(url, '/api/auth/logout')
    assert.equal(options.method, 'POST')
    assert.equal(options.credentials, 'same-origin')
    assert.deepEqual(JSON.parse(options.body), { _csrf: 'test-csrf' })
    assert.equal(navigations.at(-1), '/')
  }
  assert.equal(requests.length, 2)
})

test('user restart keeps its button reference after confirmation and sends the request', async () => {
  const { elements, requests } = await setup(async () => ({ ok: true, json: async () => ({ ok: true }) }))
  const button = elements.get('#i-restart')
  const event = { currentTarget: button }
  const pending = button.listeners.click(event)
  event.currentTarget = null
  elements.get('#modal-root').button.listeners.click()
  await pending
  const restart = requests.find((request) => request.url === '/api/instance/restart')
  assert.equal(restart.options.method, 'POST')
  assert.equal(button.disabled, false)
  assert.equal(button.innerHTML, '退出登录')
})

for (const failure of ['csrf', 'network']) {
  test(`logout ${failure} failure stays on the page and restores the button`, async () => {
    const { forms, navigations, elements } = await setup(async () => {
      if (failure === 'network') throw new Error('offline')
      return { ok: false, json: async () => ({ error: 'invalid CSRF token' }) }
    })
    assert.equal(typeof forms[0].listeners.submit, 'function')
    await forms[0].listeners.submit({ target: forms[0], preventDefault() {} })
    assert.deepEqual(navigations, [])
    assert.equal(forms[0].button.disabled, false)
    assert.equal(forms[0].button.innerHTML, '退出登录')
    assert.match(elements.get('#toasts').children[0].innerHTML,
      failure === 'csrf' ? /登录验证已过期/ : /无法连接服务/)
  })
}
