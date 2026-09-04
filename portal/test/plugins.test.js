import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import Fastify from 'fastify'

const dir = mkdtempSync(join(tmpdir(), 'dsh-plugins-test-'))
process.env.DATA_DIR = dir
process.env.MODEL_GATEWAY_ENABLED = 'false'
const calls = []
let failInstall = false
let failRemove = false
let holdInstall
let inventory = []
const objects = new Map()
mock.module('../src/docker.js', { namedExports: {
  docker: async (args) => {
    calls.push(args)
    if (args[0] === 'run' && args.includes('--name')) objects.set(args[args.indexOf('--name') + 1], { Config: { Labels: { 'dsh.portal.managed': 'true' } }, State: { Running: true } })
    if (args[0] === 'rm') objects.delete(args.at(-1))
    if (args[0] === 'exec' && args.includes('flock')) {
      if (holdInstall) await holdInstall
      if (failInstall) throw new Error('upstream SECRET install failure')
    }
    if (args[0] === 'run' && args.includes('remove')) {
      if (failRemove) throw new Error('upstream SECRET remove failure')
      inventory = inventory.filter((plugin) => plugin.name !== args.at(-1))
    }
    if (args[0] === 'stop') objects.get(args.at(-1)).State.Running = false
    if (args[0] === 'start') objects.get(args.at(-1)).State.Running = true
    const stdout = args[0] === 'exec' && args.includes('node')
      ? '[{"name":"dshmarket","version":"1.41.0"}]'
      : args[0] === 'run' && args.includes('node') ? JSON.stringify(inventory) : ''
    return { stdout, stderr: '' }
  },
  inspectObject: async (kind, name) => kind === 'image' ? {} : objects.get(name) ?? null,
  missingObject: () => false, ensureNetwork: async () => ({}), applyFirewall: async () => {},
} })
const { db, createUser, createInstanceRow, getInstanceById, updateInstance } = await import('../src/db.js')
const plugins = await import('../src/plugins.js')
const { provision, applyDefaultPlugins, scanInstancePlugins, stopContainer, uninstallInstancePlugin } = await import('../src/orchestrator.js')
const { registerPluginAdmin } = await import('../src/plugin-admin.js')
const healthy = http.createServer((req, res) => res.end('ok'))
await new Promise((resolve) => healthy.listen(0, '127.0.0.1', resolve))
const admin = Fastify()
let id, userId
registerPluginAdmin(admin, {
  requireAdmin: (req, reply) => req.headers.authorization === 'admin' || (reply.code(403).send({ error: 'forbidden' }), false),
  requireUser: (req, reply) => req.headers.authorization === 'user' ? { id: userId } : (reply.code(401).send({ error: 'unauthorized' }), null),
})
test.beforeEach(() => {
  db.exec('DELETE FROM instance_plugin_inventory; DELETE FROM instance_plugins; DELETE FROM instances; DELETE FROM users; DELETE FROM settings;')
  calls.length = 0; objects.clear(); failInstall = false; failRemove = false; holdInstall = undefined
  inventory = [
    { name: 'dsh-context', version: '0.41.3', source: '^0.41.3', enabled: true },
    { name: 'dshmarket', version: '1.41.0', source: '^1.41.0', enabled: true },
  ]
  userId = Number(createUser({ username: 'plugin-user', name: 'Plugin user' }))
  id = Number(createInstanceRow({ userId, slug: 'plugin-user', containerName: 'dsh-plugin-user', hostPort: healthy.address().port }))
  objects.set('dsh-plugin-user', { Config: { Labels: { 'dsh.portal.managed': 'true' } }, State: { Running: true } })
  objects.set('dsh-plugin-user-home', {})
})
test.after(async () => { await admin.close(); await new Promise((resolve) => healthy.close(resolve)); db.close(); rmSync(dir, { recursive: true, force: true }) })

test('plugin command parser accepts npm specs and rejects shell, flags, paths, alternate profiles and duplicate packages', () => {
  assert.equal(plugins.parsePluginCommands('dsh plugin --profile web add dshmarket\n dsh plugin --profile web add @org/plugin@1.2.3-beta.1')[1].spec, '@org/plugin@1.2.3-beta.1')
  for (const value of [null, 'echo hi', 'dsh plugin --profile desktop add dshmarket', 'dsh plugin --profile web add x;reboot', 'dsh plugin --profile web add $(echo)', 'dsh plugin --profile web add x --ignore-scripts', 'dsh plugin --profile web add ../foo', 'dsh plugin --profile web add https://host/plugin.tgz', 'dsh plugin --profile web add x\ndsh plugin --profile web add x@1.0.0']) assert.throws(() => plugins.parsePluginCommands(value))
})

test('new instance installs defaults before completion; re-provision preserves volumes and does not reinstall an applied revision', async () => {
  plugins.savePluginDefaults('dsh plugin --profile web add dshmarket')
  await provision(id)
  assert.equal(plugins.pluginState(id).state, 'completed')
  assert.equal(getInstanceById(id).status, 'running')
  const install = calls.find((args) => args.includes('flock'))
  assert.deepEqual(install.slice(-6), ['dsh', 'plugin', '--profile', 'web', 'add', 'dshmarket'])
  assert.ok(install.includes('1000:1000') && install.includes('300s'))
  assert.ok(calls.some((args) => args[0] === 'restart'))
  await provision(id)
  assert.equal(calls.filter((args) => args.includes('flock')).length, 1)
  assert.ok(!calls.some((args) => args[0] === 'volume'))
})

