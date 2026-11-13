import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTokenUnits, formatTokenUnits } from '../src/trax-mainnet.mjs'

test('TRӾ amount conversion preserves six decimal places exactly', () => {
  assert.equal(parseTokenUnits('100'), '100000000')
  assert.equal(parseTokenUnits('0.000001'), '1')
  assert.equal(parseTokenUnits('12.345678'), '12345678')
  assert.equal(formatTokenUnits('100000000'), '100')
  assert.equal(formatTokenUnits('12345678'), '12.345678')
})

test('TRӾ amount parser rejects invalid precision and non-positive values', () => {
  for (const value of ['', '0', '0.0', '-1', '1e3', '1.0000001', '01', 'NaN']) {
    assert.throws(() => parseTokenUnits(value))
  }
})

test('TRӾ address comparison normalizes TRON address forms', () => {
  const tronWeb = { address: { toHex: (value) => value.toLowerCase() } }
  assert.equal(
    (await import('../src/trax-mainnet.mjs')).addressesEqual(tronWeb, 'TABC', 'tabc'),
    true,
  )
})
