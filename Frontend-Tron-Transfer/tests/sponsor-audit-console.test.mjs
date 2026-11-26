import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = path => readFile(new URL(path, import.meta.url), 'utf8')

test('Owner history workspace exposes the authenticated read-only Sponsor audit', async () => {
  const [panel, api] = await Promise.all([
    read('../src/TRXMainnetPanel.jsx'),
    read('../resource-api/sponsor-api.mjs'),
  ])
  assert.ok(panel.includes("wallet.authClient.apiRequest('/api/sponsor/audit?limit=50')"))
  assert.ok(panel.includes('Read-only Sponsor audit'))
  assert.ok(panel.includes('Refresh Sponsor audit'))
  assert.ok(panel.includes('signed payloads included: No'))
  assert.ok(api.includes("path === '/api/sponsor/audit'"))
  assert.ok(api.includes('verifyAdminAuthorization(req)'))
  assert.ok(api.includes('signedTransactionPayloadsIncluded: false'))
})

test('Sponsor audit UI never renders prepared or signed transaction payload fields', async () => {
  const panel = await read('../src/TRXMainnetPanel.jsx')
  const start = panel.indexOf('aria-label="Sponsor audit journal"')
  assert.notEqual(start, -1)
  const audit = panel.slice(start, panel.indexOf("{show('balance')", start))
  assert.ok(audit.includes('operation.transaction_id'))
  assert.ok(audit.includes('operation.result_code'))
  assert.equal(audit.includes('prepared_transaction'), false)
  assert.equal(audit.includes('signed_transaction'), false)
  assert.equal(audit.includes('unsignedTransaction'), false)
})

test('Owner deployment resource preflight displays the actual Mainnet RPC providers used', async () => {
  const panel = await read('../src/TRXMainnetPanel.jsx')
  assert.ok(panel.includes('Mainnet RPC sources: Energy'))
  assert.ok(panel.includes('providersUsed?.accountResources'))
  assert.ok(panel.includes('providersUsed?.account'))
  assert.ok(panel.includes('providersUsed?.chainParameters'))
})
