import test from 'node:test'
import assert from 'node:assert/strict'
import {
  runSponsorGateSmoke,
  validateGasFreeConfigStatus,
  validateSponsorshipStatus,
} from '../scripts/verify-sponsor-gates.mjs'

function sponsorshipPayload(overrides = {}) {
  return {
    success: true,
    sponsorship: {
      enabled: false,
      mainnetEnabled: false,
      canSubmitSponsoredTransfer: false,
      fundingPolicy: {
        feeSponsorshipAvailable: false,
        sponsorFundedAssetTransfersAvailable: false,
        unpaidFallbackToUserFunds: false,
        userFundsRequiredForSponsoredFlow: false,
      },
      receiverBalance: { sponsorAssetGrantEnabled: false },
      ...overrides,
    },
    limitations: ['Read-only status only'],
  }
}

function gasFreePayload(overrides = {}) {
  return {
    success: true,
    providerFundingVerified: false,
    canSubmitSponsoredTransfer: false,
    submissionEnabled: false,
    networks: {
      mainnet: { configured: false, status: 'credentials-missing' },
      nile: { configured: false, status: 'credentials-missing' },
    },
    ...overrides,
  }
}

test('public smoke checker accepts the expected fail-closed sponsor contract', () => {
  assert.deepEqual(validateSponsorshipStatus(sponsorshipPayload()), {
    enabled: false,
    mainnetEnabled: false,
    canSubmitSponsoredTransfer: false,
    unpaidFallbackToUserFunds: false,
    sponsorAssetGrantEnabled: false,
  })
})

test('public smoke checker rejects unexpectedly enabled sponsorship or user-funded fallback', () => {
  assert.throws(
    () => validateSponsorshipStatus(sponsorshipPayload({ canSubmitSponsoredTransfer: true })),
    /fail-closed contract/,
  )
  assert.throws(
    () => validateSponsorshipStatus({
      ...sponsorshipPayload(),
      sponsorship: {
        ...sponsorshipPayload().sponsorship,
        fundingPolicy: {
          ...sponsorshipPayload().sponsorship.fundingPolicy,
          unpaidFallbackToUserFunds: true,
        },
      },
    }),
    /fail-closed contract/,
  )
})

test('public smoke checker rejects secret-bearing sponsorship payloads', () => {
  assert.throws(
    () => validateSponsorshipStatus({ ...sponsorshipPayload(), apiSecret: 'must-never-be-public' }),
    /Sensitive field/,
  )
})

test('GasFree diagnostics report credential presence without claiming funding or submission', () => {
  assert.deepEqual(validateGasFreeConfigStatus(gasFreePayload()), {
    mainnetCredentialsPresent: false,
    nileCredentialsPresent: false,
    providerFundingVerified: false,
    canSubmitSponsoredTransfer: false,
    submissionEnabled: false,
  })
  assert.throws(
    () => validateGasFreeConfigStatus(gasFreePayload({ submissionEnabled: true })),
    /must not assert funding or enable submissions/,
  )
})

test('composite smoke runs both endpoints and returns sanitized summaries', async () => {
  const paths = []
  const result = await runSponsorGateSmoke({
    read: async (path) => {
      paths.push(path)
      return path === '/api/tron/sponsorship/status' ? sponsorshipPayload() : gasFreePayload()
    },
  })
  assert.deepEqual(paths.sort(), ['/api/gasfree/config-status', '/api/tron/sponsorship/status'])
  assert.equal(result.sponsorship.canSubmitSponsoredTransfer, false)
  assert.equal(result.gasFree.submissionEnabled, false)
})
