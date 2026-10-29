import test from 'node:test'
import assert from 'node:assert/strict'
import { collectTestnetPreflight, normalizeApiBaseUrl } from '../scripts/run-testnet-preflight.mjs'

const baseUrl = 'https://test-api.example.com'

function routePayloads(overrides = {}) {
  const pilotNetwork = {
    preflightStatus: 'blocked-by-live-or-configuration-prerequisites',
    networkNode: { reachable: true, status: 'solidified-node-reachable' },
    roleConfiguration: {
      feeSponsorAddressConfigured: false,
      assetPrincipalSponsorAddressConfigured: false,
      rolesDistinct: false,
      feeSponsorOnChainBalanceRead: false,
      assetPrincipalSponsorOnChainBalanceRead: false,
    },
    feeSponsorResources: {
      read: false,
      status: 'resource-read-unavailable',
      delegation: { activeDelegationObserved: false },
    },
    blockers: ['fee-sponsor-address-not-configured'],
    canSubmitSponsoredTransfer: false,
    submissionEnabled: false,
    userFundedFallbackAllowed: false,
    sponsors: {
      networkFeeSponsor: { address: 'T1111111111111111111111111111111111' },
      assetPrincipalSponsor: { address: 'T2222222222222222222222222222222222' },
    },
  }
  return {
    '/health': { status: 'ok', service: 'tron-token-studio-api' },
    '/api/readiness': {
      success: true,
      status: 'read-only-dependencies-healthy',
      database: { configured: true, ready: true, status: 'ready' },
      providers: {
        tatum: { configured: true, reachable: true, status: 'reachable' },
        frontendOrigin: { configured: true },
      },
    },
    '/api/tron/sponsorship/status': {
      enabled: false,
      status: 'not-integrated',
      mainnetEnabled: false,
      canSubmitSponsoredTransfer: false,
      receiverBalance: { displayOnlySponsorCredit: false },
      fundingPolicy: {
        externalSponsorConfirmed: false,
        sponsorFundingVerified: false,
        unpaidFallbackToUserFunds: false,
      },
      privateKey: 'do-not-include-this-secret-in-report',
      arbitraryAddress: 'T1111111111111111111111111111111111',
    },
    '/api/tron/sponsorship/integration-readiness': {
      success: true,
      status: 'preflight-only-not-production-ready',
      backendConfiguration: {
        tatumApiKeyConfigured: true,
        databaseUrlConfigured: true,
        frontendOriginConfigured: true,
        sponsorAdminTokenConfigured: true,
        testnetSignedBroadcastExplicitlyEnabled: false,
        agreementReferenceVariablePresent: false,
        privateSecret: 'do-not-include-this-secret-in-report',
      },
      networks: {
        mainnet: { addressMonitoring: {}, tokenContractAllowlist: {}, gasFree: {} },
        nile: { addressMonitoring: {}, tokenContractAllowlist: {}, gasFree: {} },
        shasta: { addressMonitoring: {}, tokenContractAllowlist: {}, gasFree: {} },
      },
      submission: {
        enabled: false,
        canSubmitSponsoredTransfer: false,
        userFundedFallbackAllowed: false,
        blockerCount: 1,
        blockers: ['external-sponsor-agreement-and-funded-accounts-not-independently-verified'],
      },
    },
    '/api/tron/sponsorship/testnet-pilot-readiness?network=both&refresh=1': {
      success: true,
      status: 'testnet-live-preflight-completed-with-blockers',
      networks: { nile: pilotNetwork, shasta: pilotNetwork },
      submission: {
        enabled: false,
        canSubmitSponsoredTransfer: false,
        userFundedFallbackAllowed: false,
      },
    },
    ...overrides,
  }
}

