import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { config } from './config.js'

const run = promisify(execFile)

export function docker(args, opts = {}) {
  return run('docker', args, {
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    timeout: config.dockerCommandTimeoutMs,
    ...opts,
  })
}

export function missingObject(error) {
  return /no such (?:container|object|image|volume|network)|network .+ not found/i.test(String(error?.stderr ?? error?.message ?? error))
}

export async function inspectObject(kind, name) {
  try {
    const { stdout } = await docker([kind, 'inspect', name])
    return JSON.parse(stdout)[0]
  } catch (error) {
    if (missingObject(error)) return null
    throw error
  }
}

export async function ensureNetwork() {
  let network = await inspectObject('network', config.instanceNetwork)
  if (!network) {
    await docker(['network', 'create', '--driver', 'bridge',
      '--label', 'dsh.portal.managed=true',
      '--opt', 'com.docker.network.bridge.enable_icc=false',
      '--opt', 'com.docker.network.bridge.host_binding_ipv4=127.0.0.1',
      config.instanceNetwork])
    network = await inspectObject('network', config.instanceNetwork)
  }
  if (network?.Driver !== 'bridge' || network.EnableIPv6 || network.Internal
      || network.Labels?.['dsh.portal.managed'] !== 'true'
      || network.Options?.['com.docker.network.bridge.enable_icc'] !== 'false'
      || network.Options?.['com.docker.network.bridge.host_binding_ipv4'] !== '127.0.0.1'
      || network.IPAM?.Config?.length !== 1) {
    throw new Error('Docker tenant network has incompatible isolation settings; use a new dedicated network name')
  }
  return network
}

export async function applyFirewall(network) {
  const subnet = network.IPAM.Config[0].Subnet
  if (!/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(subnet)) throw new Error('Docker network must have one IPv4 subnet')
  // This short-lived helper only changes rules for our dedicated subnet.
  // Tenant containers never receive NET_ADMIN, host networking, or a Docker socket.
  await docker(['run', '--rm', '--network', 'host', '--user', '0:0',
    '--cap-drop', 'ALL', '--cap-add', 'NET_ADMIN', '--security-opt', 'no-new-privileges',
    '--read-only', '--entrypoint', '/bin/bash', config.image, '/opt/dsh/tenant-firewall.sh', subnet])
}
