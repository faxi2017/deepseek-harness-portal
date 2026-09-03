import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { config } from '../portal/src/config.js'
import { db, createUser, createInstanceRow, deleteUser, getInstanceById } from '../portal/src/db.js'
import { allModels, savePolicy, decrypt, getPolicy, usage, rotateToken } from '../portal/src/gateway-store.js'
import { syncDsh, dshRpc } from '../portal/src/gateway-dsh.js'
import { allocatePort, provision, removeContainer } from '../portal/src/orchestrator.js'
import { docker, ensureNetwork, applyFirewall } from '../portal/src/docker.js'

if (!config.gatewayEnabled) throw new Error('Enable MODEL_GATEWAY_ENABLED and start Portal first')
const model = allModels().find((m) => m.enabled && !m.sync_error && m.upstream_model === (process.argv[2] ?? 'MiniMax-M3'))
if (!model) throw new Error('Configure and sync the smoke-test model in admin first')
await applyFirewall(await ensureNetwork())
const suffix = randomUUID().slice(0, 8)
const slug = `gateway-smoke-${suffix}`
const name = `dsh-${slug}`
const userId = Number(createUser({ username: slug, name: 'Gateway disposable smoke test' }))
let instanceId
try {
  instanceId = Number(createInstanceRow({ userId, slug, containerName: name, hostPort: await allocatePort() }))
  savePolicy(userId, { enabled: true, dailyTokens: 200000, models: [model.id] })
  await provision(instanceId)
  const instance = getInstanceById(instanceId)
  assert.equal(instance.status, 'running')
  const snapshot = await dshRpc(instance.host_port, 'settings.describe', {})
  const ns = snapshot.namespaces.find((n) => n.ns === 'llm-pi-ai')
  await dshRpc(instance.host_port, 'credentials.set', { ref: 'PERSONAL_TEST_KEY', value: 'personal-test-only' })
  await dshRpc(instance.host_port, 'settings.mutate', { ns: ns.ns, expectedRevision: ns.revision,
    ops: [{ op: 'set', path: ['providers', 'personal-test'], value: { displayName: 'Personal test', api: 'openai-completions',
      baseURL: 'https://personal.example/v1', apiKeyEnv: 'PERSONAL_TEST_KEY', models: [{ id: 'personal-model' }] } }] })
  await docker(['exec', name, 'sh', '-c', 'printf retained > /workspace/gateway-smoke-marker'])
  await syncDsh(userId, { setDefault: true })
  const call = async (stream = false, key = decrypt(getPolicy(userId).secret)) => {
    // Only the test user's gateway token enters this test container. The provider key stays in Bifrost.
    const { stdout } = await docker(['exec', name, 'node', '-e', `
      (async()=>{const r=await fetch(process.argv[1]+'/chat/completions',{method:'POST',headers:{authorization:'Bearer '+process.argv[2],'content-type':'application/json'},
      body:JSON.stringify({model:process.argv[3],messages:[{role:'user',content:'Reply with OK only.'}],max_tokens:128,stream:process.argv[4]==='true'})});
      const text=await r.text();const events=text.split('\\n').filter(l=>l.startsWith('data: {')).map(l=>JSON.parse(l.slice(6)));
      const j=process.argv[4]==='true'&&r.ok?events.findLast(e=>e.usage):JSON.parse(text);
      console.log(JSON.stringify({status:r.status,usage:j?.usage,done:text.includes('[DONE]'),error:!!j?.error}));})().catch(()=>process.exit(1))`,
      config.gatewayTenantUrl, key, model.id, String(stream)], { timeout: 180000 })
    return JSON.parse(stdout)
  }
  const plain = await call()
  assert.equal(plain.status, 200)
  assert.ok(plain.usage?.total_tokens > 0)
  const stream = await call(true)
  assert.equal(stream.status, 200)
  assert.ok(stream.done && stream.usage?.total_tokens > 0)
  const charged = plain.usage.prompt_tokens + plain.usage.completion_tokens + stream.usage.prompt_tokens + stream.usage.completion_tokens
  assert.equal(usage(userId).chargedTokens, charged)
  savePolicy(userId, { enabled: true, dailyTokens: charged, models: [model.id] })
  assert.equal((await call()).status, 429)
  const oldKey = decrypt(getPolicy(userId).secret)
  rotateToken(userId)
  assert.equal((await call(false, oldKey)).status, 401)
  savePolicy(userId, { enabled: true, dailyTokens: 200000, models: [model.id] })
  await syncDsh(userId)
  const beforeUpgrade = await dshRpc(instance.host_port, 'settings.describe', {})
  const defaultNamespace = beforeUpgrade.namespaces.find((n) => n.ns === 'agent-default-model')
  await dshRpc(instance.host_port, 'settings.mutate', { ns: defaultNamespace.ns, expectedRevision: defaultNamespace.revision,
    ops: [{ op: 'set', path: ['provider'], value: 'personal-test' }, { op: 'set', path: ['model'], value: 'personal-model' }] })
  // An unsynced credential rotation must not make an upgrade reset the user's chosen model.
  rotateToken(userId)
  // The existing image is rebuilt into a fresh container with the exact same persistent volumes.
  // A new DSH image follows this same lifecycle; arbitrary future DSH schema changes cannot be certified here.
  await provision(instanceId)
  const after = await dshRpc(instance.host_port, 'settings.describe', {})
  const providers = after.namespaces.find((n) => n.ns === 'llm-pi-ai').value.providers
  assert.equal(providers['personal-test'].apiKeyEnv, 'PERSONAL_TEST_KEY')
  assert.equal(providers['personal-test'].baseURL, 'https://personal.example/v1')
  assert.equal(providers['portal-gateway'].models[0].id, model.id)
  assert.equal(after.namespaces.find((n) => n.ns === 'agent-default-model').value.provider, 'personal-test')
  assert.equal((await docker(['exec', name, 'cat', '/workspace/gateway-smoke-marker'])).stdout, 'retained')
  const { stdout: isolation } = await docker(['exec', name, 'node', '-e', `
    (async()=>{for(const url of process.argv.slice(1)){try{const r=await fetch(url,{signal:AbortSignal.timeout(2000)});console.log(r.status)}catch{console.log('blocked')}}})()`,
    'http://192.168.60.210:3000/v1/models', 'http://host.docker.internal:7000/api/admin/gateway', 'http://host.docker.internal:14000/api/providers'])
  assert.deepEqual(isolation.trim().split(/\r?\n/), ['blocked', 'blocked', 'blocked'])
  console.log(JSON.stringify({ model: model.name, plain: plain.usage, stream: stream.usage, chargedTokens: charged,
    quotaRejection: 429, revokedKeyRejection: 401, personalConfigurationPreserved: true,
    personalDefaultPreservedAfterRotationAndReprovision: true,
    reprovisionPreservedVolumes: true, privateNetworkIsolation: true }, null, 2))
} finally {
  // Names and IDs are generated above for this smoke run; no existing user or volume is selected.
  await removeContainer(name)
  db.prepare('DELETE FROM gateway_requests WHERE user_id=?').run(userId)
  db.prepare('DELETE FROM gateway_users WHERE user_id=?').run(userId)
  deleteUser(userId)
  db.close()
}
