import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

process.chdir(fileURLToPath(new URL('..', import.meta.url)))
function docker(args, capture = false) {
  const result = spawnSync('docker', args, { stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(capture ? result.stderr : 'Docker build failed')
  return result.stdout?.trim()
}

if (docker(['info', '--format', '{{.OSType}}'], true) !== 'linux') throw new Error('Start Docker with Linux containers first')
const response = await fetch('https://registry.npmjs.org/@deepseek-ai%2Fdsh/latest', { signal: AbortSignal.timeout(30000) })
if (!response.ok) throw new Error(`Could not resolve npm latest: HTTP ${response.status}`)
const { version } = await response.json()
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('Invalid npm version')
console.log(`Building npm latest: @deepseek-ai/dsh@${version}`)
// Only image/ enters the context; no .env, database or upstream source checkout.
const tag = `dsh-portal:${version}`
const mirrorArgs = ['NPM_REGISTRY', 'DEBIAN_MIRROR'].flatMap((name) =>
  process.env[name] ? ['--build-arg', `${name}=${process.env[name]}`] : [])
docker(['build', '--pull', '--build-arg', `DSH_VERSION=${version}`, ...mirrorArgs, '-t', tag, 'image'])
const id = docker(['image', 'inspect', tag, '--format', '{{.Id}}'], true)
console.log(`DSH_VERSION=${version}\nDSH_IMAGE=${id}\nCopy DSH_IMAGE into your server-local .env.`)
