import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('TronLink connection refreshes sponsor role snapshots with sender chain reads', async () => {
  const source = await readFile(path.join(root, 'src', 'WorkflowApp.tsx'), 'utf8')
  const start = source.indexOf('  const connectTronLink = async () => {')
  const end = source.indexOf('  const inspectWatchAddress = async () => {', start)

  assert.notEqual(start, -1, 'connectTronLink handler must exist')
  assert.ok(end > start, 'connectTronLink handler must have a closing boundary')

  const handler = source.slice(start, end)
  assert.match(handler, /Promise\.allSettled\s*\(\s*\[/, 'wallet and sponsor reads should run together without making wallet identity depend on provider read success')
  assert.match(handler, /readSenderSnapshots\(address\)/, 'sender balances should still be refreshed')
  assert.match(handler, /loadSponsorStatus\(true\)/, 'fee and principal sponsor snapshots should be force-refreshed on connect')
})
