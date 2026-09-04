import net from 'node:net'
import http from 'node:http'
import { config } from './config.js'
import { db, getInstanceById, updateInstanceUnlessDeleting } from './db.js'

import { docker, inspectObject, missingObject, ensureNetwork, applyFirewall } from './docker.js'
import {
  installPluginCommands, pluginDefaults, pluginState, recordPluginInventory,
  recordPluginState, validPluginName,
} from './plugins.js'
const runningCache = new Map()
const lifecycleLocks = new Map()
const RUNNING_CACHE_TTL_MS = 2000

const inspectPluginInventory = `const fs=require('fs');const path=require('path');
const root='/home/dsh/.dsh/profiles/web';const profilePath=path.join(root,'package.json');
if(!fs.existsSync(profilePath)){console.log('[]');process.exit(0)}
const profile=JSON.parse(fs.readFileSync(profilePath,'utf8'));const bundles=new Set(profile.dsh?.profile?.bundles??[]);const out=[];
for(const [name,source] of Object.entries(profile.dependencies??{})){try{const manifest=JSON.parse(fs.readFileSync(path.join(root,'node_modules',name,'package.json'),'utf8'));
if(manifest.dsh?.bundle?.patch)out.push({name,version:String(manifest.version??''),source:String(source),enabled:bundles.has(name)})}catch{}}
console.log(JSON.stringify(out));`

function withLifecycleLock(name, operation) {
  const previous = lifecycleLocks.get(name) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(operation)
  lifecycleLocks.set(name, current)
  return current.finally(() => {
    if (lifecycleLocks.get(name) === current) lifecycleLocks.delete(name)
  })
}

function invalidateRunning(name) {
  runningCache.delete(name)
}

async function assertManagedHomeVolume(inst) {
  const object = await inspectObject('container', inst.container_name)
  if (object && object.Config?.Labels?.['dsh.portal.managed'] !== 'true') throw new Error('unmanaged container')
  const volume = `${inst.container_name}-home`
  if (!(await inspectObject('volume', volume))) throw new Error('instance home volume is missing')
  return volume
}

async function scanPluginsUnlocked(inst) {
  const volume = await assertManagedHomeVolume(inst)
  const { stdout } = await docker([
    'run', '--rm', '--network', 'none', '--user', '1000:1000',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
    '--mount', `type=volume,src=${volume},dst=/home/dsh,readonly`,
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=16m',
    '-e', 'HOME=/home/dsh', '-e', 'DSH_HOME=/home/dsh/.dsh',
    '--entrypoint', 'node', config.image, '-e', inspectPluginInventory,
  ])
  const plugins = JSON.parse(stdout)
  if (!Array.isArray(plugins) || plugins.some((plugin) => !validPluginName(plugin?.name))) throw new Error('invalid plugin inventory')
  return recordPluginInventory(inst.id, plugins)
}

export function scanInstancePlugins(instanceId) {
  const inst = getInstanceById(instanceId)
  if (!inst) return Promise.reject(new Error('instance not found'))
  return withLifecycleLock(inst.container_name, async () => {
    const current = getInstanceById(instanceId)
    if (!current || current.status === 'deleting') throw new Error('instance unavailable')
    return scanPluginsUnlocked(current)
  })
}

