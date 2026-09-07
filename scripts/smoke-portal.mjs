import assert from 'node:assert/strict'

const origin = new URL(process.argv[2] ?? process.env.PORTAL_ORIGIN)
const username = process.env.ADMIN_NAME ?? 'admin'
const password = process.env.ADMIN_PASSWORD
if (!password) throw new Error('ADMIN_PASSWORD is required')

const login = await fetch(new URL('/api/auth/login', origin), {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: origin.origin },
  body: JSON.stringify({ username, password }),
  redirect: 'manual',
})
assert.equal(login.status, 200, 'administrator login succeeds')
const portalCookie = login.headers.getSetCookie()[0]?.split(';', 1)[0]
assert.ok(portalCookie, 'portal session cookie is returned')

const instancesResponse = await fetch(new URL('/api/admin/instances', origin), {
  headers: { cookie: portalCookie },
})
assert.equal(instancesResponse.status, 200, 'instance inventory is available')
const instances = await instancesResponse.json()
const instance = instances.instances?.find((item) => item.username === 'fangxi') ?? instances.instances?.[0]
assert.ok(instance?.url, 'an instance is available for launch testing')

const launchUrl = new URL(instance.url)
launchUrl.searchParams.set('portal_bootstrap', '1')
const bootstrap = await fetch(launchUrl, { headers: { cookie: portalCookie }, redirect: 'manual' })
if (![200, 302, 303].includes(bootstrap.status)) {
  throw new Error(`DSH launch failed (${bootstrap.status}): ${(await bootstrap.text()).slice(0, 200)}`)
}
const authenticated = bootstrap.status !== 200
const dshCookie = bootstrap.headers.getSetCookie()[0]?.split(';', 1)[0]
if (authenticated) assert.ok(dshCookie, 'DSH authentication cookie is returned')
const page = authenticated ? await fetch(new URL(bootstrap.headers.get('location') ?? '/', launchUrl), {
  headers: { cookie: `${portalCookie}; ${dshCookie}` },
}) : bootstrap
assert.equal(page.status, 200, 'authenticated DSH page loads')
const html = await page.text()
assert.match(html, /<html|<!doctype/i, 'DSH returns HTML')
assert.match(html, /__portal\/dsh-host\.js/, 'Portal transport bootstrap is injected')

console.log(JSON.stringify({
  portal: origin.origin,
  instance: instance.slug,
  status: instance.status,
  authentication: authenticated ? 'token-cookie' : 'legacy-tokenless',
  pageStatus: page.status,
  transportBootstrap: true,
}, null, 2))
