import test from 'node:test'
import assert from 'node:assert/strict'
import { classifySponsorDirectSettlement } from '../server/routes/sponsor-direct-payouts.mjs'
import { MAINNET_USDT_CONTRACT } from '../server/routes/tron-owner-withdrawals.mjs'

const sponsorAddress = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
const recipientAddress = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const transactionHash = 'a'.repeat(64)

function transfer(overrides = {}) {
  return {
    transaction_hash: transactionHash,
    sponsor_address: sponsorAddress,
    recipient_address: recipientAddress,
    token_contract: MAINNET_USDT_CONTRACT,
    amount_base_units: '25000000',
    ...overrides,
  }
}

function verified(overrides = {}) {
  return {
    verified: true,
    transactionHash,
    contract: MAINNET_USDT_CONTRACT,
    from: sponsorAddress,
    to: recipientAddress,
    amountBaseUnits: '25000000',
    blockNumber: 123456,
    logIndex: 0,
    ...overrides,
  }
}

test('settlement classifier confirms only exact solidified Mainnet USDT evidence', () => {
  assert.deepEqual(
    classifySponsorDirectSettlement({ transfer: transfer(), verification: verified() }),
    { status: 'confirmed', blockNumber: 123456, logIndex: 0, reason: null },
  )
})

test('settlement classifier sends any transaction identity mismatch to manual review', () => {
  const result = classifySponsorDirectSettlement({
    transfer: transfer(),
    verification: verified({ to: sponsorAddress }),
  })
  assert.equal(result.status, 'manual-review')
  assert.equal(result.reason, 'solidified-evidence-identity-mismatch')
})

test('settlement classifier keeps an unsolidified receipt pending', () => {
  const result = classifySponsorDirectSettlement({
    transfer: transfer(),
    verification: { verified: false, status: 'awaiting-solidified-receipt' },
  })
  assert.equal(result.status, 'pending')
  assert.equal(result.reason, 'awaiting-solidified-receipt')
})

test('settlement classifier marks a solidified failed transaction as failed', () => {
  const result = classifySponsorDirectSettlement({
    transfer: transfer(),
    verification: { verified: false, status: 'solidified-transaction-failed' },
  })
  assert.equal(result.status, 'failed')
  assert.equal(result.reason, 'confirmed-solidified-transaction-failed')
})

test('settlement classifier sends a malformed stored intent to manual review', () => {
  const result = classifySponsorDirectSettlement({
    transfer: transfer({ token_contract: recipientAddress }),
    verification: verified(),
  })
  assert.equal(result.status, 'manual-review')
  assert.equal(result.reason, 'stored-settlement-intent-invalid')
})

test('settlement classifier never treats provider errors or missing evidence as confirmation', () => {
  const result = classifySponsorDirectSettlement({
    transfer: transfer(),
    verification: { verified: false, status: 'solidified-provider-unavailable' },
  })
  assert.equal(result.status, 'pending')
});