function fakeFetch(payloads, { failingPath = null, failMessage = 'sensitive transport exception' } = {}) {
  const calls = []
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url)
    const route = parsed.pathname + parsed.search
    calls.push({ route, method: options.method, redirect: options.redirect })
    if (route === failingPath) throw new Error(failMessage)
    const body = payloads[route]
    return {
      ok: true,
      status: 200,
      async json() { return body },
    }
  }
  return { fetchImpl, calls }
}

test('API base URL accepts an HTTPS origin and rejects credential-bearing or non-HTTPS URLs', () => {
  assert.equal(normalizeApiBaseUrl('https://example.com/'), 'https://example.com')
  assert.throws(() => normalizeApiBaseUrl('http://example.com'), /HTTPS origin/)
  assert.throws(() => normalizeApiBaseUrl('https://user:password@example.com'), /HTTPS origin/)
  assert.throws(() => normalizeApiBaseUrl('https://example.com/path'), /HTTPS origin/)
})

test('preflight only performs GET requests, summarizes safe fields, and never claims a transfer completed', async () => {
  const { fetchImpl, calls } = fakeFetch(routePayloads())
  const report = await collectTestnetPreflight({
    baseUrl,
    fetchImpl,
    now: () => new Date('2026-10-30T00:00:00.000Z'),
  })

  assert.equal(calls.length, 5)
  assert.ok(calls.every((call) => call.method === 'GET' && call.redirect === 'error'))
  assert.equal(report.generatedAt, '2026-10-30T00:00:00.000Z')
  assert.equal(report.diagnosticsStatus, 'complete')
  assert.equal(report.step4Complete, false)
  assert.equal(report.liveTransferEvidenceRecorded, false)
  assert.equal(report.safetyInvariants.mainnetSubmissionEnabled, false)
  assert.equal(report.safetyInvariants.sponsoredSubmissionEnabled, false)
  assert.equal(report.safetyInvariants.userFundedFallbackAllowed, false)
  assert.equal(report.endpoints.sponsorshipStatus.summary.enabled, false)

  const serialized = JSON.stringify(report)
  for (const secret of [
    'do-not-include-this-secret-in-report',
    'T1111111111111111111111111111111111',
    'T2222222222222222222222222222222222',
    'privateKey',
    'arbitraryAddress',
  ]) {
    assert.equal(serialized.includes(secret), false)
  }
  assert.ok(report.blockers.some((item) => item.code === 'external-sponsor-agreement-and-funded-accounts-not-independently-verified'))
  assert.equal(report.sponsoredTransferStatus, 'blocked-by-prerequisites')
})

test('preflight detects any unexpected enabled submission gate instead of treating it as complete', async () => {
  const payloads = routePayloads({
    '/api/tron/sponsorship/status': {
      enabled: true,
      status: 'unexpected',
      mainnetEnabled: false,
      canSubmitSponsoredTransfer: true,
      receiverBalance: { displayOnlySponsorCredit: false },
      fundingPolicy: { unpaidFallbackToUserFunds: false },
    },
  })
  const { fetchImpl } = fakeFetch(payloads)
  const report = await collectTestnetPreflight({ baseUrl, fetchImpl })

  assert.ok(report.safetyInvariants.contractViolations.includes('sponsorship-enabled-flag-must-be-false'))
  assert.ok(report.safetyInvariants.contractViolations.includes('sponsored-submit-flag-must-be-false'))
  assert.equal(report.diagnosticsStatus, 'incomplete')
  assert.equal(report.step4Complete, false)
})

test('failed network requests produce sanitized categories without exposing transport exception details', async () => {
  const { fetchImpl } = fakeFetch(routePayloads(), {
    failingPath: '/api/tron/sponsorship/testnet-pilot-readiness?network=both&refresh=1',
  })
  const report = await collectTestnetPreflight({ baseUrl, fetchImpl })

  assert.equal(report.diagnosticsStatus, 'incomplete')
  assert.equal(report.endpoints.testnetPilot.errorCategory, 'network-or-transport-error')
  assert.equal(JSON.stringify(report).includes('sensitive transport exception'), false)
})
