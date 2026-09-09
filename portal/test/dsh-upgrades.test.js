import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'dsh-upgrade-test-'))
const oldImage = `sha256:${'a'.repeat(64)}`
const newImage = `sha256:${'b'.repeat(64)}`
Object.assign(process.env, {
  DATA_DIR: dataDir, DSH_IMAGE: oldImage, INSTANCE_START_TIMEOUT_MS: '80',
  DOCKER_COMMAND_TIMEOUT_MS: '1000', INSTANCE_NETWORK: 'upgrade-test-network',
})

const calls = []
const containers = new Map()
const volumes = new Set()
let candidateHealthy = false
mock.module('../src/docker.js', { namedExports: {
  docker: async (args) => {
    calls.push(args)
    if (args[0] === 'run' && args.includes('-d')) {
      const name = args[args.indexOf('--name') + 1]
      for (const mount of args.filter((arg) => arg.includes(':/home/dsh') || arg.includes(':/workspace'))) {
        volumes.add(mount.split(':')[0])
      }
      containers.set(name, { Config: { Labels: { 'dsh.portal.managed': 'true' } }, State: { Running: true }, Image: args.at(-1) })
    }
    if (args[0] === 'rm') containers.delete(args.at(-1))
    if (args[0] === 'stop') containers.get(args.at(-1)).State.Running = false
    if (args[0] === 'start') containers.get(args.at(-1)).State.Running = true
    if (args[0] === 'volume' && args[1] === 'create') volumes.add(args.at(-1))
    if (args[0] === 'volume' && args[1] === 'rm') volumes.delete(args.at(-1))
    return { stdout: '', stderr: '' }
  },
  inspectObject: async (kind, name) => {
    if (kind === 'container') return containers.get(name) ?? null
    if (kind === 'volume') return volumes.has(name) ? {} : null
    if (kind === 'image' && [oldImage, newImage].includes(name)) return { Id: name, Config: { Labels: {} } }
    return null
  },
  missingObject: () => false,
  ensureNetwork: async () => ({}),
  applyFirewall: async () => {},
} })

const { db, createDshRelease, createInstanceRow, createUser, getDefaultDshRelease, getDshUpgrade, getInstanceById, updateInstance } = await import('../src/db.js')
const { containerName, scheduleDshUpgrade } = await import('../src/orchestrator.js')

async function until(predicate, timeout = 2_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for upgrade')
}

test('an unhealthy target release restores the original image and two volume snapshots', async () => {
  const port = 28651
  const userId = createUser({ username: 'alice', name: 'Alice' })
  const oldRelease = getDefaultDshRelease()
  const targetRelease = createDshRelease({ version: '9.9.9', imageId: newImage })
  const slug = 'alice'
  const name = containerName(slug)
  const instanceId = Number(createInstanceRow({ userId, slug, containerName: name, hostPort: port, releaseId: oldRelease.id }))
  updateInstance(instanceId, { status: 'running' })
  volumes.add(`${name}-home`); volumes.add(`${name}-workspace`)
  containers.set(name, { Config: { Labels: { 'dsh.portal.managed': 'true' } }, State: { Running: true }, Image: oldImage })
  const health = http.createServer((_req, res) => {
    const image = containers.get(name)?.Image
    res.statusCode = image === oldImage || candidateHealthy ? 200 : 503
    res.end()
  })
  await new Promise((resolve) => health.listen(port, '127.0.0.1', resolve))
  try {
    const upgrade = scheduleDshUpgrade(instanceId, targetRelease.id, { requestedBy: userId })
    const completed = await until(() => {
      const row = getDshUpgrade(upgrade.id)
      return row.status !== 'running' && row
    })
    assert.equal(completed.status, 'rolled_back')
    assert.equal(getInstanceById(instanceId).release_id, oldRelease.id)
    assert.equal(containers.get(name).Image, oldImage)
    assert.ok(calls.some((args) => args[0] === 'volume' && args[1] === 'create' && args.at(-1).endsWith('-home-backup')))
    assert.ok(calls.some((args) => args[0] === 'volume' && args[1] === 'create' && args.at(-1).endsWith('-workspace-backup')))
    const backupCopy = calls.find((args) => args[0] === 'run'
      && args.some((arg) => arg.includes('dst=/source')))
    assert.deepEqual(backupCopy.filter((arg) => ['DAC_OVERRIDE', 'CHOWN', 'FOWNER'].includes(arg)),
      ['DAC_OVERRIDE', 'CHOWN', 'FOWNER'])
  } finally {
    await new Promise((resolve) => health.close(resolve))
  }
})

test.after(() => {
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})
