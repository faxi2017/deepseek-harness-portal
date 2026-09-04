import { fileURLToPath } from 'node:url'
import { config } from './config.js'
import {
  createDshRelease, createDshReleaseBuild, getDshRelease, getDshReleaseByImage,
  listDshReleaseBuilds, updateDshRelease, updateDshReleaseBuild,
} from './db.js'
import { docker, inspectObject } from './docker.js'

const VERSION = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/
let buildQueue = Promise.resolve()

export function validDshVersion(value) {
  return value === 'latest' || VERSION.test(String(value ?? ''))
}

export async function hydrateDshReleaseVersion(releaseId) {
  const release = getDshRelease(releaseId)
  if (!release) return null
  const image = await inspectObject('image', release.image_id)
  const version = image?.Config?.Labels?.['dsh.portal.version']
  if (typeof version === 'string' && VERSION.test(version) && version !== release.version) {
    updateDshRelease(release.id, { version })
  }
  return getDshRelease(release.id)
}

async function resolveRequestedVersion(requestedVersion) {
  if (requestedVersion !== 'latest') return requestedVersion
  const response = await fetch('https://registry.npmjs.org/@deepseek-ai%2Fdsh/latest', { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`npm latest lookup failed: HTTP ${response.status}`)
  const { version } = await response.json()
  if (!VERSION.test(version)) throw new Error('npm returned an invalid DSH version')
  return version
}

async function buildRelease(build) {
  updateDshReleaseBuild(build.id, { status: 'running', started_at: Date.now(), message: '正在构建受控 DSH 镜像。' })
  try {
    const version = await resolveRequestedVersion(build.requested_version)
    const tag = `dsh-portal:${version}`
    const mirrorArgs = []
    if (config.dshNpmRegistry) mirrorArgs.push('--build-arg', `NPM_REGISTRY=${config.dshNpmRegistry}`)
    if (config.dshDebianMirror) mirrorArgs.push('--build-arg', `DEBIAN_MIRROR=${config.dshDebianMirror}`)
    const context = fileURLToPath(new URL('../../image/', import.meta.url))
    await docker(['build', '--pull', '--build-arg', `DSH_VERSION=${version}`, ...mirrorArgs, '-t', tag, context], {
      timeout: config.dshBuildTimeoutMs,
    })
    const image = await inspectObject('image', tag)
    if (!image?.Id || !/^sha256:[a-f0-9]{64}$/.test(image.Id)) throw new Error('built image is missing an immutable ID')
    const release = createDshRelease({ version, imageId: image.Id, createdBy: build.requested_by })
    if (release.version !== version) updateDshRelease(release.id, { version })
    updateDshReleaseBuild(build.id, {
      status: 'completed', release_id: release.id, finished_at: Date.now(),
      message: `已构建 DSH ${version}；请先灰度升级一个实例。`,
    })
  } catch (error) {
    console.error('[dsh release build]', error)
    updateDshReleaseBuild(build.id, {
      status: 'failed', finished_at: Date.now(),
      message: '构建失败。请检查 Docker、网络、镜像补丁兼容性和服务日志后重试。',
    })
  }
}

export function queueDshReleaseBuild({ version, requestedBy }) {
  if (!validDshVersion(version)) throw new Error('invalid DSH version')
  const active = listDshReleaseBuilds(20).find((build) => ['queued', 'running'].includes(build.status))
  if (active) throw new Error('a DSH image build is already in progress')
  const build = createDshReleaseBuild({ requestedVersion: version, requestedBy })
  buildQueue = buildQueue.catch(() => {}).then(() => buildRelease(build))
  return build
}

export async function verifyDshReleaseImage(releaseId) {
  const release = getDshRelease(releaseId)
  if (!release) throw new Error('DSH release not found')
  const image = await inspectObject('image', release.image_id)
  if (!image?.Id || image.Id !== release.image_id) throw new Error('DSH release image is missing')
  return release
}

export async function discoverConfiguredReleaseVersion(release) {
  try { return await hydrateDshReleaseVersion(release.id) } catch (error) {
    console.warn('[dsh release] unable to read image label:', error?.message ?? error)
    return getDshReleaseByImage(release.image_id) ?? release
  }
}
