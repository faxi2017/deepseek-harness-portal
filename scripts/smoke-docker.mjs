// Uses disposable containers/volumes and a temporary SQLite DB; keeps the dedicated network.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'dsh-smoke-'))
process.env.DATA_DIR = dataDir
const { config } = await import('../portal/src/config.js')
const { db } = await import('../portal/src/db.js')
const { docker } = await import('../portal/src/docker.js')
const { verifyDockerRuntime, createContainer, removeContainer, removeContainerKeepVolumes,
  waitHealthy, allocatePort, stopContainer, startContainer } = await import('../portal/src/orchestrator.js')
const slug = `smoke-${Date.now()}`
const name = `dsh-${slug}`
const siblingSlug = `${slug}-sibling`
const siblingName = `dsh-${siblingSlug}`
try {
  await verifyDockerRuntime()
  const hostPort = await allocatePort()
  await createContainer({ slug, hostPort })
  assert.ok(await waitHealthy(hostPort, 90000), 'DSH becomes healthy')
  const { stdout: version } = await docker(['exec', name, 'dsh', '--version'])
  console.log(`DSH version: ${version.trim()}`)
  await docker(['exec', name, 'sh', '-c', 'printf persistent > /workspace/smoke.txt; printf home > /home/dsh/smoke.txt'])
  const siblingPort = await allocatePort()
  await createContainer({ slug: siblingSlug, hostPort: siblingPort })
  assert.ok(await waitHealthy(siblingPort, 90000), 'sibling is reachable from host')
  const sibling = JSON.parse((await docker(['container', 'inspect', siblingName])).stdout)[0]
  const siblingIp = sibling.NetworkSettings.Networks[config.instanceNetwork].IPAddress
  await assert.rejects(docker(['exec', name, 'curl', '--max-time', '3', '-fsS', `http://${siblingIp}:3000`]), 'healthy sibling is isolated')
  await assert.rejects(docker(['exec', siblingName, 'cat', '/workspace/smoke.txt']), 'workspace is not shared')
  const { stdout: publicStatus } = await docker(['exec', name, 'curl', '--max-time', '15', '-s', '-o', '/dev/null', '-w', '%{http_code}', 'https://registry.npmjs.org/'])
  assert.equal(publicStatus, '200', 'public HTTPS egress works')
  const network = JSON.parse((await docker(['network', 'inspect', config.instanceNetwork])).stdout)[0]
  await assert.rejects(docker(['exec', name, 'curl', '--max-time', '3', '-s', `http://${network.IPAM.Config[0].Gateway}:7000`]), 'host access is blocked')
  await assert.rejects(docker(['exec', name, 'curl', '--max-time', '3', '-s', 'http://10.0.9.175:8080']), 'LAN access is blocked')
  await stopContainer(name)
  await startContainer(name)
  assert.ok(await waitHealthy(hostPort, 90000), 'stopped instance restarts')
  await removeContainerKeepVolumes(name)
  await createContainer({ slug, hostPort })
  assert.ok(await waitHealthy(hostPort, 90000), 'recreated instance becomes healthy')
  const { stdout: workspace } = await docker(['exec', name, 'cat', '/workspace/smoke.txt'])
  const { stdout: home } = await docker(['exec', name, 'cat', '/home/dsh/smoke.txt'])
  assert.equal(workspace, 'persistent')
  assert.equal(home, 'home')
  console.log('PASS: health, stop/start, reprovision persistence, sibling isolation, public egress and private-network rejection')
} finally {
  await removeContainer(siblingName)
  await removeContainer(name)
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
}
