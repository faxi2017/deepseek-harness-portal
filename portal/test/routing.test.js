import test from 'node:test'
import assert from 'node:assert/strict'
import { config, validateConfig } from '../src/config.js'
import { instanceHostPort, instanceUrl, trustedInstanceRequest } from '../src/routing.js'

Object.assign(config, { portalOrigin: 'http://10.0.9.175:7000', domain: '10.0.9.175',
  instanceRouting: 'ports', instancePortStart: 7001, portRangeStart: 18000, portRangeEnd: 18100 })
const inst = { slug: 'alice', host_port: 18000 }

test('public ports select internal slots without depending on Host input', () => {
  assert.equal(instanceUrl(inst), 'http://10.0.9.175:7001')
  assert.equal(instanceUrl({ ...inst, host_port: 18001 }), 'http://10.0.9.175:7002')
  assert.equal(instanceHostPort(7001), 18000)
  assert.equal(instanceHostPort(7000), null)
  assert.equal(instanceHostPort(7102), null)
})

test('tenant APIs and websockets reject sibling origins and forged hosts', () => {
  const headers = { host: '10.0.9.175:7001', origin: 'http://10.0.9.175:7001' }
  assert.equal(trustedInstanceRequest({ method: 'POST', headers }, inst), true)
  assert.equal(trustedInstanceRequest({ method: 'POST', headers: { ...headers, origin: 'http://10.0.9.175:7002' } }, inst), false)
  assert.equal(trustedInstanceRequest({ method: 'GET', headers: { host: headers.host } }, inst), true)
  assert.equal(trustedInstanceRequest({ method: 'POST', headers: { host: headers.host } }, inst), false)
  assert.equal(trustedInstanceRequest({ method: 'GET', headers: { host: headers.host } }, inst, { upgrade: true }), false)
  assert.equal(trustedInstanceRequest({ method: 'GET', headers: { ...headers, host: 'evil.test:7001' } }, inst), false)
})

test('overlapping public and internal ranges are rejected', () => {
  Object.assign(config, { smtp: { ...config.smtp, host: 'smtp.example.test', from: 'portal@example.test' },
    image: `sha256:${'a'.repeat(64)}`, instancePortStart: 18000 })
  assert.throws(validateConfig, /must not overlap/)
  config.instancePortStart = 7001
})
