import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('Sponsor workspace exposes only an Owner-Admin-authorized paused ledger bootstrap', async () => {
  const source = await readFile(new URL('../src/SponsorWalletManager.jsx', import.meta.url), 'utf8')
  assert.match(source, /\/api\/sponsor\/ledger\/bootstrap/)
  assert.match(source, /adminToken/)
  assert.match(source, /schema-missing/)
  assert.match(source, /control-row-missing/)
  assert.match(source, /Initialize paused Sponsor ledger schema/)
  assert.match(source, /does not migrate historical records, enable writes, sign transactions or broadcast to Mainnet/)
  assert.match(source, /transactionExecutionAvailable/)
})
