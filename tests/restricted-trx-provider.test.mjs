import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getRestrictedTrxProviderReadiness, getRestrictedTrxProviderComparison,
  assertRestrictedTrxProviderAdapter, assertRestrictedTrxCreditAuthorization,
} from '../server/restricted-trx-provider.mjs'

test('provider readiness fails closed when no institution is configured', () => {
  const result = getRestrictedTrxProviderReadiness({})
  assert.equal(result.network, 'TRON_MAINNET')
  assert.equal(result.asset, 'TRX')
  assert.equal(result.fundingArrangement, 'credit')
  assert.equal(result.principalAvailableSun, null)
  assert.equal(result.feeBudgetSun, null)
  assert.equal(result.creditLimitSun, null)
  assert.equal(result.liquidityVerified, false)
  assert.equal(result.creditFacilityVerified, false)
  assert.equal(result.canCreateEscrowPosition, false)
  assert.equal(result.canBroadcastEscrowFunding, false)
  assert.equal(result.canBroadcastWalletPayout, false)
  assert.ok(result.blockers.includes('provider-not-selected'))
  assert.ok(result.blockers.includes('provider-credit-facility-not-verified'))
})

test('comparison selection is informational and never enables execution', () => {
  const result = getRestrictedTrxProviderReadiness({ RESTRICTED_TRX_PROVIDER: 'compare' })
  assert.equal(result.provider, null)
  assert.equal(result.providerSelection, 'comparison-only')
  assert.equal(result.canBroadcastEscrowFunding, false)
  assert.equal(result.canBroadcastWalletPayout, false)
})

test('configuration flags alone never enable funding', () => {
  const result = getRestrictedTrxProviderReadiness({
    RESTRICTED_TRX_PROVIDER: 'cobo', RESTRICTED_TRX_PROVIDER_API_KEY: 'configured-key',
    RESTRICTED_TRX_PROVIDER_API_SECRET: 'configured-secret', RESTRICTED_TRX_PROVIDER_ACCOUNT_ID: 'account-123',
    RESTRICTED_TRX_PROVIDER_AGREEMENT_CONFIRMED: 'true', RESTRICTED_TRX_ESCROW_CONTRACT: 'TExampleContractAddress',
  })
  assert.equal(result.credentialsConfigured, true)
  assert.equal(result.providerAgreementConfigured, true)
  assert.equal(result.adapterImplemented, false)
  assert.equal(result.liquidityVerified, false)
  assert.equal(result.canBroadcastEscrowFunding, false)
  assert.ok(result.blockers.includes('provider-credit-facility-not-verified'))
})

test('comparison does not misrepresent custody support as credit', () => {
  const result = getRestrictedTrxProviderComparison()
  assert.deepEqual(result.destinationWorkflows, ['escrow', 'ordinary-wallet-payout'])
  assert.deepEqual(result.providers.map((provider) => provider.id), ['cobo', 'ripple', 'volet'])
  assert.ok(result.providers.every((provider) => provider.providerCredit === 'not-documented'))
})

test('credit authorization requires approved credit evidence and destination scope', () => {
  const facility = {
    status: 'approved', facilityType: 'credit', agreementReference: 'SIGNED-AGREEMENT-001',
    providerAuthorizationId: 'provider-auth-001', creditLimitSun: '1000000000',
    availableCreditSun: '500000000', feeBudgetSun: '10000000',
    expiresAt: '2099-01-01T00:00:00.000Z', allowedDestinations: ['escrow', 'ordinary-wallet-payout'],
  }
  const authorized = assertRestrictedTrxCreditAuthorization(facility, {
    destination: 'escrow', amountSun: '100000000', feeBudgetSun: '1000000',
  })
  assert.equal(authorized.amountSun, '100000000')
  assert.throws(() => assertRestrictedTrxCreditAuthorization({ ...facility, facilityType: 'prefunded-custody' },
    { destination: 'escrow', amountSun: '1', feeBudgetSun: '1' }),
  (error) => error.code === 'provider-credit-not-approved')
  assert.throws(() => assertRestrictedTrxCreditAuthorization(facility,
    { destination: 'ordinary-wallet-payout', amountSun: '600000000', feeBudgetSun: '1' }),
  (error) => error.code === 'provider-credit-principal-insufficient')
})

test('provider adapter contract rejects incomplete implementations', () => {
  assert.throws(() => assertRestrictedTrxProviderAdapter({ getLiquidity: async () => ({}) }),
    (error) => error.code === 'provider-adapter-incomplete'
      && error.missingMethods.includes('submitPayableEscrowFunding')
      && error.missingMethods.includes('submitWalletPayout'))
})
