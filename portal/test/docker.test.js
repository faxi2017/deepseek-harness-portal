import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { promisify } from 'node:util'

const calls = []
let handler
const execFile = () => {}
execFile[promisify.custom] = async (command, args, options) => {
  assert.equal(command, 'docker')
  calls.push({ args, options })
  return handler(args)
}
mock.module('node:child_process', { namedExports: { execFile } })
const { config } = await import('../src/config.js')
const { inspectObject, ensureNetwork, applyFirewall } = await import('../src/docker.js')

test('Docker inspect distinguishes missing objects from daemon/permission failure', async () => {
  handler = async () => { throw { stderr: 'Error response from daemon: No such container: absent' } }
  assert.equal(await inspectObject('container', 'absent'), null)
  handler = async () => { throw new Error('permission denied connecting to Docker') }
  await assert.rejects(inspectObject('volume', 'data'), /permission denied/)
})

function validNetwork() {
  return { Driver: 'bridge', EnableIPv6: false, Internal: false,
    Labels: { 'dsh.portal.managed': 'true' },
    Options: { 'com.docker.network.bridge.enable_icc': 'false', 'com.docker.network.bridge.host_binding_ipv4': '127.0.0.1' },
    IPAM: { Config: [{ Subnet: '172.30.0.0/16' }] } }
}

test('existing shared, IPv6, or unrestricted networks are refused', async () => {
  for (const change of [{ Labels: {} }, { EnableIPv6: true }, { Options: {} }, { Driver: 'host' }]) {
    handler = async () => ({ stdout: JSON.stringify([{ ...validNetwork(), ...change }]) })
    await assert.rejects(ensureNetwork(), /isolation settings/)
  }
  handler = async () => ({ stdout: JSON.stringify([validNetwork()]) })
  assert.equal((await ensureNetwork()).Driver, 'bridge')
})

test('firewall helper is bounded and errors propagate before service startup', async () => {
  handler = async () => { throw new Error('DOCKER-USER unavailable') }
  await assert.rejects(applyFirewall(validNetwork()), /DOCKER-USER/)
  const { args, options } = calls.at(-1)
  assert.ok(args.includes('NET_ADMIN'))
  assert.ok(!args.includes('--privileged'))
  assert.ok(args.some((arg) => arg.endsWith(':/opt/dsh/tenant-firewall.sh:ro')))
  assert.ok(!args.some((arg) => arg.includes('docker.sock')))
  assert.equal(options.timeout, config.dockerCommandTimeoutMs)
  assert.equal(args.at(-1), '172.30.0.0/16')
})
