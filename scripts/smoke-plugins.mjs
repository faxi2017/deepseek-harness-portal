import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db, createUser, createInstanceRow, deleteUser, getInstanceById, updateInstance } from '../portal/src/db.js'
import { pluginDefaults, pluginState } from '../portal/src/plugins.js'
import { allocatePort, provision, applyDefaultPlugins, removeContainer } from '../portal/src/orchestrator.js'
import { docker } from '../portal/src/docker.js'
import { dshRpc } from '../portal/src/gateway-dsh.js'

if (!pluginDefaults().commands) throw new Error('Save default plugin commands in admin first')
const slug = `plugin-smoke-${randomUUID().slice(0, 8)}`
const name = `dsh-${slug}`
const userId = Number(createUser({ username: slug, name: 'Disposable plugin test' }))
let instanceId
try {
  instanceId = Number(createInstanceRow({ userId, slug, containerName: name, hostPort: await allocatePort() }))
  await provision(instanceId)
  const instance = getInstanceById(instanceId)
  assert.equal(instance.status, 'running')
  assert.equal(pluginState(instanceId).state, 'completed')
  const installed = JSON.parse(pluginState(instanceId).installed)
  assert.ok(installed.length > 0)
  const snapshot = await dshRpc(instance.host_port, 'settings.describe', {})
  const ns = snapshot.namespaces.find((n) => n.ns === 'llm-pi-ai')
  await dshRpc(instance.host_port, 'credentials.set', { ref: 'PLUGIN_SMOKE_PERSONAL_KEY', value: 'personal-fixture-only' })
  await dshRpc(instance.host_port, 'settings.mutate', { ns: ns.ns, expectedRevision: ns.revision,
    ops: [{ op: 'set', path: ['providers', 'plugin-personal-test'], value: { displayName: 'Personal fixture', api: 'openai-completions',
      baseURL: 'https://personal.example/v1', apiKeyEnv: 'PLUGIN_SMOKE_PERSONAL_KEY', models: [{ id: 'personal-model' }] } }] })
  const defaults = snapshot.namespaces.find((n) => n.ns === 'agent-default-model')
  await dshRpc(instance.host_port, 'settings.mutate', { ns: defaults.ns, expectedRevision: defaults.revision,
    ops: [{ op: 'set', path: ['provider'], value: 'plugin-personal-test' }, { op: 'set', path: ['model'], value: 'personal-model' }] })
  await docker(['exec', name, 'node', '-e', "require('fs').writeFileSync('/workspace/plugin-smoke-marker','retained')"])
  await applyDefaultPlugins(instanceId)
  assert.equal(pluginState(instanceId).state, 'completed')
  const beforeId = (await docker(['inspect', '--format', '{{.Id}}', name])).stdout.trim()
  const appliedAt = pluginState(instanceId).updated_at
  await provision(instanceId)
  assert.notEqual((await docker(['inspect', '--format', '{{.Id}}', name])).stdout.trim(), beforeId)
  assert.equal(pluginState(instanceId).updated_at, appliedAt)
  const after = await dshRpc(instance.host_port, 'settings.describe', {})
  assert.equal(after.namespaces.find((n) => n.ns === 'agent-default-model').value.provider, 'plugin-personal-test')
  assert.equal(after.namespaces.find((n) => n.ns === 'llm-pi-ai').value.providers['plugin-personal-test'].apiKeyEnv, 'PLUGIN_SMOKE_PERSONAL_KEY')
  assert.equal((await docker(['exec', name, 'cat', '/workspace/plugin-smoke-marker'])).stdout, 'retained')
  const { stdout } = await docker(['exec', name, 'node', '-e', "const fs=require('fs');const p=JSON.parse(fs.readFileSync('/home/dsh/.dsh/profiles/web/package.json'));console.log(JSON.stringify(p.dsh.profile.bundles))"])
  for (const plugin of installed) assert.ok(JSON.parse(stdout).includes(plugin.name))
  if (installed.some((p) => p.name === 'dshmarket')) assert.ok(after.namespaces.some((n) => n.ns === 'dsh-market'))
  console.log(JSON.stringify({ installed, newInstanceDefaults: true, reinstallAndRestart: true,
    reprovisionPreservedPlugins: true, personalModelAndDefaultPreserved: true, workspacePreserved: true }, null, 2))
} finally {
  if (instanceId) updateInstance(instanceId, { status: 'deleting' })
  await removeContainer(name)
  db.prepare('DELETE FROM instance_plugins WHERE instance_id=?').run(instanceId ?? -1)
  for (const table of ['gateway_requests', 'gateway_users']) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(userId)
  }
  deleteUser(userId)
  db.close()
}
