import { db, getSetting, setSetting, getInstanceById } from './db.js'
import { docker } from './docker.js'

db.exec(`CREATE TABLE IF NOT EXISTS instance_plugins (
  instance_id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, commands TEXT NOT NULL,
  state TEXT NOT NULL, message TEXT NOT NULL DEFAULT '', installed TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
)`)
db.exec(`CREATE TABLE IF NOT EXISTS instance_plugin_inventory (
  instance_id INTEGER PRIMARY KEY, plugins TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL
)`)

const PLUGIN_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const PLUGIN_VERSION_RE = /(?:\\?@[a-zA-Z0-9][a-zA-Z0-9.+_-]*)?/
const PLUGIN_SPEC_RE = new RegExp(`^((?:@[a-z0-9][a-z0-9._-]*\\/)?[a-z0-9][a-z0-9._-]*)(${PLUGIN_VERSION_RE.source})$`)
const DSH_NPX_RE = /@deepseek-ai\/dsh(?:@[a-zA-Z0-9][a-zA-Z0-9.+_-]*)?/

export function validPluginName(value) {
  return typeof value === 'string' && PLUGIN_NAME_RE.test(value)
}

function pluginTarballUrl(value) {
  if (!value.startsWith('https://')) return null
  let url
  try { url = new URL(value) } catch { return null }
  if (url.username || url.password || url.search || url.hash || !url.pathname.toLowerCase().endsWith('.tgz')) return null
  return url.href
}

export function parsePluginCommands(text) {
  if (typeof text !== 'string' || text.length > 8192) throw new Error('安装命令最长 8192 个字符。')
  const commands = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (commands.length > 20) throw new Error('最多设置 20 个默认插件。')
  const sources = new Set()
  return commands.map((command) => {
    const forms = [
      /^dsh\s+plugin\s+--profile\s+web\s+add\s+(?:-w\s+)?(.+)$/,
      new RegExp(`^npx\\s+(?:-y\\s+|--yes\\s+)?${DSH_NPX_RE.source}\\s+plugin\\s+--profile\\s+web\\s+add\\s+(?:-w\\s+)?(.+)$`),
      /^npm\s+(?:install|i)\s+(?:--save(?:-prod)?\s+)?(.+)$/,
    ]
    const specText = forms.map((pattern) => pattern.exec(command)?.[1]).find(Boolean)
    const tarball = pluginTarballUrl(specText ?? '')
    if (tarball) {
      if (sources.has(tarball)) throw new Error('同一个插件只能配置一次。')
      sources.add(tarball)
      return { name: null, spec: tarball, command: `dsh plugin --profile web add -w ${tarball}` }
    }
    const match = PLUGIN_SPEC_RE.exec(specText ?? '')
    if (!match) throw new Error('每行仅支持 DSH 插件或 npm 安装格式：dsh plugin --profile web add -w 包名、npx @deepseek-ai/dsh plugin --profile web add -w 包名、npm install 包名，或 HTTPS .tgz 插件包；不支持全局安装、路径、脚本或其他 npm 参数。')
    const name = match[1]
    if (sources.has(name)) throw new Error('同一个插件只能配置一次。')
    sources.add(name)
    const spec = name + (match[2] ?? '').replace(/^\\@/, '@')
    // DSH profiles are pnpm workspace roots. Always pass -w to the installed
    // DSH CLI, including when the admin pasted the equivalent npx/npm form.
    return { name, spec, command: `dsh plugin --profile web add -w ${spec}` }
  })
}

