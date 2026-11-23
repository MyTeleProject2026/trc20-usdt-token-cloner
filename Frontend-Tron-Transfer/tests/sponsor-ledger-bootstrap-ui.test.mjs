import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('Sponsor workspace exposes only an Owner-Admin-authorized paused ledger bootstrap', async () => {
  const source = await readFile(new URL('../src/SponsorWalletManager.jsx', import.meta.url), 'utf8')
  const api = await readFile(new URL('../resource-api/sponsor-api.mjs', import.meta.url), 'utf8')
  assert.ok(source.includes('/api/sponsor/ledger/bootstrap'))
  assert.ok(source.includes('async function bootstrapSponsorLedger()'))
  assert.ok(source.includes("await ensureOwnerAdmin()"))
  assert.ok(source.includes("ownerAuth.apiRequest('/api/sponsor/ledger/bootstrap'"))
  assert.ok(source.includes("method: 'POST',\n        csrf: true,"))
  assert.ok(source.includes("body: { confirm: 'INITIALIZE_SPONSOR_LEDGER_SCHEMA' }"))
  assert.ok(source.includes("setSponsorApiStatus(status)"))
  assert.ok(source.includes('Initialize paused Sponsor ledger schema'))
  assert.ok(source.includes('does not migrate historical records, enable writes, sign transactions or broadcast to Mainnet'))
  assert.ok(source.includes('transactionExecutionAvailable'))
  assert.ok(api.includes("req.method === 'POST' && path === '/api/sponsor/ledger/bootstrap'"))
  assert.ok(api.includes('verifyAdminAuthorization(req)'))
  assert.ok(api.includes('authenticateOwnerAdminSession'))
  assert.ok(source.includes('Independent Owner Admin authorization'))
  assert.ok(!source.includes('x-sponsor-admin-token'))
})
