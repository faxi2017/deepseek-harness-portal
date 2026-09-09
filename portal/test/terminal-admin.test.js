import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'dsh-terminal-test-'))
process.env.DATA_DIR = dataDir
const { containerPath, terminalTicketCanAccessInstance, TERMINAL_MAX_FILE_BYTES, TERMINAL_WS_PATH } = await import('../src/terminal-admin.js')
const { db } = await import('../src/db.js')

test.after(() => {
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})

test('terminal paths require bounded absolute container paths', () => {
  assert.equal(containerPath('/home/dsh/.dsh/config.json'), '/home/dsh/.dsh/config.json')
  assert.equal(containerPath('relative/config.json'), null)
  assert.equal(containerPath('/tmp/bad\0name'), null)
  assert.equal(containerPath(`/tmp/${'a'.repeat(4096)}`), null)
})

test('terminal protocol exposes fixed limits and endpoint', () => {
  assert.equal(TERMINAL_WS_PATH, '/api/admin/terminal/ws')
  assert.equal(TERMINAL_MAX_FILE_BYTES, 16 * 1024 * 1024)
})

test('user terminal tickets are limited to their own instance while admin tickets can select instances', () => {
  const own = { id: 11, user_id: 7 }
  const sibling = { id: 12, user_id: 8 }
  assert.equal(terminalTicketCanAccessInstance({ userId: 7, admin: false }, own, { id: 7, role: 'user' }), true)
  assert.equal(terminalTicketCanAccessInstance({ userId: 7, admin: false }, sibling, { id: 7, role: 'user' }), false)
  assert.equal(terminalTicketCanAccessInstance({ userId: 7, admin: true }, sibling, { id: 7, role: 'admin' }), true)
  assert.equal(terminalTicketCanAccessInstance({ userId: 7, admin: true }, sibling, { id: 7, role: 'user' }), false)
})
