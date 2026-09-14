import net from 'node:net'
import http from 'node:http'
import { config } from './config.js'
import {
  db, createDshRelease, createDshUpgrade, getDefaultDshRelease, getDshRelease, getDshUpgrade,
  getDshReleaseByImage, getInstanceById, listDshUpgradeBackups, listInstancesWithUsers,
  updateDshRelease, updateDshUpgrade, updateInstance, updateInstanceUnlessDeleting,
} from './db.js'

import { docker, inspectObject, missingObject, ensureNetwork, applyFirewall } from './docker.js'
import {
  installPluginCommands, pluginDefaults, pluginState, recordPluginInventory,
  recordPluginState, validPluginName,
} from './plugins.js'
const runningCache = new Map()
const lifecycleLocks = new Map()
const scheduledUpgrades = new Set()
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

async function assertManagedTenantVolumes(inst) {
  const container = await inspectObject('container', inst.container_name)
  if (container && container.Config?.Labels?.['dsh.portal.managed'] !== 'true') throw new Error('unmanaged container')
  const volumes = [`${inst.container_name}-home`, `${inst.container_name}-workspace`]
  for (const volume of volumes) {
    if (!(await inspectObject('volume', volume))) throw new Error(`instance volume is missing: ${volume}`)
  }
  return volumes
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
      const previousPlugins = pluginState(current.id)
      if (previousPlugins) {
        recordPluginState(current.id, previousPlugins, previousPlugins.state,
          `已手动卸载 ${packageName}；如需恢复默认插件，请由管理员重新下发。`, inventory.plugins)
      }
      if (object) {
        await startContainerUnlocked(current.container_name)
        const healthy = await waitHealthy(current.host_port, config.instanceStartTimeoutMs, current.container_name)
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

export async function ensureImage(image = config.image) {
  try {
    if (!(await inspectObject('image', image))) throw new Error('missing image')
  } catch {
    throw new Error(`approved image "${image}" not found`)
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
  const configuredRelease = getDshReleaseByImage(config.image)
  const configuredImage = await inspectObject('image', config.image)
  const configuredVersion = configuredImage?.Config?.Labels?.['dsh.portal.version']
  if (configuredRelease && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(configuredVersion)) {
    updateDshRelease(configuredRelease.id, { version: configuredVersion })
  }
  // An older deployment may have changed DSH_IMAGE before every tenant was
  // reprovisioned. Record the image a live managed container actually uses so
  // an upgrade rollback never assumes the newer configured image is its source.
  for (const instance of listInstancesWithUsers()) {
    const container = await inspectObject('container', instance.container_name)
    if (!container || container.Config?.Labels?.['dsh.portal.managed'] !== 'true' || !/^sha256:[a-f0-9]{64}$/.test(container.Image ?? '')) continue
    let release = getDshReleaseByImage(container.Image)
    if (!release) {
      const image = await inspectObject('image', container.Image)
      const version = image?.Config?.Labels?.['dsh.portal.version']
      release = createDshRelease({
        version: /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version) ? version : '未识别的现有镜像',
        imageId: container.Image,
      })
    }
    if (instance.release_id !== release.id) updateInstance(instance.id, { release_id: release.id })
  }
  const network = await ensureNetwork()
  await applyFirewall(network)
}

async function createContainerUnlocked({ slug, hostPort, image = config.image }) {
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
  args.push(image)
  await docker(args)
  invalidateRunning(name)
}

export function createContainer({ slug, hostPort, image = config.image }) {
  const name = containerName(slug)
  return withLifecycleLock(name, () => createContainerUnlocked({ slug, hostPort, image }))
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

async function removeUpgradeBackupsUnlocked(instance) {
  for (const row of listDshUpgradeBackups(instance.id)) {
    for (const volume of [row.backup_home_volume, row.backup_workspace_volume]) {
      // Failed upgrades can legitimately have no snapshot yet.
      if (volume === null) continue
      if (!validUpgradeBackupName(instance.container_name, volume)) throw new Error('invalid stored upgrade backup')
      if (await inspectObject('volume', volume)) await docker(['volume', 'rm', volume])
      if (await inspectObject('volume', volume)) throw new Error(`volume "${volume}" still exists after removal`)
    }
  }
}

/** Remove every Docker resource owned by one instance under a single lock. */
export async function removeInstanceResources(instanceId) {
  const instance = getInstanceById(instanceId)
  if (!instance) return
  return withLifecycleLock(instance.container_name, async () => {
    const current = getInstanceById(instanceId)
    if (!current) return
    await removeExistingContainerUnlocked(current.container_name)
    for (const volume of [`${current.container_name}-home`, `${current.container_name}-workspace`]) {
      if (await inspectObject('volume', volume)) await docker(['volume', 'rm', volume])
      if (await inspectObject('volume', volume)) throw new Error(`volume "${volume}" still exists after removal`)
    }
    await removeUpgradeBackupsUnlocked(current)
  })
}

/** Remove a stale container but keep its volumes (idempotent re-provision). */
export function removeContainerKeepVolumes(name) {
  return withLifecycleLock(name, () => removeExistingContainerUnlocked(name))
}

function upgradeBackupNames(name, upgradeId) {
  return {
    home: `${name}-upgrade-${upgradeId}-home-backup`,
    workspace: `${name}-upgrade-${upgradeId}-workspace-backup`,
  }
}

function validUpgradeBackupName(name, volume) {
  return typeof volume === 'string'
    && volume.startsWith(`${name}-upgrade-`)
    && /-(?:home|workspace)-backup$/.test(volume)
}

async function copyVolumeContents(source, target, image, { replace = false } = {}) {
  if (!(await inspectObject('volume', source)) || !(await inspectObject('volume', target))) {
    throw new Error('upgrade volume is missing')
  }
  const command = replace
    ? 'set -e; find /target -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -C /source -cf - . | tar -C /target -xpf -'
    : 'set -e; tar -C /source -cf - . | tar -C /target -xpf -'
  await docker([
    'run', '--rm', '--network', 'none', '--user', '0:0', '--cap-drop', 'ALL',
    '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER',
    '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=16m',
    '--mount', `type=volume,src=${source},dst=/source,readonly`,
    '--mount', `type=volume,src=${target},dst=/target`,
    '--entrypoint', '/bin/bash', image, '-ec', command,
  ], { timeout: Math.max(config.dockerCommandTimeoutMs, 120_000) })
}

async function createVolumeBackup(volumes, backups, image) {
  const created = []
  try {
    for (const volume of Object.values(backups)) {
      if (await inspectObject('volume', volume)) throw new Error('upgrade backup already exists')
      await docker(['volume', 'create', '--label', 'dsh.portal.managed=true', '--label', 'dsh.portal.upgrade-backup=true', volume])
      created.push(volume)
    }
    await copyVolumeContents(volumes[0], backups.home, image)
    await copyVolumeContents(volumes[1], backups.workspace, image)
  } catch (error) {
    for (const volume of created) await docker(['volume', 'rm', volume]).catch(() => {})
    throw error
  }
}

async function restoreVolumeBackup(volumes, backups, image, containerName) {
  if (!validUpgradeBackupName(containerName, backups.home) || !validUpgradeBackupName(containerName, backups.workspace)) {
    throw new Error('invalid upgrade backup')
  }
  await copyVolumeContents(backups.home, volumes[0], image, { replace: true })
  await copyVolumeContents(backups.workspace, volumes[1], image, { replace: true })
}

async function restorePreviousRelease(inst, previousRelease, volumes, backups, priorStatus) {
  await removeExistingContainerUnlocked(inst.container_name)
  await restoreVolumeBackup(volumes, backups, previousRelease.image_id, inst.container_name)
  await createContainerUnlocked({ slug: inst.slug, hostPort: inst.host_port, image: previousRelease.image_id })
  const healthy = await waitHealthy(inst.host_port, config.instanceStartTimeoutMs, inst.container_name)
  if (!healthy) {
    await stopContainerUnlocked(inst.container_name).catch(() => {})
    return false
  }
  if (priorStatus === 'stopped') await stopContainerUnlocked(inst.container_name)
  return true
}

async function runDshUpgrade(upgradeId, { restoreFromUpgradeId = null } = {}) {
  const initial = getDshUpgrade(upgradeId)
  if (!initial) return
  const instance = getInstanceById(initial.instance_id)
  if (!instance || instance.status === 'deleting') {
    updateDshUpgrade(upgradeId, { status: 'failed', finished_at: Date.now(), message: '实例不存在或正在删除，未执行升级。' })
    return
  }
  const name = instance.container_name
  return withLifecycleLock(name, async () => {
    const current = getInstanceById(instance.id)
    const upgrade = getDshUpgrade(upgradeId)
    if (!current || !upgrade || current.status === 'deleting') {
      updateDshUpgrade(upgradeId, { status: 'failed', finished_at: Date.now(), message: '实例不可用，未执行升级。' })
      return
    }
    const previousRelease = getDshRelease(upgrade.from_release_id)
    const targetRelease = getDshRelease(upgrade.to_release_id)
    let priorStatus = current.status === 'stopped' ? 'stopped' : 'running'
    let volumes
    let backups
    let wasRunning = false
    let stoppedForBackup = false
    let replacementStarted = false
    try {
      if (!previousRelease || !targetRelease) throw new Error('upgrade release is unavailable')
      await ensureImage(previousRelease.image_id)
      await ensureImage(targetRelease.image_id)
      volumes = await assertManagedTenantVolumes(current)
      const existing = await inspectObject('container', name)
      wasRunning = Boolean(existing?.State?.Running)
      priorStatus = wasRunning ? 'running' : 'stopped'
      if (!updateInstanceUnlessDeleting(current.id, { status: 'upgrading', error: null })) throw new Error('instance deletion is in progress')
      if (wasRunning) {
        await stopContainerUnlocked(name)
        stoppedForBackup = true
      }
      backups = upgradeBackupNames(name, upgrade.id)
      await createVolumeBackup(volumes, backups, previousRelease.image_id)
      updateDshUpgrade(upgrade.id, { backup_home_volume: backups.home, backup_workspace_volume: backups.workspace })

      if (restoreFromUpgradeId !== null) {
        const source = getDshUpgrade(restoreFromUpgradeId)
        if (!source || source.instance_id !== current.id || !source.backup_home_volume || !source.backup_workspace_volume) {
          throw new Error('rollback snapshot is unavailable')
        }
        if (!validUpgradeBackupName(name, source.backup_home_volume) || !validUpgradeBackupName(name, source.backup_workspace_volume)) {
          throw new Error('rollback snapshot is invalid')
        }
        // Verify the requested historical snapshot before stopping the service.
        if (!(await inspectObject('volume', source.backup_home_volume)) || !(await inspectObject('volume', source.backup_workspace_volume))) {
          throw new Error('rollback snapshot volumes are missing')
        }
        updateDshUpgrade(upgrade.id, { message: '正在恢复所选升级前快照。' })
      } else {
        updateDshUpgrade(upgrade.id, { message: '备份完成，正在启动目标 DSH 版本。' })
      }

      replacementStarted = true
      await removeExistingContainerUnlocked(name)
      if (restoreFromUpgradeId !== null) {
        const source = getDshUpgrade(restoreFromUpgradeId)
        await restoreVolumeBackup(volumes, {
          home: source.backup_home_volume,
          workspace: source.backup_workspace_volume,
        }, previousRelease.image_id, name)
      }
      await createContainerUnlocked({ slug: current.slug, hostPort: current.host_port, image: targetRelease.image_id })
      if (!(await waitHealthy(current.host_port, config.instanceStartTimeoutMs, current.container_name))) throw new Error('candidate health check failed')
      updateInstanceUnlessDeleting(current.id, {
        release_id: targetRelease.id, status: 'running', error: null, last_active: Date.now(),
      })
      updateDshUpgrade(upgrade.id, {
        status: 'completed', finished_at: Date.now(),
        message: '升级完成，目标版本健康检查已通过；已保留升级前快照，可按需回退。',
      })
      if (config.gatewayEnabled) {
        const { syncDsh } = await import('./gateway-dsh.js')
        await syncDsh(current.user_id).catch(() => {})
      }
    } catch (error) {
      console.error('[dsh upgrade]', error)
      let restored = false
      if (replacementStarted && volumes && backups && previousRelease) {
        try {
          restored = await restorePreviousRelease(current, previousRelease, volumes, backups, priorStatus)
        } catch (rollbackError) {
          console.error('[dsh upgrade rollback]', rollbackError)
        }
      }
      if (restored) {
        updateInstanceUnlessDeleting(current.id, {
          release_id: previousRelease.id, status: priorStatus, error: null,
          ...(priorStatus === 'running' ? { last_active: Date.now() } : {}),
        })
        updateDshUpgrade(upgrade.id, {
          status: 'rolled_back', finished_at: Date.now(),
          message: '目标版本未通过健康检查，已自动恢复到升级前版本和数据快照。',
        })
      } else if (!replacementStarted) {
        let resumed = true
        if (stoppedForBackup) {
          await startContainerUnlocked(name).catch(() => { resumed = false })
          if (resumed) resumed = await waitHealthy(current.host_port, config.instanceStartTimeoutMs, current.container_name)
        }
        updateInstanceUnlessDeleting(current.id, resumed
          ? { status: priorStatus, error: null }
          : { status: 'failed', error: 'DSH 升级前备份失败，且原服务未能恢复；请联系管理员。' })
        updateDshUpgrade(upgrade.id, {
          status: 'failed', finished_at: Date.now(),
          message: resumed ? '升级前备份未完成，原版本和用户数据未被替换。' : '升级前备份未完成，原服务也未能恢复。',
        })
      } else {
        updateInstanceUnlessDeleting(current.id, {
          status: 'failed', error: 'DSH 升级或自动回退失败；请由管理员查看升级记录并执行回退。',
        })
        updateDshUpgrade(upgrade.id, {
          status: 'failed', finished_at: Date.now(),
          message: replacementStarted
            ? '升级失败，且自动回退未完成；请从此记录执行回退。'
            : '升级未开始切换，原服务未被替换。',
        })
      }
    }
  })
}

export function scheduleDshUpgrade(instanceId, targetReleaseId, { requestedBy, restoreFromUpgradeId = null } = {}) {
  const instance = getInstanceById(instanceId)
  if (!instance) throw new Error('instance not found')
  if (!['running', 'stopped'].includes(instance.status)) throw new Error('instance is not ready for an upgrade')
  const currentRelease = getDshRelease(instance.release_id) ?? getDefaultDshRelease()
  const targetRelease = getDshRelease(targetReleaseId)
  if (!currentRelease || !targetRelease) throw new Error('DSH release not found')
  if (restoreFromUpgradeId === null && currentRelease.id === targetRelease.id) throw new Error('instance already uses this DSH release')
  if (scheduledUpgrades.has(instance.container_name)) throw new Error('instance upgrade is already in progress')
  const operation = restoreFromUpgradeId === null ? 'upgrade' : 'rollback'
  const upgrade = createDshUpgrade({
    instanceId: instance.id, fromReleaseId: currentRelease.id, toReleaseId: targetRelease.id,
    operation, requestedBy,
  })
  scheduledUpgrades.add(instance.container_name)
  void runDshUpgrade(upgrade.id, { restoreFromUpgradeId })
    .catch((error) => console.error('[dsh upgrade unexpected]', error))
    .finally(() => scheduledUpgrades.delete(instance.container_name))
  return upgrade
}

export async function removeDshUpgradeBackups(instanceId) {
  const instance = getInstanceById(instanceId)
  if (!instance) return
  return withLifecycleLock(instance.container_name, () => removeUpgradeBackupsUnlocked(instance))
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

/** Read the most recently printed DSH Web bootstrap token without exposing it to Portal clients. */
export async function dshWebToken(name) {
  const { stdout = '', stderr = '' } = await docker(['logs', '--tail', '50', name])
  const matches = [...`${stdout}\n${stderr}`.matchAll(/^dsh web: \S+\?token=([A-Za-z0-9_-]{43})(?:\s|$)/gm)]
  return matches.at(-1)?.[1] ?? null
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

/** Poll until DSH's core LLM route is registered, not merely its HTTP server. */
function probeStatus(options, body) {
  return new Promise((resolve) => {
    const req = http.request(options, (res) => {
      res.resume()
      resolve(res.statusCode)
    })
    req.once('error', () => resolve(0))
    req.once('timeout', () => req.destroy(new Error('health check timeout')))
    req.end(body)
  })
}

export async function waitHealthy(hostPort, timeoutMs, containerName = null) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await probeStatus({
        host: '127.0.0.1', port: hostPort, path: '/api/llm/listProviders', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': 2 },
        timeout: Math.min(5000, deadline - Date.now()),
      }, '{}')
    let healthy = status === 200 || status === 401
    // DSH 0.1.1 has neither browser tokens nor the llm/listProviders RPC.
    // Only accept its root as a legacy signal when this container has no token.
    if (!healthy && status === 404 && containerName && !(await dshWebToken(containerName))) {
      healthy = await probeStatus({ host: '127.0.0.1', port: hostPort, path: '/', method: 'GET',
        timeout: Math.min(5000, deadline - Date.now()) }) === 200
    }
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
      const release = getDshRelease(inst.release_id) ?? getDefaultDshRelease()
      const image = release?.image_id ?? config.image
      await ensureImage(image)
      await createContainerUnlocked({ slug: inst.slug, hostPort: inst.host_port, image })
      const healthy = await waitHealthy(inst.host_port, config.instanceStartTimeoutMs, inst.container_name)

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
  let container
  try {
    container = await inspectObject('container', inst.container_name)
    if (!container || container.Config?.Labels?.['dsh.portal.managed'] !== 'true') throw new Error('unmanaged or missing container')
    if (container.State.Running) await stopContainerUnlocked(inst.container_name)
    const installed = await installPluginCommands(inst.container_name, policy.commands)
    if (getInstanceById(inst.id)?.status === 'deleting') throw new Error('deleting')
    await startContainerUnlocked(inst.container_name)
    if (!(await waitHealthy(inst.host_port, config.instanceStartTimeoutMs, inst.container_name))) {
      updateInstanceUnlessDeleting(inst.id, { status: 'failed', error: '插件安装后实例健康检查失败，请检查插件兼容性。' })
      throw new Error('unhealthy')
    }
    updateInstanceUnlessDeleting(inst.id, { status: 'running', error: null, last_active: Date.now() })
    recordPluginState(inst.id, policy, 'completed', '已安装并启用，重启检查通过', installed)
  } catch {
    try {
      container = await inspectObject('container', inst.container_name)
      if (container && !container.State.Running) await startContainerUnlocked(inst.container_name)
      if (container && await waitHealthy(inst.host_port, config.instanceStartTimeoutMs, inst.container_name)) {
        updateInstanceUnlessDeleting(inst.id, { status: 'running', error: null })
      }
    } catch {}
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
