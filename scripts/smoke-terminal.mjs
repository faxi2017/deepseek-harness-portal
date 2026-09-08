import WebSocket from '../portal/node_modules/ws/wrapper.mjs'

const origin = new URL(process.argv[2] ?? process.env.PORTAL_ORIGIN)
const username = process.env.ADMIN_NAME ?? 'admin'
const password = process.env.ADMIN_PASSWORD
if (!password) throw new Error('ADMIN_PASSWORD is required')

let cookie = ''
let csrf = ''

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const unsafe = method !== 'GET' && method !== 'HEAD'
  const payload = body === undefined && unsafe ? {} : body
  const response = await fetch(new URL(path, origin), {
    method,
    redirect: 'manual',
    headers: {
      origin: origin.origin,
      ...(cookie ? { cookie } : {}),
      ...(method === 'GET' ? {} : { 'x-csrf-token': csrf }),
      ...(payload !== undefined && !Buffer.isBuffer(payload) ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: payload === undefined ? undefined : (Buffer.isBuffer(payload) ? payload : JSON.stringify(payload)),
  })
  if (!response.ok) {
    const result = await response.json().catch(() => ({}))
    throw new Error(`${method} ${path}: ${response.status} ${result.error ?? 'request failed'}`)
  }
  return response
}

const login = await api('/api/auth/login', { method: 'POST', body: { username, password } })
cookie = login.headers.getSetCookie()[0].split(';', 1)[0]
csrf = (await login.json()).csrfToken

for (const path of ['/vendor/xterm.js', '/vendor/xterm-fit.js', '/vendor/xterm.css']) await api(path)

const listed = await (await api('/api/admin/terminal/instances')).json()
const instance = listed.instances.find((item) => item.status === 'running') ?? listed.instances[0]
if (!instance) throw new Error('no managed instance is available')
if (instance.status !== 'running') await api(`/api/admin/instances/${instance.id}/start`, { method: 'POST' })

const ticket = await (await api('/api/admin/terminal/ticket', { method: 'POST', body: { instanceId: instance.id } })).json()
const wsUrl = new URL('/api/admin/terminal/ws', origin)
wsUrl.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:'
wsUrl.searchParams.set('ticket', ticket.ticket)
const socket = new WebSocket(wsUrl, { headers: { cookie, origin: origin.origin } })

let output = ''
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('terminal handshake timed out')), 15000)
  socket.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const message = JSON.parse(data.toString())
        if (message.type === 'ready') {
          socket.send(JSON.stringify({ type: 'resize', cols: 101, rows: 37 }))
          socket.send(JSON.stringify({ type: 'input', data: "printf '__ROOT__%s__SIZE__%s__\\n' \"$(id -u)\" \"$(stty size)\"\n" }))
          return
        }
      } catch { /* terminal text */ }
    }
    output += data.toString()
    if (output.includes('__ROOT__0__SIZE__37 101__')) {
      clearTimeout(timeout)
      resolve()
    }
  })
  socket.once('error', reject)
})

const suffix = `${process.pid}-${Date.now()}`
const path = `/tmp/dsh-terminal-smoke-${suffix}.txt`
const content = Buffer.from(`terminal file transfer ${suffix}\n`)
await api(`/api/admin/terminal/instances/${instance.id}/upload?path=${encodeURIComponent(path)}`, {
  method: 'POST', body: content, headers: { 'content-type': 'application/octet-stream' },
})
const downloaded = Buffer.from(await (await api(`/api/admin/terminal/instances/${instance.id}/download?path=${encodeURIComponent(path)}`)).arrayBuffer())
if (!downloaded.equals(content)) throw new Error('downloaded content differs from upload')

socket.send(JSON.stringify({ type: 'input', data: `rm -f -- ${path}\nexit\n` }))
await new Promise((resolve) => { socket.once('close', resolve); setTimeout(() => { socket.close(); resolve() }, 5000) })
console.log(`terminal smoke passed: ${instance.slug}, root shell, resize, upload/download`)
