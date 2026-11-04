import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildFincraPayoutAuthorizationMessage,
  isFincraPayoutAuthorizationExpiryValid,
} from '../src/fincra-payout-auth.mjs'

const fixture = {
  origin: 'https://trc20-usdt-token-cloner.onrender.com',
  ownerAddress: 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2',
  recipientAddress: 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2',
  accountHolderName: 'Test Recipient',
  amountBaseUnits: '12500000',
  customerReference: 'tts-fincra-test-000001',
  authorizationExpiresAt: 2_000_000_000_000,
}

test('Fincra payout authorization binds exact provider, network, recipient, name, amount and reference', () => {
  const message = buildFincraPayoutAuthorizationMessage(fixture)
  assert.match(message, /Payout scheme: usdt_trc20/)
  assert.match(message, /Token contract: TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t/)
  assert.match(message, /Recipient: TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2/)
  assert.match(message, /Beneficiary name: Test Recipient/)
  assert.match(message, /Amount base units: 12500000/)
  assert.match(message, /Customer reference: tts-fincra-test-000001/)
})

test('Fincra payout authorization rejects incomplete or unsafe values', () => {
  assert.throws(() => buildFincraPayoutAuthorizationMessage({ ...fixture, amountBaseUnits: '0' }))
  assert.throws(() => buildFincraPayoutAuthorizationMessage({ ...fixture, recipientAddress: 'not-a-tron-address' }))
  assert.throws(() => buildFincraPayoutAuthorizationMessage({ ...fixture, accountHolderName: ' ' }))
  assert.throws(() => buildFincraPayoutAuthorizationMessage({ ...fixture, customerReference: 'short' }))
})

test('Fincra payout authorization expires within the configured short window', () => {
  assert.equal(isFincraPayoutAuthorizationExpiryValid(1100, 1000, 120), true)
  assert.equal(isFincraPayoutAuthorizationExpiryValid(1200, 1000, 120), true)
  assert.equal(isFincraPayoutAuthorizationExpiryValid(1201, 1000, 120), false)
  assert.equal(isFincraPayoutAuthorizationExpiryValid(1000, 1000, 120), false)
})
