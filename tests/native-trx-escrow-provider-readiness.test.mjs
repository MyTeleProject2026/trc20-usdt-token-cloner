import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateNativeTrxEscrowReadiness, getUnconfiguredNativeTrxEscrowReadiness } from '../server/native-trx-escrow-provider-readiness.mjs'

test('native TRX provider readiness defaults blocked with no fictional balance or approval', () => {
  const result = getUnconfiguredNativeTrxEscrowReadiness()
  assert.equal(result.asset, 'TRX')
  assert.equal(result.network, 'TRON Mainnet')
  assert.equal(result.executionEnabled, false)
  assert.equal(result.availablePrincipalSun, '0')
  assert.ok(result.blockers.length >= 9)
})

test('provider-owned principal requires verified provider wallet ownership and every authorization gate', () => {
  const result = evaluateNativeTrxEscrowReadiness({
    providerName: 'Example Custody', sourceType: 'provider-owned-liquidity',
    availablePrincipalSun: '1000000000', providerWalletOwnershipVerified: true,
    providerAuthorizationVerified: true, providerApiAuthenticated: true,
    tronMainnetNativeTrxSupported: true, feeCoverageVerified: true,
    payableEscrowCallSupported: true, destinationAndPurposeAuthorized: true,
    limitsAndComplianceApproved: true, livePayoutsApproved: true,
  })
  assert.equal(result.executionEnabled, true)
  assert.equal(result.availablePrincipalSun, '1000000000')
})

test('approved credit requires a positive executed facility approval, not a public balance claim', () => {
  const base = {
    providerName: 'Example Custody', sourceType: 'provider-approved-credit',
    approvedCreditLimitSun: '2500000000', creditFacilityApproved: true,
    providerAuthorizationVerified: true, providerApiAuthenticated: true,
    tronMainnetNativeTrxSupported: true, feeCoverageVerified: true,
    payableEscrowCallSupported: true, destinationAndPurposeAuthorized: true,
    limitsAndComplianceApproved: true, livePayoutsApproved: true,
  }
  assert.equal(evaluateNativeTrxEscrowReadiness(base).executionEnabled, true)
  assert.equal(evaluateNativeTrxEscrowReadiness({ ...base, creditFacilityApproved: false }).executionEnabled, false)
  assert.equal(evaluateNativeTrxEscrowReadiness({ ...base, approvedCreditLimitSun: '0' }).executionEnabled, false)
})

test('malformed amounts and missing payable-call or fee approval fail closed', () => {
  const result = evaluateNativeTrxEscrowReadiness({
    providerName: 'Example', sourceType: 'provider-owned-liquidity',
    availablePrincipalSun: '1e12', providerWalletOwnershipVerified: true,
    providerAuthorizationVerified: true, providerApiAuthenticated: true,
    tronMainnetNativeTrxSupported: true, feeCoverageVerified: false,
    payableEscrowCallSupported: false, destinationAndPurposeAuthorized: true,
    limitsAndComplianceApproved: true, livePayoutsApproved: true,
  })
  assert.equal(result.executionEnabled, false)
  assert.equal(result.availablePrincipalSun, '0')
  assert.ok(result.blockers.includes('feeCoverageVerified-not-verified'))
  assert.ok(result.blockers.includes('payableEscrowCallSupported-not-verified'))
})

test('owner readiness endpoint remains diagnostic-only and never calls a provider', async () => {
  const { readFile } = await import('node:fs/promises')
  const route = await readFile(new URL('../server/routes/tron-transfer.mjs', import.meta.url), 'utf8')
  assert.match(route, /router\.get\('\/native-trx-escrow-provider-readiness'/)
  assert.match(route, /getUnconfiguredNativeTrxEscrowReadiness\(\)/)
  assert.match(route, /providerOwnedAllocationVerified: false/)
  assert.match(route, /creditFacilityVerified: false/)
  assert.match(route, /liveTransferEnabled: false/)
  assert.match(route, /providerApprovedCreditVerified: false/)
  assert.match(route, /feeCoverageVerified: false/)
  assert.match(route, /client\.getWalletBalances\(\)/)
  assert.match(route, /client\.estimateNativeTrxTransferFee\(\)/)
  assert.match(route, /A funded custody-wallet balance is real available custody balance/)
  assert.doesNotMatch(route, /client\.(?:send|transfer|withdraw|broadcast)[A-Z_a-z]*\(/)
})
