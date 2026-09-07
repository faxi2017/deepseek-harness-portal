import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { config } from '../portal/src/config.js'
import { docker, inspectObject } from '../portal/src/docker.js'
import { bifrostPassword, bifrost } from '../portal/src/bifrost.js'
import { serverKey } from '../portal/src/gateway-store.js'

// Independent of DSH_IMAGE: upgrading a user's DSH never replaces this gateway.
const image = 'maximhq/bifrost:v2.0.0@sha256:cf71be9fad4e0749b6e26cbb774c687413dad9a0970b83f4e1dadb6f503ea208'
const name = 'dsh-portal-bifrost'
const dir = resolve(config.dataDir, 'bifrost')
mkdirSync(dir, { recursive: true })
// The pinned image runs as UID:GID 1000:0. Keep data private from other users,
// while allowing its root group to create the SQLite databases in this bind mount.
chmodSync(dir, 0o770)
const settings = {
  client: { enable_logging: false, disable_content_logging: true, enforce_auth_on_inference: true },
  governance: { auth_config: { admin_username: 'portal', admin_password: bifrostPassword(), is_enabled: true } },
}
writeFileSync(join(dir, 'config.json'), JSON.stringify(settings, null, 2), { mode: 0o660 })
writeFileSync(join(dir, 'runtime.env'), `BIFROST_ENCRYPTION_KEY=${serverKey().toString('hex')}\n`, { mode: 0o660 })
chmodSync(join(dir, 'config.json'), 0o660)
chmodSync(join(dir, 'runtime.env'), 0o660)
const existing = await inspectObject('container', name)
if (existing) {
  if (existing.Config.Labels?.['dsh.portal.gateway'] !== 'true') throw new Error('Gateway container name is already in use')
  await docker(['start', name])
} else {
  await docker(['pull', image], { timeout: 300000 })
  await docker(['run', '-d', '--name', name, '--label', 'dsh.portal.gateway=true',
    '--restart', 'unless-stopped', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--memory', '512m', '--pids-limit', '256', '--log-driver', 'local', '--log-opt', 'max-size=5m',
    '-p', '127.0.0.1:14000:8080', '--add-host', 'host.docker.internal:host-gateway',
    '--env-file', join(dir, 'runtime.env'), '-v', `${dir}:/app/data`, image])
}
let healthy = false
for (let i = 0; i < 90; i++) {
  try { await bifrost('/api/providers'); healthy = true; break } catch { await new Promise((r) => setTimeout(r, 1000)) }
}
if (!healthy) throw new Error('Bifrost startup/authentication check failed; inspect gateway container locally')
console.log('Bifrost v2.0.0 ready on host loopback port 14000; management and inference authentication enabled.')
