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
