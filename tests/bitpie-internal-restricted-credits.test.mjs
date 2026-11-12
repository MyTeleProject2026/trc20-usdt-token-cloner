import test from 'node:test'
import assert from 'node:assert/strict'
import { parseInternalCreditAmountSun } from '../server/routes/bitpie-internal-restricted-credits.mjs'

test('internal credit amount accepts positive integer SUN only', () => {
  assert.equal(parseInternalCreditAmountSun('6200000000'), '6200000000')
  assert.equal(parseInternalCreditAmountSun('1'), '1')
})

test('internal credit amount rejects zero, decimals, exponent notation and unsafe lengths', () => {
  for (const value of ['0', '-1', '1.2', '1e6', '', ' 10', '1'.repeat(25), null]) {
    assert.throws(() => parseInternalCreditAmountSun(value))
  }
})

test('internal credit is explicitly non-asset and has no Bitpie or blockchain effect', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../server/routes/bitpie-internal-restricted-credits.mjs', import.meta.url), 'utf8')
  assert.match(source, /display_only_non_asset/)
  assert.match(source, /restricted_internal_only/)
  assert.match(source, /bitpieWalletBalanceChanged: false/)
  assert.match(source, /blockchainBalanceChanged: false/)
  assert.match(source, /withdrawalEnabled: false/)
  assert.doesNotMatch(source, /client\.(?:send|transfer|withdraw|broadcast)[A-Z_a-z]*\(/)
  assert.doesNotMatch(source, /bitpie\.com\/(?:api|v[0-9])/i)
})

test('server mounts the owner-only ledger and UI labels it as non-asset bookkeeping', async () => {
  const { readFile } = await import('node:fs/promises')
  const server = await readFile(new URL('../server/index.mjs', import.meta.url), 'utf8')
  const ui = await readFile(new URL('../Frontend-Tron-Transfer/src/BitpieInternalRestrictedCredits.jsx', import.meta.url), 'utf8')
  assert.match(server, /bitpieInternalRestrictedCreditsRoutes/)
  assert.match(server, /app\.use\('\/api\/owner\/bitpie-internal-credits'/)
  assert.match(ui, /INTERNAL LEDGER ONLY/)
  assert.match(ui, /Not a Bitpie wallet credit/)
  assert.match(ui, /not backed by blockchain TRX/)
  assert.match(ui, /No Bitpie endpoint is called/)
})


test('owner panel defaults to the confirmed Bitpie recipient without claiming Bitpie connectivity', async () => {
  const { readFile } = await import('node:fs/promises')
  const ui = await readFile(new URL('../Frontend-Tron-Transfer/src/BitpieInternalRestrictedCredits.jsx', import.meta.url), 'utf8')
  assert.match(ui, /VITE_RESTRICTED_TRX_BENEFICIARY_ADDRESS \|\| 'TLBWTZHjjRMwbFgKgqmLwjp4ZKjxt5a2GT'/)
  assert.match(ui, /Not a Bitpie wallet credit/)
  assert.match(ui, /Bitpie API status/)
})
