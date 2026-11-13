import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateFincraLivePayoutGate } from '../server/fincra-live-payout-gate.mjs'

const completeEvidence = {
  environment: 'live',
  businessAccountOwnershipVerified: { verified: true, evidenceReference: 'provider-account-123' },
  liveUsdtTrc20ProductEnabled: { verified: true, evidenceReference: 'provider-product-123' },
  beneficiaryPayoutMandateVerified: { verified: true, evidenceReference: 'mandate-record-123' },
  providerLiquidityOrCreditVerified: { verified: true, evidenceReference: 'provider-balance-123' },
  ownerApprovalBoundToRequest: { verified: true, evidenceReference: 'owner-approval-123' },
  ownerApproval: {
    requestBindingVerified: true,
    requestDigest: 'a'.repeat(64),
  },
}

test('live payout gate fails closed when no external evidence is supplied', () => {
  const result = evaluateFincraLivePayoutGate()
  assert.equal(result.evidenceComplete, false)
  assert.equal(result.submissionAllowed, false)
  assert.ok(result.missing.includes('liveEnvironmentVerified'))
  assert.ok(result.missing.includes('providerLiquidityOrCreditVerified'))
})

test('live payout gate requires all five independent evidence categories', () => {
  for (const key of [
    'businessAccountOwnershipVerified',
    'liveUsdtTrc20ProductEnabled',
    'beneficiaryPayoutMandateVerified',
    'providerLiquidityOrCreditVerified',
    'ownerApprovalBoundToRequest',
  ]) {
    const evidence = structuredClone(completeEvidence)
    delete evidence[key]
    const result = evaluateFincraLivePayoutGate(evidence)
    assert.equal(result.evidenceComplete, false, key)
    assert.equal(result.submissionAllowed, false, key)
    assert.ok(result.missing.includes(key), key)
  }
})

test('test or sandbox environment cannot satisfy the live payout gate', () => {
  const result = evaluateFincraLivePayoutGate({ ...completeEvidence, environment: 'sandbox' })
  assert.equal(result.evidenceComplete, false)
  assert.ok(result.missing.includes('liveEnvironmentVerified'))
})

test('approval must be bound to a SHA-256 digest of the exact request', () => {
  const result = evaluateFincraLivePayoutGate({
    ...completeEvidence,
    ownerApproval: { requestBindingVerified: true, requestDigest: 'not-a-digest' },
  })
  assert.equal(result.evidenceComplete, false)
  assert.ok(result.missing.includes('ownerApprovalBoundToRequest'))
})

test('even complete evidence does not turn on payout submission automatically', () => {
  const result = evaluateFincraLivePayoutGate(completeEvidence)
  assert.equal(result.evidenceComplete, true)
  assert.equal(result.submissionAllowed, false)
  assert.equal(result.payoutSubmissionEnabled, false)
  assert.equal(result.reason, 'evidence-complete-but-live-submission-requires-separate-reviewed-enablement')
})
