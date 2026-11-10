import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluatePayoutActivationReadiness } from '../server/payout-activation-readiness.mjs'

test('blocks activation by default and preserves all execution safeguards', () => {
  const result = evaluatePayoutActivationReadiness({}, { amountUsdt: '1000' })
  assert.equal(result.status, 'payout-activation-blocked')
  assert.ok(result.blockers.includes('provider-payout-authorization-not-verified'))
  assert.ok(result.blockers.includes('wallet-specific-available-usdt-not-verified'))
  assert.ok(result.blockers.includes('neither-provider-owned-liquidity-nor-approved-credit-is-available'))
  assert.equal(result.executionEnabled, false)
  assert.equal(result.signingEnabled, false)
  assert.equal(result.broadcastingEnabled, false)
  assert.equal(result.transactionSubmitted, false)
})

test('requires the 1000 USDT minimum and rejects malformed amounts', () => {
  for (const amountUsdt of ['999.999999', '0', '-1000', '1e3', '1000.1234567', 'invalid']) {
    assert.ok(evaluatePayoutActivationReadiness({}, { amountUsdt }).blockers.includes('minimum-withdrawal-1000-usdt-not-met'))
  }
})

test('uses exact six-decimal integer arithmetic at the minimum boundary', () => {
  assert.ok(evaluatePayoutActivationReadiness({}, { amountUsdt: '999.999999' }).blockers.includes('minimum-withdrawal-1000-usdt-not-met'))
  assert.ok(!evaluatePayoutActivationReadiness({}, { amountUsdt: '1000.000000' }).blockers.includes('minimum-withdrawal-1000-usdt-not-met'))
  assert.ok(evaluatePayoutActivationReadiness({}, { amountUsdt: '999999999999999999999999999999999999999999999999999999999999999999999999999999.999999' }).blockers.includes('minimum-withdrawal-1000-usdt-not-met') === false)
})

test('does not confuse credit approval with provider-owned wallet liquidity', () => {
  const result = evaluatePayoutActivationReadiness({ creditFacilityApproved: true }, { amountUsdt: '1000' })
  assert.ok(!result.blockers.includes('neither-provider-owned-liquidity-nor-approved-credit-is-available'))
  assert.ok(result.blockers.includes('wallet-specific-available-usdt-not-verified'))
  assert.equal(result.executionEnabled, false)
})

test('requires all provider, asset, gas, screening, approval and settlement evidence', () => {
  const evidence = {
    providerAuthorizationVerified: true,
    providerWalletIdentityVerified: true,
    walletSpecificAvailableUsdtVerified: true,
    availableUsdtCoversRequestedAmount: true,
    tronMainnetUsdtContractVerified: true,
    tronMainnetGasAvailable: true,
    recipientScreeningCleared: true,
    withdrawalApprovalSatisfied: true,
    settlementReconciliationReady: true,
    providerOwnedLiquidityVerified: true,
  }
  const result = evaluatePayoutActivationReadiness(evidence, { amountUsdt: '1000' })
  assert.equal(result.status, 'payout-activation-ready-for-authorized-operator-review')
  assert.deepEqual(result.blockers, [])
  assert.equal(result.executionEnabled, false)
  assert.equal(result.signingEnabled, false)
  assert.equal(result.broadcastingEnabled, false)
})
