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

export function validPluginName(value) {
  return typeof value === 'string' && PLUGIN_NAME_RE.test(value)
}

export function parsePluginCommands(text) {
  if (typeof text !== 'string' || text.length > 8192) throw new Error('安装命令最长 8192 个字符。')
  const commands = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (commands.length > 20) throw new Error('最多设置 20 个默认插件。')
  const names = new Set()
  return commands.map((command) => {
    const match = /^dsh\s+plugin\s+--profile\s+web\s+add\s+((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(@[a-zA-Z0-9][a-zA-Z0-9.+_-]*)?$/.exec(command)
    if (!match) throw new Error('每行仅支持 dsh plugin --profile web add npm包名，可在包名后加 @版本；不支持其他命令、路径或附加参数。')
    const name = match[1]
    if (names.has(name)) throw new Error('同一个插件只能配置一次。')
    names.add(name)
    const spec = name + (match[2] ?? '')
    return { name, spec, command: `dsh plugin --profile web add ${spec}` }
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
  for (const plugin of parsePluginCommands(pluginDefaults().commands)) names.add(plugin.name)
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
const root='/home/dsh/.dsh/profiles/web';const p=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const result=process.argv.slice(1).map(name=>{const m=JSON.parse(fs.readFileSync(path.join(root,'node_modules',name,'package.json'),'utf8'));
if(!p.dependencies?.[name]||!p.dsh?.profile?.bundles?.includes(name)||!m.dsh?.bundle?.patch)throw new Error('Plugin not enabled');
return {name,version:m.version};});console.log(JSON.stringify(result));`

export async function installPluginCommands(name, commands) {
  const plugins = parsePluginCommands(commands)
  for (const plugin of plugins) {
    // No shell or user-supplied flags. The in-container timeout also bounds work
    // if the Portal process exits; flock rejects overlapping installs on retry.
    await docker(['exec', '--user', '1000:1000', '-e', 'CI=true', name,
      'flock', '-n', '/home/dsh/.dsh/portal-plugin-install.lock',
      'timeout', '--signal=TERM', '--kill-after=10s', '300s',
      'dsh', 'plugin', '--profile', 'web', 'add', plugin.spec], { timeout: 330000 })
  }
  const { stdout } = await docker(['exec', '--user', '1000:1000', name, 'node', '-e', inspectInstalled, ...plugins.map((p) => p.name)])
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