test('failed install reports a sanitized retryable result and does not restart a working instance', async () => {
  await provision(id)
  objects.get('dsh-plugin-user').State.Running = false
  updateInstance(id, { status: 'stopped' })
  plugins.savePluginDefaults('dsh plugin --profile web add dshmarket')
  failInstall = true
  await plugins.queuePluginInstalls([id])
  assert.equal(plugins.pluginState(id).state, 'failed')
  assert.ok(!plugins.pluginState(id).message.includes('SECRET'))
  assert.ok(!calls.some((args) => args[0] === 'restart'))
  assert.equal(getInstanceById(id).status, 'running')
  assert.ok(calls.some((args) => args[0] === 'start'))
  failInstall = false
  await plugins.queuePluginInstalls([id])
  assert.equal(plugins.pluginState(id).state, 'completed')
})

test('duplicate submissions are coalesced and stop waits until installation and restart finish', async () => {
  await provision(id)
  plugins.savePluginDefaults('dsh plugin --profile web add dshmarket')
  let release
  holdInstall = new Promise((resolve) => { release = resolve })
  const work = plugins.queuePluginInstalls([id, id])
  while (!calls.some((args) => args.includes('flock'))) await new Promise((resolve) => setTimeout(resolve, 1))
  const stop = stopContainer('dsh-plugin-user')
  assert.ok(!calls.some((args) => args[0] === 'stop'))
  release(); await work; await stop
  assert.equal(calls.filter((args) => args.includes('flock')).length, 1)
  assert.ok(calls.findIndex((args) => args[0] === 'restart') < calls.findIndex((args) => args[0] === 'stop'))
})

test('deleted instances are skipped and interrupted persisted jobs require explicit retry', async () => {
  plugins.savePluginDefaults('dsh plugin --profile web add dshmarket')
  updateInstance(id, { status: 'deleting' })
  await plugins.queuePluginInstalls([id])
  assert.equal(plugins.pluginState(id).state, 'failed')
  assert.equal(calls.length, 0)
  plugins.recordPluginState(id, plugins.pluginDefaults(), 'running')
  plugins.recoverPluginJobs()
  assert.equal(plugins.pluginState(id).state, 'failed')
  assert.equal(plugins.pluginsBusy(), false)
})

test('admin validates commands and targets; clearing defaults does not run uninstall; config edits are blocked during jobs', async () => {
  assert.equal((await admin.inject({ url: '/api/admin/plugins' })).statusCode, 403)
  const post = (url, payload) => admin.inject({ method: 'POST', url, headers: { authorization: 'admin' }, payload })
  assert.equal((await post('/api/admin/plugins', { commands: 'rm -rf /' })).statusCode, 400)
  assert.equal((await post('/api/admin/plugins', { commands: 'dsh plugin --profile web add dshmarket' })).statusCode, 200)
  assert.equal((await post('/api/admin/plugins/apply', { instanceId: '1' })).statusCode, 400)
  assert.equal((await post('/api/admin/plugins/apply', { instanceId: 999 })).statusCode, 400)
  plugins.recordPluginState(id, plugins.pluginDefaults(), 'running')
  assert.equal((await post('/api/admin/plugins', { commands: '' })).statusCode, 409)
  plugins.recoverPluginJobs()
  assert.equal((await post('/api/admin/plugins', { commands: '' })).statusCode, 200)
  assert.equal(calls.length, 0)
})

test('plugin rescue reads a stopped-safe home volume, records inventory, uninstalls one package and restarts', async () => {
  const scanned = await scanInstancePlugins(id)
  assert.deepEqual(scanned.plugins.map((plugin) => plugin.name), ['dsh-context', 'dshmarket'])
  assert.equal(plugins.pluginInventory(id).plugins.length, 2)
  const result = await uninstallInstancePlugin(id, 'dsh-context')
  assert.equal(result.recovered, true)
  assert.deepEqual(result.plugins.map((plugin) => plugin.name), ['dshmarket'])
  const helper = calls.find((args) => args[0] === 'run' && args.includes('remove'))
  assert.notEqual(helper[helper.indexOf('--network') + 1], 'none')
  assert.ok(helper.includes('dsh.portal.helper=plugin-rescue'))
  assert.ok(helper.includes('type=volume,src=dsh-plugin-user-home,dst=/home/dsh'))
  assert.deepEqual(helper.slice(-6), ['dsh', 'plugin', '--profile', 'web', 'remove', 'dsh-context'])
  assert.ok(calls.findIndex((args) => args[0] === 'stop') < calls.indexOf(helper))
  assert.ok(calls.indexOf(helper) < calls.findIndex((args) => args[0] === 'start'))
})

test('users manage only their own inventory; protected defaults and failed removals retain the snapshot', async () => {
  const userGet = await admin.inject({ url: '/api/profile/plugins?refresh=1', headers: { authorization: 'user' } })
  assert.equal(userGet.statusCode, 200)
  assert.equal(userGet.json().plugins.find((plugin) => plugin.name === 'dshmarket').protected, true)
  const userPost = (packageName) => admin.inject({ method: 'POST', url: '/api/profile/plugins/uninstall', headers: { authorization: 'user' }, payload: { packageName } })
  assert.equal((await userPost('dshmarket')).statusCode, 400)
  assert.equal((await userPost('../escape')).statusCode, 400)
  failRemove = true
  assert.equal((await userPost('dsh-context')).statusCode, 500)
  assert.ok(plugins.pluginInventory(id).plugins.some((plugin) => plugin.name === 'dsh-context'))
  assert.equal((await admin.inject({ url: `/api/admin/plugins/inventory?instanceId=${id}&refresh=1`, headers: { authorization: 'admin' } })).statusCode, 200)
  assert.equal((await admin.inject({ method: 'POST', url: '/api/admin/plugins/uninstall', headers: { authorization: 'user' }, payload: { instanceId: id, packageName: 'dsh-context' } })).statusCode, 403)
})
