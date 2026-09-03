import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'dsh-docker-test-'))
process.env.DATA_DIR = dataDir
const calls = []
const objects = new Map()
let removalFailure = false
let active = 0
let maxActive = 0
mock.module('../src/docker.js', { namedExports: {
  docker: async (args) => {
    calls.push(args)
    if (args[0] === 'rm') objects.delete(`container:${args.at(-1)}`)
    if (args[0] === 'volume' && args[1] === 'rm') {
      if (removalFailure) throw new Error('volume is in use')
      objects.delete(`volume:${args.at(-1)}`)
    }
    if (args[0] === 'start' || args[0] === 'stop') {
      maxActive = Math.max(maxActive, ++active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active--
    }
    return { stdout: '', stderr: '' }
  },
  inspectObject: async (kind, name) => objects.get(`${kind}:${name}`) ?? null,
  missingObject: () => false,
  ensureNetwork: async () => ({}),
  applyFirewall: async () => {},
} })
const { createContainer, removeContainerKeepVolumes, removeContainer, startContainer, stopContainer } = await import('../src/orchestrator.js')
const { db } = await import('../src/db.js')

test('creation uses Docker-compatible logging, limits, loopback publication and private volumes', async () => {
  await createContainer({ slug: 'alice', hostPort: 18000 })
  const args = calls.at(-1)
  assert.equal(args[0], 'run')
  for (const value of ['local', 'max-file=3', '127.0.0.1:18000:3000', '--read-only', 'no-new-privileges', '1000:1000', '--pids-limit', 'dsh-alice-home:/home/dsh', 'dsh-alice-workspace:/workspace']) assert.ok(args.includes(value), value)
  assert.ok(!args.includes('--privileged'))
})

test('reprovision cleanup retains volumes; destructive deletion propagates a volume failure', async () => {
  objects.set('container:dsh-alice', {})
  objects.set('volume:dsh-alice-home', {})
  objects.set('volume:dsh-alice-workspace', {})
  await removeContainerKeepVolumes('dsh-alice')
  assert.ok(objects.has('volume:dsh-alice-home'))
  assert.ok(objects.has('volume:dsh-alice-workspace'))
  removalFailure = true
  await assert.rejects(removeContainer('dsh-alice'), /volume is in use/)
  assert.ok(objects.has('volume:dsh-alice-home'))
  removalFailure = false
  await removeContainer('dsh-alice')
  assert.equal(objects.size, 0)
})

test('lifecycle operations on the same tenant remain serialized', async () => {
  await Promise.all([startContainer('dsh-alice'), stopContainer('dsh-alice'), startContainer('dsh-alice')])
  assert.equal(maxActive, 1)
})

test.after(() => {
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})
