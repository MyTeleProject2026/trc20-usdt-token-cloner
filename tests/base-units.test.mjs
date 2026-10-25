import test from 'node:test'
import assert from 'node:assert/strict'
import { isPositiveUint256, UINT256_MAX } from '../server/base-units.mjs'

const MAX = UINT256_MAX.toString()
const ABOVE_MAX = (UINT256_MAX + 1n).toString()

test('accepts the exact uint256 maximum without Number coercion', () => {
  assert.equal(isPositiveUint256(MAX), true)
  assert.equal(BigInt(MAX), UINT256_MAX)
})

test('rejects uint256 overflow and non-canonical base-unit strings', () => {
  for (const value of [
    ABOVE_MAX,
    '0',
    '00',
    '01',
    '-1',
    '+1',
    '1.0',
    '1e6',
    '',
    null,
    1,
    Number.MAX_SAFE_INTEGER,
    '9'.repeat(79),
  ]) {
    assert.equal(isPositiveUint256(value), false, String(value))
  }
})

test('accepts representative positive base-unit values', () => {
  for (const value of ['1', '1000000', '90071992547409931234567890']) {
    assert.equal(isPositiveUint256(value), true, value)
  }
})