export const pluginDefaults = () => JSON.parse(getSetting('plugin_defaults', '{"revision":0,"commands":""}'))
export const pluginState = (id) => db.prepare('SELECT * FROM instance_plugins WHERE instance_id=?').get(id)
export function pluginInventory(id) {
  const row = db.prepare('SELECT plugins,updated_at FROM instance_plugin_inventory WHERE instance_id=?').get(id)
  return row ? { plugins: JSON.parse(row.plugins), updatedAt: row.updated_at } : { plugins: [], updatedAt: null }
}
export function recordPluginInventory(id, plugins) {
  const normalized = [...plugins].sort((a, b) => a.name.localeCompare(b.name))
  const updatedAt = Date.now()
  db.prepare(`INSERT INTO instance_plugin_inventory(instance_id,plugins,updated_at) VALUES(?,?,?)
    ON CONFLICT(instance_id) DO UPDATE SET plugins=excluded.plugins,updated_at=excluded.updated_at`)
    .run(id, JSON.stringify(normalized), updatedAt)
  return { plugins: normalized, updatedAt }
}
export function protectedPluginNames() {
  const names = new Set(['dshmarket'])
  for (const plugin of parsePluginCommands(pluginDefaults().commands)) if (plugin.name) names.add(plugin.name)
  return names
}
export const pluginsBusy = () => Boolean(db.prepare("SELECT 1 FROM instance_plugins WHERE state IN ('queued','running') LIMIT 1").get())
export function savePluginDefaults(commands) {
  const normalized = parsePluginCommands(commands).map((p) => p.command).join('\n')
  const old = pluginDefaults()
  const policy = { revision: normalized === old.commands ? old.revision : old.revision + 1, commands: normalized }
  setSetting('plugin_defaults', JSON.stringify(policy))
  return policy
}
export function recordPluginState(id, policy, state, message = '', installed = []) {
  db.prepare(`INSERT INTO instance_plugins(instance_id,revision,commands,state,message,installed,updated_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(instance_id) DO UPDATE SET revision=excluded.revision,
    commands=excluded.commands,state=excluded.state,message=excluded.message,installed=excluded.installed,updated_at=excluded.updated_at`)
    .run(id, policy.revision, policy.commands, state, message, JSON.stringify(installed), Date.now())
}
export function recoverPluginJobs() {
  db.prepare("UPDATE instance_plugins SET state='failed',message='平台重启中断了任务，请检查实例后重试。',updated_at=? WHERE state IN ('queued','running')").run(Date.now())
}

const inspectInstalled = `const fs=require('fs');const path=require('path');
const root='/home/dsh/.dsh/profiles/web';const p=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));const bundles=new Set(p.dsh?.profile?.bundles??[]);const result=[];
for(const name of bundles){try{const m=JSON.parse(fs.readFileSync(path.join(root,'node_modules',name,'package.json'),'utf8'));if(p.dependencies?.[name]&&m.dsh?.bundle?.patch)result.push({name,version:m.version})}catch{}}
console.log(JSON.stringify(result));`

export async function installPluginCommands(name, commands) {
  const plugins = parsePluginCommands(commands)
  for (const plugin of plugins) {
    // No shell or user-supplied flags. The in-container timeout also bounds work
    // if the Portal process exits; flock rejects overlapping installs on retry.
    await docker(['exec', '--user', '1000:1000', '-e', 'CI=true', name,
      'flock', '-n', '/home/dsh/.dsh/portal-plugin-install.lock',
      'timeout', '--signal=TERM', '--kill-after=10s', '300s',
      'dsh', 'plugin', '--profile', 'web', 'add', '-w', plugin.spec], { timeout: 330000 })
  }
  const { stdout } = await docker(['exec', '--user', '1000:1000', name, 'node', '-e', inspectInstalled])
  return JSON.parse(stdout)
}

let queue = Promise.resolve()
export function queuePluginInstalls(ids) {
  const policy = pluginDefaults()
  for (const id of ids) {
    const current = pluginState(id)
    if (['queued', 'running'].includes(current?.state)) continue
    recordPluginState(id, policy, 'queued', '等待安装')
    queue = queue.catch(() => {}).then(async () => {
      const inst = getInstanceById(id)
      if (!inst || inst.status === 'deleting') {
        recordPluginState(id, policy, 'failed', '实例已删除或正在删除。')
        return
      }
      const { applyDefaultPlugins } = await import('./orchestrator.js')
      await applyDefaultPlugins(id, policy)
    }).catch(() => recordPluginState(id, policy, 'failed', '插件安装未完成，请检查实例状态后重试。'))
  }
  return queue
}
