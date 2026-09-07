import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'dsh-release-manager-test-'))
Object.assign(process.env, {
  DATA_DIR: dataDir,
  DSH_IMAGE: `sha256:${'a'.repeat(64)}`,
})

const originalFetch = global.fetch
const requests = []
global.fetch = async (url) => {
  requests.push(String(url))
  return new Response('', { status: 404 })
}

const { resolveRequestedVersion } = await import('../src/dsh-release-manager.js')

test('an unpublished explicit DSH version is rejected before Docker build preparation', async () => {
  await assert.rejects(resolveRequestedVersion('0.1.2-rc.2'), /0\.1\.2-rc\.2 尚未发布/)
  assert.deepEqual(requests, ['https://registry.npmjs.org/@deepseek-ai%2Fdsh/0.1.2-rc.2'])
})

test.after(async () => {
  global.fetch = originalFetch
  const { db } = await import('../src/db.js')
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})