export function uninstallInstancePlugin(instanceId, packageName) {
  const inst = getInstanceById(instanceId)
  if (!inst) return Promise.reject(new Error('instance not found'))
  if (!validPluginName(packageName)) return Promise.reject(new Error('invalid plugin name'))
  return withLifecycleLock(inst.container_name, async () => {
    const current = getInstanceById(instanceId)
    if (!current || current.status === 'deleting') throw new Error('instance unavailable')
    const volume = await assertManagedHomeVolume(current)
    const object = await inspectObject('container', current.container_name)
    const wasRunning = Boolean(object?.State?.Running)
    if (wasRunning) await stopContainerUnlocked(current.container_name)
    try {
      await docker([
        'run', '--rm', '--network', config.instanceNetwork, '--user', '1000:1000',
        '--label', 'dsh.portal.helper=plugin-rescue',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
        '--mount', `type=volume,src=${volume},dst=/home/dsh`,
        '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m',
        '-e', 'HOME=/home/dsh', '-e', 'DSH_HOME=/home/dsh/.dsh', '-e', 'CI=true',
        '--entrypoint', 'flock', config.image,
        '-n', '/home/dsh/.dsh/portal-plugin-install.lock',
        'timeout', '--signal=TERM', '--kill-after=10s', '300s',
        'dsh', 'plugin', '--profile', 'web', 'remove', packageName,
      ], { timeout: 330000 })
      const inventory = await scanPluginsUnlocked(current)
      if (object) {
        await startContainerUnlocked(current.container_name)
        const healthy = await waitHealthy(current.host_port, config.instanceStartTimeoutMs)
        updateInstanceUnlessDeleting(current.id, healthy
          ? { status: 'running', error: null, last_active: Date.now() }
          : { status: 'failed', error: '插件卸载完成，但实例健康检查仍未通过。' })
        return { ...inventory, recovered: healthy }
      }
      updateInstanceUnlessDeleting(current.id, { status: 'stopped', error: '插件已卸载；实例容器不存在，请由管理员重建。' })
      return { ...inventory, recovered: false }
    } catch (error) {
      if (wasRunning) {
        await startContainerUnlocked(current.container_name).catch(() => {})
        invalidateRunning(current.container_name)
      }
      throw error
    }
  })
}

export function containerName(slug) {
  return `dsh-${slug}`
}

export async function ensureImage() {
  try {
    if (!(await inspectObject('image', config.image))) throw new Error('missing image')
  } catch {
    throw new Error(`approved image "${config.image}" not found; run ./build-image.sh and configure its sha256 ID`)
  }
}

export async function verifyDockerRuntime() {
  const { stdout } = await docker(['info', '--format', '{{json .}}'])
  const info = JSON.parse(stdout)
  if (info.OSType !== 'linux') throw new Error('Docker must be running Linux containers')
  if (info.SecurityOptions?.some((value) => value.includes('rootless'))) {
    throw new Error('This Docker network isolation implementation requires a rootful Linux daemon or Docker Desktop')
  }
  await ensureImage()
  const network = await ensureNetwork()
  await applyFirewall(network)
}

async function createContainerUnlocked({ slug, hostPort }) {
  const name = containerName(slug)
  invalidateRunning(name)
  const args = [
    'run', '-d', '--name', name,
    '--cpus', config.instanceCpus,
    '--memory', config.instanceMemory,
    '--memory-swap', config.instanceMemorySwap,
    '--pids-limit', String(config.instancePidsLimit),
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--network', config.instanceNetwork,
    '--log-driver', 'local', '--log-opt', `max-size=${config.instanceLogSize}`, '--log-opt', 'max-file=3',
    '--label', 'dsh.portal.managed=true',
    '--user', '1000:1000',
    '-p', `127.0.0.1:${hostPort}:3000`,
    '-v', `${name}-home:/home/dsh`,
    '-v', `${name}-workspace:/workspace`,
    '--tmpfs', `/tmp:rw,nosuid,nodev,size=${config.instanceTmpfsSize}`,
    '-e', 'DSH_HOME=/home/dsh/.dsh',
    '-e', `TRUSTED_HOST=${slug}.${config.instanceDomain}`,
    '--restart', 'unless-stopped',
  ]
  if (config.instanceReadOnlyRoot) args.push('--read-only')
  args.push(config.image)
  await docker(args)
  invalidateRunning(name)
}

export function createContainer({ slug, hostPort }) {
  const name = containerName(slug)
  return withLifecycleLock(name, () => createContainerUnlocked({ slug, hostPort }))
}

async function startContainerUnlocked(name) {
  invalidateRunning(name)
  await docker(['start', name])
  invalidateRunning(name)
}

export function startContainer(name) {
  return withLifecycleLock(name, () => startContainerUnlocked(name))
}

