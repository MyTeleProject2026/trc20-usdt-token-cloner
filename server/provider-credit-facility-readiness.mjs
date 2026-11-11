/**
 * Non-operational classification for provider credit-facility evidence.
 *
 * This module deliberately does not verify provider identity, approve credit,
 * calculate spendable credit, reserve funds, authorize withdrawals, or expose
 * signing/submission capabilities. It distinguishes an ordinary provider
 * account from separately documented approval and permitted-use evidence.
 */

function nonEmptyReference(value) {
  return typeof value === 'string' && value.trim().length >= 4
}

function connectedProviderAccount(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && value.source === 'trusted-provider-adapter'
    && value.authenticated === true
    && value.connected === true
    && nonEmptyReference(value.providerAccountId),
  )
}

export function assessProviderCreditFacilityReadiness(input = {}) {
  const accountConnected = connectedProviderAccount(input.providerAccount)
  const approvalReferencePresent = nonEmptyReference(input.approvalReference)
  const permittedUseReferencePresent = nonEmptyReference(input.permittedUseReference)

  const blockers = []
  if (!accountConnected) blockers.push('provider-account-not-independently-verified')
  if (!approvalReferencePresent) blockers.push('provider-credit-approval-not-provided')
  else blockers.push('provider-credit-approval-reference-not-independently-verified')
  if (!permittedUseReferencePresent) blockers.push('permitted-use-not-documented')
  else blockers.push('permitted-use-reference-not-independently-verified')

  let status = 'no-provider-account'
  if (accountConnected && !approvalReferencePresent) status = 'provider-account-only'
  else if (accountConnected && approvalReferencePresent && !permittedUseReferencePresent) {
    status = 'approval-reference-only-unverified'
  } else if (accountConnected && approvalReferencePresent && permittedUseReferencePresent) {
    status = 'evidence-references-recorded-unverified'
  }

  return Object.freeze({
    schema: 'tron-transfer.provider-credit-readiness.v1',
    status,
    providerAccountConnected: accountConnected,
    approvalReferencePresent,
    permittedUseReferencePresent,
    approvalVerified: false,
    permittedUseVerified: false,
    creditFacilityApproved: false,
    creditSpendable: false,
    availableCreditBaseUnits: null,
    payoutAuthorizationGranted: false,
    executionEnabled: false,
    blockers: Object.freeze(blockers),
  })
}
