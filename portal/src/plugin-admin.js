import { listInstancesWithUsers, getInstanceById, getInstanceByUserId } from './db.js'
import {
  pluginDefaults, pluginInventory, protectedPluginNames, savePluginDefaults,
  pluginState, pluginsBusy, queuePluginInstalls, validPluginName,
} from './plugins.js'
import { scanInstancePlugins, uninstallInstancePlugin } from './orchestrator.js'

function inventoryPayload(instanceId, inventory, scanError = '') {
  const protectedNames = protectedPluginNames()
  return {
    instanceId,
    plugins: inventory.plugins.map((plugin) => ({ ...plugin, protected: protectedNames.has(plugin.name) })),
    updatedAt: inventory.updatedAt,
    stale: Boolean(scanError),
    scanError,
  }
}

async function readInventory(instanceId, refresh) {
  let inventory = pluginInventory(instanceId)
  let scanError = ''
  if (refresh || inventory.updatedAt === null) {
    try { inventory = await scanInstancePlugins(instanceId) }
    catch { scanError = '暂时无法读取实例插件，显示上次成功记录。' }
  }
  return inventoryPayload(instanceId, inventory, scanError)
}

async function removePlugin(instanceId, packageName) {
  if (!validPluginName(packageName)) return { status: 400, error: '插件名称格式不正确。' }
  if (protectedPluginNames().has(packageName)) return { status: 400, error: '平台默认插件不能在救援页面卸载。' }
  let current
  try { current = await scanInstancePlugins(instanceId) }
  catch { return { status: 409, error: '当前无法读取插件清单，请稍后重试。' } }
  if (!current.plugins.some((plugin) => plugin.name === packageName)) return { status: 404, error: '插件未安装或已经卸载。' }
  try {
    const result = await uninstallInstancePlugin(instanceId, packageName)
    return { status: 200, result: inventoryPayload(instanceId, result) }
  } catch {
    return { status: 500, error: '插件卸载失败，原有记录和数据已保留。' }
  }
}

export function registerPluginAdmin(app, { requireAdmin, requireUser }) {
  app.get('/api/profile/plugins', async (req, reply) => {
    const user = requireUser(req, reply)
    if (!user) return
    const inst = getInstanceByUserId(user.id)
    if (!inst) return reply.code(404).send({ error: '当前账号没有实例。' })
    return readInventory(inst.id, req.query?.refresh === '1')
  })
  app.post('/api/profile/plugins/uninstall', async (req, reply) => {
    const user = requireUser(req, reply)
    if (!user) return
    const inst = getInstanceByUserId(user.id)
    if (!inst) return reply.code(404).send({ error: '当前账号没有实例。' })
    const outcome = await removePlugin(inst.id, req.body?.packageName)
    if (outcome.error) return reply.code(outcome.status).send({ error: outcome.error })
    return outcome.result
  })
  app.get('/api/admin/plugins/inventory', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const instanceId = Number(req.query?.instanceId)
    const inst = getInstanceById(instanceId)
    if (!Number.isSafeInteger(instanceId) || !inst || inst.status === 'deleting') return reply.code(404).send({ error: '实例不存在。' })
    return readInventory(instanceId, req.query?.refresh === '1')
  })
  app.post('/api/admin/plugins/uninstall', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const instanceId = req.body?.instanceId
    const inst = getInstanceById(instanceId)
    if (!Number.isSafeInteger(instanceId) || !inst || inst.status === 'deleting') return reply.code(404).send({ error: '实例不存在。' })
    const outcome = await removePlugin(instanceId, req.body?.packageName)
    if (outcome.error) return reply.code(outcome.status).send({ error: outcome.error })
    return outcome.result
  })
  app.get('/api/admin/plugins', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    return { ...pluginDefaults(), busy: pluginsBusy(), instances: listInstancesWithUsers()
      .filter((i) => i.user_role !== 'admin').map((i) => ({ id: i.id, username: i.username, status: i.status, plugin: pluginState(i.id) ?? null })) }
  })
  app.post('/api/admin/plugins', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    if (pluginsBusy()) return reply.code(409).send({ error: '有插件任务正在处理，请完成后再修改默认配置。' })
    try { return savePluginDefaults(req.body?.commands) }
    catch (error) { return reply.code(400).send({ error: error.message }) }
  })
  app.post('/api/admin/plugins/apply', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    if (!pluginDefaults().commands) return reply.code(400).send({ error: '请先保存默认插件命令。' })
    const requested = req.body?.instanceId
    const ids = requested === undefined
      ? listInstancesWithUsers().filter((i) => i.user_role !== 'admin' && i.status !== 'deleting').map((i) => i.id)
      : [requested]
    if (ids.some((id) => !Number.isSafeInteger(id) || !getInstanceById(id) || getInstanceById(id).status === 'deleting')) return reply.code(400).send({ error: '实例不存在或正在删除。' })
    queuePluginInstalls(ids)
    return reply.code(202).send({ ok: true, count: ids.length })
  })
}
