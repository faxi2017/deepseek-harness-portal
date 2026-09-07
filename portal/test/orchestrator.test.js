import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
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
let dockerLogs = ''
mock.module('../src/docker.js', { namedExports: {
  docker: async (args) => {
    calls.push(args)
    if (args[0] === 'logs') return { stdout: dockerLogs, stderr: '' }
    if (args[0] === 'rm') objects.delete(`container:${args.at(-1)}`)
    if (args[0] === 'volume' && args[1] === 'rm') {
      if (removalFailure) throw new Error('volume is in use')
      objects.delete(`volume:${args.at(-1)}`)
    }
    if (args[0] === 'start' || args[0] === 'stop' || args[0] === 'restart') {
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
const { createContainer, dshWebToken, removeContainerKeepVolumes, removeContainer, restartContainer, startContainer, stopContainer, waitHealthy } = await import('../src/orchestrator.js')
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
  await Promise.all([startContainer('dsh-alice'), restartContainer('dsh-alice'), stopContainer('dsh-alice'), startContainer('dsh-alice')])
  assert.equal(maxActive, 1)
  const restart = calls.find((args) => args[0] === 'restart')
  assert.deepEqual(restart, ['restart', '-t', '15', 'dsh-alice'])
})

test('token-protected DSH endpoints are considered ready', async () => {
  const server = http.createServer((_req, res) => res.writeHead(401).end())
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address()
    assert.equal(await waitHealthy(port, 100), true)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('health check waits for the core LLM route after the web server starts', async () => {
  dockerLogs = `dsh web: http://127.0.0.1:3000/?token=${'t'.repeat(43)}\n`
  let probes = 0
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/api/llm/listProviders')
    assert.equal(req.method, 'POST')
    res.writeHead(++probes < 2 ? 404 : 401).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address()
    assert.equal(await waitHealthy(port, 2500, 'dsh-alice'), true)
    assert.equal(probes, 2)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('legacy tokenless DSH uses its HTTP root when the newer RPC is absent', async () => {
  dockerLogs = ''
  const server = http.createServer((req, res) => res.writeHead(req.url === '/' ? 200 : 404).end())
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    assert.equal(await waitHealthy(server.address().port, 100, 'dsh-alice'), true)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('DSH bootstrap token is read from the latest canonical startup log', async () => {
  const oldToken = 'a'.repeat(43)
  const currentToken = 'b'.repeat(43)
  dockerLogs = `dsh web: http://127.0.0.1:3000/?token=${oldToken} (LAN: http://172.20.0.2:3000/?token=${oldToken})\n`
    + `ignored token=${'c'.repeat(43)}\n`
    + `dsh web: http://127.0.0.1:3000/?token=${currentToken} (LAN: http://172.20.0.2:3000/?token=${currentToken})\n`
  assert.equal(await dshWebToken('dsh-alice'), currentToken)
})

test.after(() => {
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})
