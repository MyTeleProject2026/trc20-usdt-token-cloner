import test from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateProviderPayoutReadiness,
  getUnconfiguredProviderPayoutReadiness,
} from '../server/provider-payout-readiness.mjs'

test('unconfigured private owner platform cannot submit provider payouts', () => {
  const readiness = getUnconfiguredProviderPayoutReadiness()
  assert.equal(readiness.platformMode, 'private-owner-only')
  assert.equal(readiness.network, 'TRON Mainnet')
  assert.equal(readiness.asset, 'USDT TRC20')
  assert.equal(readiness.executionEnabled, false)
  assert.equal(readiness.status, 'provider-payout-blocked')
  assert.ok(readiness.blockers.includes('no-provider-selected'))
  assert.ok(readiness.blockers.includes('provider-owned-liquidity-or-approved-credit-not-verified'))
  assert.ok(readiness.blockers.includes('approved-provider-broadcast-adapter-not-installed'))
})

test('provider-owned liquidity is insufficient without provider authorization and all live controls', () => {
  const readiness = evaluateProviderPayoutReadiness({
    providerName: 'Example Provider',
    sourceType: 'provider-owned-liquidity',
    availablePrincipalBaseUnits: '5000000',
  })
  assert.equal(readiness.checks.principalFundingVerified, true)
  assert.equal(readiness.executionEnabled, false)
  assert.ok(readiness.blockers.includes('provider-authorization-not-verified'))
  assert.ok(readiness.blockers.includes('provider-live-payouts-not-enabled'))
})

test('approved credit requires an explicit approved facility and a positive limit', () => {
  const pending = evaluateProviderPayoutReadiness({
    providerName: 'Example Provider',
    sourceType: 'provider-approved-credit',
    creditFacilityApproved: false,
    creditLimitBaseUnits: '1000000',
  })
  assert.equal(pending.checks.principalFundingVerified, false)

  const approved = evaluateProviderPayoutReadiness({
    providerName: 'Example Provider',
    sourceType: 'provider-approved-credit',
    creditFacilityApproved: true,
    creditLimitBaseUnits: '1000000',
  })
  assert.equal(approved.checks.principalFundingVerified, true)
})

test('execution requires every provider, asset, funding, fee and adapter control', () => {
  const readiness = evaluateProviderPayoutReadiness({
    providerName: 'Approved Example',
    providerAuthorizationVerified: true,
    payoutApiAuthenticated: true,
    mainnetUsdtTrc20Supported: true,
    livePayoutsEnabled: true,
    sourceType: 'provider-owned-liquidity',
    availablePrincipalBaseUnits: '1000000',
    networkFeeCoverageVerified: true,
    broadcastAdapterReady: true,
  })
  assert.equal(readiness.executionEnabled, true)
  assert.equal(readiness.status, 'provider-payout-ready')
  assert.deepEqual(readiness.blockers, [])
})
