import test from 'node:test'
import assert from 'node:assert/strict'
import { isValidTronAddress } from '../server/tron-address.mjs'

test('accepts known Base58Check TRON addresses, including official mainnet USDT contract', () => {
  assert.equal(isValidTronAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'), true)
  assert.equal(isValidTronAddress('TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'), true)
  assert.equal(isValidTronAddress('TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'), true)
})

test('rejects malformed addresses and Base58 strings with a bad checksum', () => {
  assert.equal(isValidTronAddress(''), false)
  assert.equal(isValidTronAddress('TAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), false)
  assert.equal(isValidTronAddress('TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u3'), false)
  assert.equal(isValidTronAddress('0OIl'), false)
  assert.equal(isValidTronAddress(null), false)
  assert.equal(isValidTronAddress(123), false)
})
