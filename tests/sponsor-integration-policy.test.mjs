import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateSponsorTransferEligibility } from '../server/sponsor-integration-policy.mjs'

function evidence(overrides = {}) {
  return {
    mode: 'third-party-provider',
    network: 'nile',
    provider: { adapterVerified: true, accountVerified: true },
    principal: {
      sponsorId: 'asset-sponsor-1', consentVerified: true, fundingSnapshotFresh: true,
      network: 'nile', availableBaseUnits: '1200', requiredBaseUnits: '1000',
    },
    fee: {
      sponsorId: 'fee-sponsor-1', consentVerified: true, fundingSnapshotFresh: true,
      coverageVerified: true, network: 'nile', availableBaseUnits: '50', requiredBaseUnits: '25',
    },
    authorization: {
      verifiedIntentDigest: 'a'.repeat(64), unexpired: true, nonceUnused: true,
    },
    controls: {
      emergencyPause: false, operatorApproval: true, destinationAllowed: true,
      assetContractVerified: true, quoteFresh: true, idempotencyReserved: true,
      separateBudgetsReserved: true, settlementVerifierReady: true,
    },
    ...overrides,
  }
}

test('provider model can pass preflight only with separately verified principal and fee coverage', () => {
  const result = evaluateSponsorTransferEligibility(evidence())
  assert.equal(result.eligible, true)
  assert.equal(result.status, 'preflight-eligible-not-submitted')
  assert.equal(result.submissionPerformed, false)
  assert.equal(result.userFundedFallbackAllowed, false)
})

test('organization model requires independently verified organization identity and mandate', () => {
  const base = evidence({
    mode: 'sponsor-organization',
    organization: { identityVerified: true, mandateVerified: true },
  })
  assert.equal(evaluateSponsorTransferEligibility(base).eligible, true)
  assert.ok(evaluateSponsorTransferEligibility(evidence({ mode: 'sponsor-organization' }))
    .blockers.includes('sponsor-organization-identity-unverified'))
})

test('rejects missing sponsor consent even when on-chain balances are sufficient', () => {
  const result = evaluateSponsorTransferEligibility(evidence({
    principal: { ...evidence().principal, consentVerified: false },
  }))
  assert.equal(result.eligible, false)
  assert.ok(result.blockers.includes('asset-sponsor-consent-unverified'))
})

test('rejects principal or fee shortfall and malformed integer amounts', () => {
  const principalShort = evaluateSponsorTransferEligibility(evidence({
    principal: { ...evidence().principal, availableBaseUnits: '999' },
  }))
  assert.ok(principalShort.blockers.includes('asset-principal-funding-insufficient-or-unverified'))
  const feeShort = evaluateSponsorTransferEligibility(evidence({
    fee: { ...evidence().fee, availableBaseUnits: 'nope' },
  }))
  assert.ok(feeShort.blockers.includes('network-fee-coverage-insufficient-or-unverified'))
})

test('rejects wrong network, expired quote, missing operator approval and active emergency pause', () => {
  const result = evaluateSponsorTransferEligibility(evidence({
    network: 'shasta',
    controls: { ...evidence().controls, emergencyPause: true, operatorApproval: false, quoteFresh: false },
  }))
  assert.ok(result.blockers.includes('asset-sponsor-network-mismatch'))
  assert.ok(result.blockers.includes('fee-sponsor-network-mismatch'))
  assert.ok(result.blockers.includes('sponsor-submissions-paused-or-pause-state-unknown'))
  assert.ok(result.blockers.includes('operator-approval-missing'))
  assert.ok(result.blockers.includes('quote-missing-or-expired'))
})

test('rejects invalid, replayed, or expired intent authorization', () => {
  const result = evaluateSponsorTransferEligibility(evidence({
    authorization: { verifiedIntentDigest: 'not-a-digest', unexpired: false, nonceUnused: false },
  }))
  assert.ok(result.blockers.includes('cryptographic-intent-authorization-unverified'))
  assert.ok(result.blockers.includes('authorization-expired-or-unknown'))
  assert.ok(result.blockers.includes('authorization-nonce-replayed-or-unknown'))
})

test('never enables user-funded fallback and never claims a submission happened', () => {
  const result = evaluateSponsorTransferEligibility({})
  assert.equal(result.eligible, false)
  assert.equal(result.userFundedFallbackAllowed, false)
  assert.equal(result.submissionPerformed, false)
})

test('rejects zero principal or zero fee requirements instead of treating them as funded transfers', () => {
  const zeroPrincipal = evaluateSponsorTransferEligibility(evidence({
    principal: { ...evidence().principal, requiredBaseUnits: '0' },
  }))
  assert.equal(zeroPrincipal.eligible, false)
  assert.ok(zeroPrincipal.blockers.includes('asset-principal-funding-insufficient-or-unverified'))

  const zeroFee = evaluateSponsorTransferEligibility(evidence({
    fee: { ...evidence().fee, requiredBaseUnits: '0' },
  }))
  assert.equal(zeroFee.eligible, false)
  assert.ok(zeroFee.blockers.includes('network-fee-coverage-insufficient-or-unverified'))
})

test('accepts the uint256 upper bound when separately reserved principal and fee exactly cover it', () => {
  const max = ((1n << 256n) - 1n).toString()
  const result = evaluateSponsorTransferEligibility(evidence({
    principal: { ...evidence().principal, availableBaseUnits: max, requiredBaseUnits: max },
    fee: { ...evidence().fee, availableBaseUnits: max, requiredBaseUnits: max },
  }))
  assert.equal(result.eligible, true)
})

test('rejects amounts outside positive canonical uint256 base-unit strings', () => {
  const overflow = (1n << 256n).toString()
  for (const invalid of ['0', '-1', '01', '1e3', '9'.repeat(79), overflow]) {
    const result = evaluateSponsorTransferEligibility(evidence({
      principal: { ...evidence().principal, availableBaseUnits: invalid },
    }))
    assert.equal(result.eligible, false, `expected invalid balance ${invalid} to be rejected`)
    assert.ok(result.blockers.includes('asset-principal-funding-insufficient-or-unverified'))
  }
})
