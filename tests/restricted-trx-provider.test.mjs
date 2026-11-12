import test from 'node:test'
import assert from 'node:assert/strict'
import { getRestrictedTrxProviderReadiness, assertRestrictedTrxProviderAdapter } from '../server/restricted-trx-provider.mjs'

test('provider readiness fails closed when no institution is configured', () => {
  const result = getRestrictedTrxProviderReadiness({})
  assert.equal(result.network, 'TRON_MAINNET')
  assert.equal(result.asset, 'TRX')
  assert.equal(result.principalAvailableSun, null)
  assert.equal(result.feeBudgetSun, null)
  assert.equal(result.liquidityVerified, false)
  assert.equal(result.canCreateEscrowPosition, false)
  assert.equal(result.canBroadcastTransaction, false)
  assert.ok(result.blockers.includes('provider-not-selected'))
  assert.ok(result.blockers.includes('provider-api-adapter-not-implemented'))
})

test('provider readiness never enables funding from configuration flags alone', () => {
  const result = getRestrictedTrxProviderReadiness({
    RESTRICTED_TRX_PROVIDER: 'example-institution',
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
  assert.equal(result.canBroadcastTransaction, false)
})

test('provider adapter contract rejects incomplete implementations', () => {
  assert.throws(
    () => assertRestrictedTrxProviderAdapter({ getLiquidity: async () => ({}) }),
    (error) => error.code === 'provider-adapter-incomplete'
      && error.missingMethods.includes('submitPayableEscrowFunding'),
  )
})
