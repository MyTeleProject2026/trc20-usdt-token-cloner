import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const app = await readFile(new URL('../src/WorkflowApp.tsx', import.meta.url), 'utf8')
const entry = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8')
const routes = await readFile(new URL('../server/routes/native-tron.mjs', import.meta.url), 'utf8')

test('receiver history remains a separate read-only backend capability', () => {
  assert.ok(app.includes('ReceiverHistoryRecord'))
  assert.ok(app.includes('isVerifiedHistoryRecord'))
  assert.ok(app.includes('verifiedOnChain'))
  assert.ok(!app.includes('setInterval('))
  assert.ok(entry.includes("import App from './WorkflowApp.tsx'"))
  assert.ok(!entry.includes('ReceiverHistory'))
})

test('receiver history remains a separate read-only backend capability', () => {
  assert.ok(routes.includes("router.get('/receiver-history'"))
  assert.ok(routes.includes('verifiedOnChain'))
  assert.ok(routes.includes('only_confirmed'))
  assert.doesNotMatch(routes, /sendRawTransaction|broadcasttransaction/i)
})