async function stopContainerUnlocked(name) {
  invalidateRunning(name)
  await docker(['stop', '-t', '15', name], { timeout: Math.max(config.dockerCommandTimeoutMs, 30000) })
  invalidateRunning(name)
}

export function stopContainer(name) {
  return withLifecycleLock(name, () => stopContainerUnlocked(name))
}

export function restartContainer(name) {
  return withLifecycleLock(name, async () => {
    invalidateRunning(name)
    await docker(['restart', '-t', '15', name], { timeout: Math.max(config.dockerCommandTimeoutMs, 30000) })
    invalidateRunning(name)
  })
}

async function objectExists(kind, name) {
  return (await inspectObject(kind, name)) !== null
}

async function removeExistingContainerUnlocked(name) {
  if (await objectExists('container', name)) await docker(['rm', '-f', name])
  if (await objectExists('container', name)) throw new Error(`container "${name}" still exists after removal`)
  invalidateRunning(name)
}

export function removeContainer(name) {
  return withLifecycleLock(name, async () => {
    await removeExistingContainerUnlocked(name)
    for (const volume of [`${name}-home`, `${name}-workspace`]) {
      // Never force-remove tenant data. If anything reattaches the volume,
      // Docker must fail and the deleting DB tombstone remains for retry.
      if (await objectExists('volume', volume)) await docker(['volume', 'rm', volume])
      if (await objectExists('volume', volume)) throw new Error(`volume "${volume}" still exists after removal`)
    }
  })
}

/** Remove a stale container but keep its volumes (idempotent re-provision). */
export function removeContainerKeepVolumes(name) {
  return withLifecycleLock(name, () => removeExistingContainerUnlocked(name))
}

export async function containerRunning(name, { fresh = false } = {}) {
  const now = Date.now()
  const cached = runningCache.get(name)
  if (cached?.pending) return cached.pending
  if (!fresh && cached && cached.expiresAt > now) return cached.value

  const pending = docker(['inspect', '-f', '{{.State.Running}}', name])
    .then(({ stdout }) => stdout.trim() === 'true')
    .catch((error) => {
      if (missingObject(error)) return false
      throw error
    })
  const entry = { pending }
  runningCache.set(name, entry)
  try {
    const value = await pending
    // A lifecycle operation may have invalidated this inspection while it was
    // pending. Never let that stale result replace a newer entry.
    if (runningCache.get(name) === entry) {
      runningCache.set(name, { value, expiresAt: Date.now() + RUNNING_CACHE_TTL_MS })
    }
    return value
  } catch (error) {
    if (runningCache.get(name) === entry) runningCache.delete(name)
    throw error
  }
}

export async function containerLogs(name, tail = 200) {
  try {
    const { stdout } = await docker(['logs', '--tail', String(tail), name])
    return stdout
  } catch (error) {
    return String(error?.stderr ?? error?.message ?? error)
  }
}

/** Find a free 127.0.0.1 port in the configured range, avoiding DB-claimed ports. */
export async function allocatePort() {
  const used = new Set(
    db.prepare('SELECT host_port FROM instances').all().map((r) => r.host_port),
  )
  for (let p = config.portRangeStart; p <= config.portRangeEnd; p++) {
    if (used.has(p)) continue
    if (await isPortFree(p)) return p
  }
  throw new Error('no free ports in instance port range')
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.unref()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}

/** Poll the instance's HTTP root until 200 or timeout. */
export async function waitHealthy(hostPort, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const healthy = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: hostPort, path: '/', timeout: Math.min(5000, deadline - Date.now()) }, (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      })
      req.once('error', () => resolve(false))
      req.once('timeout', () => req.destroy(new Error('health check timeout')))
    })
    if (healthy) return true
    if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, Math.min(2000, deadline - Date.now())))
  }
  return false
}

