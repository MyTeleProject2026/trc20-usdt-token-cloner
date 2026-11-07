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
      network: 'nile', environment: 'nile', sourceKind: 'onchain', sourceVerified: true,
      chainVerified: true, sandbox: false, simulated: false,
      availableBaseUnits: '1200', requiredBaseUnits: '1000',
    },
    fee: {
      sponsorId: 'fee-sponsor-1', consentVerified: true, fundingSnapshotFresh: true,
      coverageVerified: true, network: 'nile', environment: 'nile', sourceKind: 'onchain',
      sourceVerified: true, chainVerified: true, sandbox: false, simulated: false,
      availableBaseUnits: '50', requiredBaseUnits: '25',
    },
    authorization: {
      verifiedIntentDigest: 'a'.repeat(64), signatureVerified: true,
      intentBindingVerified: true, unexpired: true, nonceUnused: true,
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
    organization: { identityVerified: true, mandateVerified: true, signerAuthorityVerified: true,
      providerAccountVerified: true, signingPolicyVerified: true },
  })
  assert.equal(evaluateSponsorTransferEligibility(base).eligible, true)
  const missing = evaluateSponsorTransferEligibility(evidence({ mode: 'sponsor-organization' }))
  assert.ok(missing.blockers.includes('sponsor-organization-identity-unverified'))
  assert.ok(missing.blockers.includes('sponsor-organization-signer-authority-unverified'))
  assert.ok(missing.blockers.includes('sponsor-organization-provider-account-unverified'))
  assert.ok(missing.blockers.includes('sponsor-organization-signing-policy-unverified'))
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

test('rejects invalid, replayed, expired, or unbound intent authorization', () => {
  const result = evaluateSponsorTransferEligibility(evidence({
    authorization: { verifiedIntentDigest: 'not-a-digest', signatureVerified: false,
      intentBindingVerified: false, unexpired: false, nonceUnused: false },
  }))
  assert.ok(result.blockers.includes('cryptographic-intent-authorization-unverified'))
  assert.ok(result.blockers.includes('authorization-expired-or-unknown'))
  assert.ok(result.blockers.includes('authorization-nonce-replayed-or-unknown'))

  const unbound = evaluateSponsorTransferEligibility(evidence({
    authorization: { ...evidence().authorization, intentBindingVerified: false },
  }))
  assert.ok(unbound.blockers.includes('cryptographic-intent-authorization-unverified'))
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

test('rejects simulated and sandbox principal or fee balances regardless of displayed amount', () => {
  const sandboxPrincipal = evaluateSponsorTransferEligibility(evidence({
    principal: { ...evidence().principal, environment: 'sandbox', sourceKind: 'provider-live-account',
      liveMode: false, sandbox: true, simulated: true, sourceVerified: false, chainVerified: false },
  }))
  assert.equal(sandboxPrincipal.eligible, false)
  assert.ok(sandboxPrincipal.blockers.includes('asset-principal-funding-source-not-live-verified'))

  const sandboxFee = evaluateSponsorTransferEligibility(evidence({
    fee: { ...evidence().fee, environment: 'sandbox', sourceKind: 'provider-live-account',
      liveMode: false, sandbox: true, simulated: true, sourceVerified: false, chainVerified: false },
  }))
  assert.equal(sandboxFee.eligible, false)
  assert.ok(sandboxFee.blockers.includes('network-fee-funding-source-not-live-verified'))
})

test('rejects funding snapshots whose source environment or network differs from the requested network', () => {
  const wrongEnvironment = evaluateSponsorTransferEligibility(evidence({
    principal: { ...evidence().principal, environment: 'mainnet' },
  }))
  assert.ok(wrongEnvironment.blockers.includes('asset-principal-funding-source-not-live-verified'))
  const wrongNetwork = evaluateSponsorTransferEligibility(evidence({
    fee: { ...evidence().fee, network: 'mainnet', environment: 'mainnet' },
  }))
  assert.ok(wrongNetwork.blockers.includes('fee-sponsor-network-mismatch'))
})


test('each sandbox or unverified provenance marker independently blocks funding eligibility', () => {
  const cases = [
    ['sandbox', { sandbox: true }],
    ['simulation', { simulated: true }],
    ['non-live provider mode', { sourceKind: 'provider-live-account', liveMode: false }],
    ['unverified source', { sourceVerified: false }],
    ['unverified chain snapshot', { chainVerified: false }],
    ['missing provenance', { environment: undefined, sourceKind: undefined }],
  ]
  for (const [label, patch] of cases) {
    const result = evaluateSponsorTransferEligibility(evidence({
      principal: { ...evidence().principal, ...patch },
    }))
    assert.equal(result.eligible, false, label)
    assert.ok(result.blockers.includes('asset-principal-funding-source-not-live-verified'), label)
  }
})

test('organization authorization fails closed when provider policy evidence is absent', () => {
  const result = evaluateSponsorTransferEligibility(evidence({
    mode: 'sponsor-organization',
    organization: {
      identityVerified: true,
      mandateVerified: true,
      signerAuthorityVerified: true,
      providerAccountVerified: true,
      signingPolicyVerified: false,
    },
  }))
  assert.equal(result.eligible, false)
  assert.ok(result.blockers.includes('sponsor-organization-signing-policy-unverified'))
})


test('accepts independently verified production provider-account funding with a distinct Mainnet network label', () => {
  const providerSnapshot = {
    sponsorId: 'provider-sponsor-1',
    consentVerified: true,
    fundingSnapshotFresh: true,
    network: 'mainnet',
    environment: 'production',
    sourceKind: 'provider-live-account',
    sourceVerified: true,
    sandbox: false,
    simulated: false,
    liveMode: true,
    accountVerified: true,
    providerAccountId: 'provider-vault-123',
    availableBaseUnits: '1200',
    requiredBaseUnits: '1000',
  }
  const feeSnapshot = {
    sponsorId: 'provider-fee-1',
    consentVerified: true,
    fundingSnapshotFresh: true,
    coverageVerified: true,
    network: 'mainnet',
    environment: 'production',
    sourceKind: 'provider-live-account',
    sourceVerified: true,
    sandbox: false,
    simulated: false,
    liveMode: true,
    accountVerified: true,
    providerAccountId: 'provider-vault-123',
    availableBaseUnits: '50',
    requiredBaseUnits: '25',
  }
  const result = evaluateSponsorTransferEligibility(evidence({
    network: 'mainnet',
    principal: providerSnapshot,
    fee: feeSnapshot,
  }))
  assert.equal(result.eligible, true)
  assert.equal(result.submissionPerformed, false)
})

test('rejects provider-account snapshots without a verified account identity', () => {
  for (const patch of [
    { accountVerified: false },
    { providerAccountId: '' },
    { environment: 'sandbox', liveMode: false },
    { environment: 'mainnet', liveMode: true },
  ]) {
    const principal = {
      sponsorId: 'provider-sponsor-1', consentVerified: true, fundingSnapshotFresh: true,
      network: 'mainnet', environment: 'production', sourceKind: 'provider-live-account',
      sourceVerified: true, sandbox: false, simulated: false, liveMode: true,
      accountVerified: true, providerAccountId: 'provider-vault-123',
      availableBaseUnits: '1200', requiredBaseUnits: '1000', ...patch,
    }
    const result = evaluateSponsorTransferEligibility(evidence({
      network: 'mainnet',
      principal,
    }))
    assert.equal(result.eligible, false)
    assert.ok(result.blockers.includes('asset-principal-funding-source-not-live-verified'))
  }
})
