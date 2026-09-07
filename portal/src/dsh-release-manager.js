import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { config } from './config.js'
import {
  createDshRelease, createDshReleaseBuild, getDshRelease, getDshReleaseByImage,
  listDshReleaseBuilds, updateDshRelease, updateDshReleaseBuild,
} from './db.js'
import { inspectObject } from './docker.js'

const VERSION = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/
const NPM_PACKAGE_URL = 'https://registry.npmjs.org/@deepseek-ai%2Fdsh'
const BUILD_LOG_LIMIT = 12_000
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

export async function resolveRequestedVersion(requestedVersion) {
  const suffix = requestedVersion === 'latest' ? 'latest' : encodeURIComponent(requestedVersion)
  const response = await fetch(`${NPM_PACKAGE_URL}/${suffix}`, { signal: AbortSignal.timeout(30_000) })
  if (response.status === 404 && requestedVersion !== 'latest') {
    throw new Error(`DSH ${requestedVersion} 尚未发布；请使用 latest 或已发布版本。`)
  }
  if (!response.ok) throw new Error(`npm latest lookup failed: HTTP ${response.status}`)
  const { version } = await response.json()
  if (!VERSION.test(version)) throw new Error('npm returned an invalid DSH version')
  if (requestedVersion !== 'latest' && version !== requestedVersion) throw new Error(`npm returned an unexpected DSH version: ${version}`)
  return version
}

function appendBuildLog(current, output) {
  const cleaned = String(output).replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '')
  return `${current}${cleaned}`.slice(-BUILD_LOG_LIMIT)
}

function buildPhase(output) {
  const line = String(output)
  if (/load build definition|load build context/i.test(line)) return ['preparing', '正在读取镜像配方。']
  if (/load metadata|FROM .*node:/i.test(line)) return ['pulling-base', '正在拉取基础镜像。']
  if (/\[2\/7\]|apt-get|npm install -g/i.test(line)) return ['installing', '正在安装系统依赖和指定 DSH 版本。']
  if (/patch-dsh|listener patch/i.test(line)) return ['patching', '正在校验 DSH Web 监听补丁。']
  if (/usermod|tenant-firewall|start\.sh/i.test(line)) return ['hardening', '正在准备受限运行环境。']
  if (/exporting|writing image|naming to/i.test(line)) return ['exporting', '正在生成受控镜像。']
  return ['building', '正在构建受控 DSH 镜像。']
}

function dockerBuild(args, { timeout, onOutput }) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeout)
    const collect = (stream, chunk) => {
      const text = chunk.toString()
      if (stream === 'stdout') stdout = appendBuildLog(stdout, text)
      else stderr = appendBuildLog(stderr, text)
      onOutput(text)
    }
    child.stdout.on('data', (chunk) => collect('stdout', chunk))
    child.stderr.on('data', (chunk) => collect('stderr', chunk))
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) return resolve({ stdout, stderr })
      const error = new Error(timedOut ? 'Docker 构建超时。' : `Docker 构建失败（退出码 ${code ?? signal ?? 'unknown'}）。`)
      error.stdout = stdout
      error.stderr = stderr
      reject(error)
    })
  })
}

function buildFailureMessage(error) {
  const message = String(error?.message ?? error)
  if (/尚未发布/.test(message)) return message
  if (/timed out|超时/i.test(message)) return '构建超时；请检查网络、Docker 资源和构建日志后重试。'
  return '构建失败；请查看下方末尾日志定位失败阶段。'
}

async function buildRelease(build) {
  let logTail = ''
  let lastProgressAt = 0
  let lastPhase = 'resolving'
  const report = (phase, message, output = '') => {
    if (output) logTail = appendBuildLog(logTail, output)
    const now = Date.now()
    if (phase === lastPhase && now - lastProgressAt < 750) return
    lastPhase = phase
    lastProgressAt = now
    updateDshReleaseBuild(build.id, { status: 'running', phase, message, log_tail: logTail })
  }
  report('resolving', '正在确认目标版本是否已发布。')
  try {
    const version = await resolveRequestedVersion(build.requested_version)
    report('preparing', `已确认 DSH ${version}，正在准备 Docker 构建。`)
    const tag = `dsh-portal:${version}`
    const mirrorArgs = []
    if (config.dshNpmRegistry) mirrorArgs.push('--build-arg', `NPM_REGISTRY=${config.dshNpmRegistry}`)
    if (config.dshDebianMirror) mirrorArgs.push('--build-arg', `DEBIAN_MIRROR=${config.dshDebianMirror}`)
    const context = fileURLToPath(new URL('../../image/', import.meta.url))
    await dockerBuild(['build', '--progress=plain', '--pull', '--build-arg', `DSH_VERSION=${version}`, ...mirrorArgs, '-t', tag, context], {
      timeout: config.dshBuildTimeoutMs,
      onOutput: (output) => {
        const [phase, message] = buildPhase(output)
        report(phase, message, output)
      },
    })
    const image = await inspectObject('image', tag)
    if (!image?.Id || !/^sha256:[a-f0-9]{64}$/.test(image.Id)) throw new Error('built image is missing an immutable ID')
    const release = createDshRelease({ version, imageId: image.Id, createdBy: build.requested_by })
    if (release.version !== version) updateDshRelease(release.id, { version })
    updateDshReleaseBuild(build.id, {
      status: 'completed', release_id: release.id, finished_at: Date.now(),
      phase: 'completed', log_tail: logTail, message: `已构建 DSH ${version}；请先灰度升级一个实例。`,
    })
  } catch (error) {
    console.error('[dsh release build]', error)
    updateDshReleaseBuild(build.id, {
      status: 'failed', finished_at: Date.now(),
      phase: 'failed', log_tail: appendBuildLog(logTail, `${error?.stderr ?? ''}\n${error?.stdout ?? ''}`),
      message: buildFailureMessage(error),
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