/** Provision one instance under a per-container lock. */
export async function provision(instanceId, { setDefaultModel = false } = {}) {
  const initial = getInstanceById(instanceId)
  if (!initial) return
  const name = containerName(initial.slug)

  return withLifecycleLock(name, async () => {
    const inst = getInstanceById(instanceId)
    if (!inst || inst.status === 'deleting') return
    try {
      await removeExistingContainerUnlocked(name)
      await ensureImage()
      await createContainerUnlocked({ slug: inst.slug, hostPort: inst.host_port })
      const healthy = await waitHealthy(inst.host_port, config.instanceStartTimeoutMs)

      // Deletion may set its tombstone while health polling is in progress.
      const current = getInstanceById(instanceId)
      if (!current || current.status === 'deleting') {
        await removeExistingContainerUnlocked(name)
        return
      }
      if (healthy) {
        updateInstanceUnlessDeleting(inst.id, { status: 'running', error: null })
        const policy = pluginDefaults()
        const previous = pluginState(inst.id)
        if (policy.commands && previous?.state !== 'queued'
            && (previous?.revision !== policy.revision || previous?.state !== 'completed')) {
          await applyPluginsUnlocked(inst, policy)
        }
        if (config.gatewayEnabled) {
          const { syncDsh } = await import('./gateway-dsh.js')
          // Configuration failure is visible in admin; it must not break a healthy DSH.
          await syncDsh(inst.user_id, { initial: true, setDefault: setDefaultModel }).catch(() => {})
        }
      } else {
        await stopContainerUnlocked(name)
        updateInstanceUnlessDeleting(inst.id, { status: 'stopped', error: 'health check timed out' })
      }
    } catch (error) {
      const current = getInstanceById(instanceId)
      if (current && current.status !== 'deleting') {
        updateInstanceUnlessDeleting(inst.id, {
          status: 'failed',
          error: String(error?.stderr ?? error?.message ?? error),
        })
      }
    }
  })
}

async function applyPluginsUnlocked(inst, policy) {
  recordPluginState(inst.id, policy, 'running', '正在安装，成功后自动重启')
  updateInstanceUnlessDeleting(inst.id, { last_active: Date.now() })
  try {
    const object = await inspectObject('container', inst.container_name)
    if (!object || object.Config?.Labels?.['dsh.portal.managed'] !== 'true') throw new Error('unmanaged or missing container')
    if (!object.State.Running) {
      await startContainerUnlocked(inst.container_name)
      if (!(await waitHealthy(inst.host_port, config.instanceStartTimeoutMs))) throw new Error('startup unhealthy')
      updateInstanceUnlessDeleting(inst.id, { status: 'running', error: null })
    }
    const installed = await installPluginCommands(inst.container_name, policy.commands)
    if (getInstanceById(inst.id)?.status === 'deleting') throw new Error('deleting')
    await docker(['restart', '-t', '15', inst.container_name], { timeout: Math.max(config.dockerCommandTimeoutMs, 30000) })
    invalidateRunning(inst.container_name)
    if (!(await waitHealthy(inst.host_port, config.instanceStartTimeoutMs))) {
      updateInstanceUnlessDeleting(inst.id, { status: 'failed', error: '插件安装后实例健康检查失败，请检查插件兼容性。' })
      throw new Error('unhealthy')
    }
    updateInstanceUnlessDeleting(inst.id, { status: 'running', error: null, last_active: Date.now() })
    recordPluginState(inst.id, policy, 'completed', '已安装并启用，重启检查通过', installed)
  } catch {
    recordPluginState(inst.id, policy, 'failed', '安装或重启检查失败。请检查网络、包名和插件兼容性后重试；已完成的安装会保留。')
  }
}

export function applyDefaultPlugins(instanceId, policy = pluginDefaults()) {
  const inst = getInstanceById(instanceId)
  if (!inst) return Promise.resolve()
  return withLifecycleLock(inst.container_name, async () => {
    const current = getInstanceById(instanceId)
    if (!current || current.status === 'deleting') {
      recordPluginState(instanceId, policy, 'failed', '实例已删除或正在删除。')
      return
    }
    await applyPluginsUnlocked(current, policy)
  })
}
