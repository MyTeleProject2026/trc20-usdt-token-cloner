import test from 'node:test'
import assert from 'node:assert/strict'
import { assessProviderCreditFacilityReadiness } from '../server/provider-credit-facility-readiness.mjs'

const connectedAccount = {
  source: 'trusted-provider-adapter',
  authenticated: true,
  connected: true,
  providerAccountId: 'provider-account-123',
}

test('a provider account alone is classified as account-only, not credit approval', () => {
  const result = assessProviderCreditFacilityReadiness({ providerAccount: connectedAccount })
  assert.equal(result.status, 'provider-account-only')
  assert.equal(result.providerAccountConnected, true)
  assert.equal(result.approvalVerified, false)
  assert.equal(result.creditFacilityApproved, false)
  assert.equal(result.creditSpendable, false)
  assert.equal(result.availableCreditBaseUnits, null)
  assert.equal(result.payoutAuthorizationGranted, false)
  assert.equal(result.executionEnabled, false)
  assert.ok(result.blockers.includes('provider-credit-approval-not-provided'))
  assert.ok(result.blockers.includes('permitted-use-not-documented'))
})

test('missing or malformed provider account metadata never implies a connected account', () => {
  for (const providerAccount of [null, {}, { connected: true }, { connected: false, providerAccountId: 'provider-123' }]) {
    const result = assessProviderCreditFacilityReadiness({ providerAccount })
    assert.equal(result.providerAccountConnected, false)
    assert.equal(result.status, 'no-provider-account')
    assert.equal(result.executionEnabled, false)
  }
})

test('approval and permitted-use references remain unverified metadata', () => {
  const result = assessProviderCreditFacilityReadiness({
    providerAccount: connectedAccount,
    approvalReference: 'approval-case-123',
    permittedUseReference: 'permitted-use-case-456',
  })
  assert.equal(result.status, 'evidence-references-recorded-unverified')
  assert.equal(result.approvalReferencePresent, true)
  assert.equal(result.permittedUseReferencePresent, true)
  assert.equal(result.approvalVerified, false)
  assert.equal(result.permittedUseVerified, false)
  assert.equal(result.creditFacilityApproved, false)
  assert.equal(result.creditSpendable, false)
  assert.equal(result.availableCreditBaseUnits, null)
  assert.equal(result.payoutAuthorizationGranted, false)
  assert.equal(result.executionEnabled, false)
})

test('an approval reference without a permitted-use reference remains blocked', () => {
  const result = assessProviderCreditFacilityReadiness({
    providerAccount: connectedAccount,
    approvalReference: 'approval-case-123',
  })
  assert.equal(result.status, 'approval-reference-only-unverified')
  assert.ok(result.blockers.includes('permitted-use-not-documented'))
  assert.equal(result.executionEnabled, false)
})

test('short strings and browser-claimed status flags are not accepted as evidence', () => {
  const result = assessProviderCreditFacilityReadiness({
    providerAccount: { connected: true, providerAccountId: 'provider-account-123', approved: true, balance: '5000' },
    approvalReference: 'yes',
    permittedUseReference: 'ok',
    creditFacilityApproved: true,
    availableCreditBaseUnits: '5000000000',
  })
  assert.equal(result.providerAccountConnected, false)
  assert.equal(result.approvalReferencePresent, false)
  assert.equal(result.permittedUseReferencePresent, false)
  assert.equal(result.creditFacilityApproved, false)
  assert.equal(result.availableCreditBaseUnits, null)
  assert.equal(result.executionEnabled, false)
})
