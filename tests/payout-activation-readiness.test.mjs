import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluatePayoutActivationReadiness } from '../server/payout-activation-readiness.mjs'

test('blocks activation by default and preserves all execution safeguards', () => {
  const result = evaluatePayoutActivationReadiness({}, { amountUsdt: '1000' })
  assert.equal(result.status, 'payout-activation-blocked')
  assert.ok(result.blockers.includes('provider-payout-authorization-not-verified'))
  assert.ok(result.blockers.includes('wallet-specific-available-usdt-not-verified'))
  assert.ok(result.blockers.includes('neither-provider-owned-liquidity-nor-evidenced-approved-credit-permitted-for-requested-tron-usdt-withdrawal-is-available'))
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
  assert.ok(result.blockers.includes('neither-provider-owned-liquidity-nor-evidenced-approved-credit-permitted-for-requested-tron-usdt-withdrawal-is-available'))
  assert.ok(result.blockers.includes('wallet-specific-available-usdt-not-verified'))
  assert.equal(result.executionEnabled, false)
})

test('requires explicit TRON USDT withdrawal permitted-use scope for an approved credit facility', () => {
  const approvedButUnscoped = evaluatePayoutActivationReadiness({ creditFacilityApproved: true }, { amountUsdt: '1000' })
  assert.ok(approvedButUnscoped.blockers.includes('neither-provider-owned-liquidity-nor-evidenced-approved-credit-permitted-for-requested-tron-usdt-withdrawal-is-available'))
  const permitted = evaluatePayoutActivationReadiness({ creditFacilityApproved: true, creditFacilityUsePermittedForTronUsdtWithdrawals: true, creditFacilityApprovalReference: 'approval-2026-001', creditFacilityUseAuthorizationReference: 'use-auth-2026-001', creditFacilityValidUntil: '2099-12-31T23:59:59.000Z', creditFacilityApprovedLimitUsdt: '5000' }, { amountUsdt: '1000' })
  assert.ok(!permitted.blockers.includes('neither-provider-owned-liquidity-nor-evidenced-approved-credit-permitted-for-requested-tron-usdt-withdrawal-is-available'))
  assert.equal(permitted.executionEnabled, false)
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
    providerLiquidityEvidenceReference: 'custody-proof-2026-001',
  }
  const result = evaluatePayoutActivationReadiness(evidence, { amountUsdt: '1000' })
  assert.equal(result.status, 'payout-activation-ready-for-authorized-operator-review')
  assert.deepEqual(result.blockers, [])
  assert.equal(result.executionEnabled, false)
  assert.equal(result.signingEnabled, false)
  assert.equal(result.broadcastingEnabled, false)
})


test('rejects credit flags without traceable approval, permitted-use, expiry and sufficient limit evidence', () => {
  const base = { creditFacilityApproved: true, creditFacilityUsePermittedForTronUsdtWithdrawals: true }
  const result = evaluatePayoutActivationReadiness(base, { amountUsdt: '1000' })
  assert.ok(result.blockers.includes('neither-provider-owned-liquidity-nor-evidenced-approved-credit-permitted-for-requested-tron-usdt-withdrawal-is-available'))
  const insufficient = evaluatePayoutActivationReadiness({ ...base, creditFacilityApprovalReference: 'approval-2026-002', creditFacilityUseAuthorizationReference: 'use-auth-2026-002', creditFacilityValidUntil: '2099-12-31T23:59:59.000Z', creditFacilityApprovedLimitUsdt: '999.999999' }, { amountUsdt: '1000' })
  assert.ok(insufficient.blockers.includes('neither-provider-owned-liquidity-nor-evidenced-approved-credit-permitted-for-requested-tron-usdt-withdrawal-is-available'))
  assert.equal(insufficient.executionEnabled, false)
})


test('rejects expired, malformed and insufficient approved credit limits', () => {
  const base = {
    creditFacilityApproved: true,
    creditFacilityUsePermittedForTronUsdtWithdrawals: true,
    creditFacilityApprovalReference: 'approval-2026-003',
    creditFacilityUseAuthorizationReference: 'use-auth-2026-003',
    creditFacilityValidUntil: '2099-12-31T23:59:59.000Z',
    creditFacilityApprovedLimitUsdt: '1000.000000',
  }
  const expired = evaluatePayoutActivationReadiness({ ...base, creditFacilityValidUntil: '2000-01-01T00:00:00.000Z' }, { amountUsdt: '1000' })
  assert.ok(expired.blockers.includes('neither-provider-owned-liquidity-nor-evidenced-approved-credit-permitted-for-requested-tron-usdt-withdrawal-is-available'))
  const malformed = evaluatePayoutActivationReadiness({ ...base, creditFacilityApprovedLimitUsdt: '1e3' }, { amountUsdt: '1000' })
  assert.ok(malformed.blockers.includes('neither-provider-owned-liquidity-nor-evidenced-approved-credit-permitted-for-requested-tron-usdt-withdrawal-is-available'))
  const exact = evaluatePayoutActivationReadiness(base, { amountUsdt: '1000' })
  assert.ok(!exact.blockers.includes('neither-provider-owned-liquidity-nor-evidenced-approved-credit-permitted-for-requested-tron-usdt-withdrawal-is-available'))
  assert.equal(exact.executionEnabled, false)
})


test('rejects excessively long amount and credit-limit inputs before BigInt parsing', () => {
  const oversizedAmount = '9'.repeat(41)
  const amountResult = evaluatePayoutActivationReadiness({}, { amountUsdt: oversizedAmount })
  assert.ok(!amountResult.blockers.includes('minimum-withdrawal-1000-usdt-not-met'))
  assert.equal(amountResult.executionEnabled, false)
  const oversizedCredit = evaluatePayoutActivationReadiness({
    creditFacilityApproved: true,
    creditFacilityUsePermittedForTronUsdtWithdrawals: true,
    creditFacilityApprovalReference: 'approval-2026-004',
    creditFacilityUseAuthorizationReference: 'use-auth-2026-004',
    creditFacilityValidUntil: '2099-12-31T23:59:59.000Z',
    creditFacilityApprovedLimitUsdt: '9'.repeat(41),
  }, { amountUsdt: '1000' })
  assert.ok(oversizedCredit.blockers.includes('neither-provider-owned-liquidity-nor-evidenced-approved-credit-permitted-for-requested-tron-usdt-withdrawal-is-available'))
  assert.equal(oversizedCredit.executionEnabled, false)
})
