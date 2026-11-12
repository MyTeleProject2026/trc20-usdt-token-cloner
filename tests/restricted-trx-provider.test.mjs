import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getRestrictedTrxProviderReadiness, getRestrictedTrxProviderComparison,
  assertRestrictedTrxProviderAdapter, assertRestrictedTrxCreditAuthorization,
} from '../server/restricted-trx-provider.mjs'

test('Ripple readiness fails closed with principal credit and escrow selected', () => {
  const result = getRestrictedTrxProviderReadiness({ RESTRICTED_TRX_PROVIDER: 'ripple' })
  assert.equal(result.provider, 'ripple')
  assert.equal(result.network, 'TRON_MAINNET')
  assert.equal(result.asset, 'TRX')
  assert.equal(result.fundingArrangement, 'principal-credit')
  assert.equal(result.destinationWorkflow, 'escrow')
  assert.equal(result.principalAvailableSun, null)
  assert.equal(result.feeBudgetSun, null)
  assert.equal(result.creditLimitSun, null)
  assert.equal(result.liquidityVerified, false)
  assert.equal(result.creditFacilityVerified, false)
  assert.equal(result.canCreateEscrowPosition, false)
  assert.equal(result.canBroadcastEscrowFunding, false)
  assert.equal(result.canBroadcastWalletPayout, false)
  assert.equal(result.liveExecutionHardDisabled, true)
  assert.ok(result.blockers.includes('published-ripple-principal-credit-terms-not-found'))
  assert.ok(result.blockers.includes('ripple-native-trx-escrow-fee-credit-not-verified'))
})

test('configuration flags and provider credentials alone never enable funding', () => {
  const result = getRestrictedTrxProviderReadiness({
    RESTRICTED_TRX_PROVIDER: 'ripple',
    RESTRICTED_TRX_PROVIDER_API_KEY: 'configured-key',
    RESTRICTED_TRX_PROVIDER_API_SECRET: 'configured-secret',
    RESTRICTED_TRX_PROVIDER_ACCOUNT_ID: 'account-123',
    RESTRICTED_TRX_PROVIDER_AGREEMENT_CONFIRMED: 'true',
    RESTRICTED_TRX_ESCROW_CONTRACT: 'TExampleContractAddress',
  })
  assert.equal(result.credentialsConfigured, true)
  assert.equal(result.providerAgreementConfigured, true)
  assert.equal(result.adapterImplemented, false)
  assert.equal(result.liquidityVerified, false)
  assert.equal(result.canBroadcastEscrowFunding, false)
  assert.equal(result.liveExecutionHardDisabled, true)
})

test('provider comparison contains Ripple only and explicitly excludes Fireblocks and Volet', () => {
  const result = getRestrictedTrxProviderComparison()
  assert.equal(result.fundingArrangement, 'principal-credit')
  assert.equal(result.selectedProvider, 'ripple')
  assert.deepEqual(result.destinationWorkflow, 'escrow')
  assert.deepEqual(result.excludedProviders, ['fireblocks', 'volet'])
  assert.deepEqual(result.providers.map((provider) => provider.id), ['ripple'])
  assert.equal(result.providers[0].providerCredit, 'not-documented')
  assert.equal(result.providers[0].gasStationScope, 'non-native-asset-transactions-only')
  assert.equal(result.providers[0].nativeTrxEscrowFeeCoverage, 'not-established')
})

test('credit authorization requires authenticated Ripple TRX credit and payable escrow scope', () => {
  const facility = {
    providerId: 'ripple',
    authenticated: true,
    status: 'approved',
    facilityType: 'credit',
    asset: 'TRX',
    network: 'TRON_MAINNET',
    agreementReference: 'SIGNED-AGREEMENT-001',
    providerAuthorizationId: 'ripple-auth-001',
    creditLimitSun: '1000000000',
    availableCreditSun: '500000000',
    feeBudgetSun: '10000000',
    feeFundingMode: 'credit',
    permittedTransactionTypes: ['TriggerSmartContract'],
    expiresAt: '2099-01-01T00:00:00.000Z',
    allowedDestinations: ['escrow'],
  }
  const authorized = assertRestrictedTrxCreditAuthorization(facility, {
    destination: 'escrow', amountSun: '100000000', feeBudgetSun: '1000000',
  })
  assert.equal(authorized.amountSun, '100000000')
  assert.throws(() => assertRestrictedTrxCreditAuthorization({ ...facility, authenticated: false },
    { destination: 'escrow', amountSun: '1', feeBudgetSun: '1' }),
  (error) => error.code === 'provider-credit-not-approved-or-authenticated')
  assert.throws(() => assertRestrictedTrxCreditAuthorization({ ...facility, permittedTransactionTypes: [] },
    { destination: 'escrow', amountSun: '1', feeBudgetSun: '1' }),
  (error) => error.code === 'provider-tron-payable-contract-call-not-authorized')
  assert.throws(() => assertRestrictedTrxCreditAuthorization({ ...facility, feeFundingMode: 'prefunded' },
    { destination: 'escrow', amountSun: '1', feeBudgetSun: '1' }),
  (error) => error.code === 'provider-escrow-fees-not-credit-funded')
  assert.throws(() => assertRestrictedTrxCreditAuthorization({ ...facility, facilityType: 'prefunded-custody' },
    { destination: 'escrow', amountSun: '1', feeBudgetSun: '1' }),
  (error) => error.code === 'provider-credit-not-approved-or-authenticated')
  assert.throws(() => assertRestrictedTrxCreditAuthorization(facility,
    { destination: 'ordinary-wallet-payout', amountSun: '1', feeBudgetSun: '1' }),
  (error) => error.code === 'provider-credit-destination-not-authorized')
  assert.throws(() => assertRestrictedTrxCreditAuthorization(facility,
    { destination: 'escrow', amountSun: '600000000', feeBudgetSun: '1' }),
  (error) => error.code === 'provider-credit-principal-insufficient')
})

test('provider adapter contract rejects incomplete implementations', () => {
  assert.throws(() => assertRestrictedTrxProviderAdapter({ getLiquidity: async () => ({}) }),
    (error) => error.code === 'provider-adapter-incomplete'
      && error.missingMethods.includes('submitPayableEscrowFunding')
      && error.missingMethods.includes('getCreditFacility'))
})
