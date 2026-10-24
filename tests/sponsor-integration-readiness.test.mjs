import test from 'node:test'
import assert from 'node:assert/strict'
import { getSponsorIntegrationReadiness } from '../server/routes/sponsor-integration-readiness.mjs'

const addressA = `T${'a'.repeat(33)}`
const addressB = `T${'b'.repeat(33)}`

test('reports missing backend configuration without revealing secrets or addresses', () => {
  const secret = 'do-not-return-this-provider-secret'
  const result = getSponsorIntegrationReadiness({
    env: {
      TATUM_API_KEY: secret,
      SPONSOR_ADMIN_API_TOKEN: 'x'.repeat(40),
      SPONSOR_FEE_NILE_ADDRESS: addressA,
      SPONSOR_ASSET_NILE_ADDRESS: addressB,
      GASFREE_NILE_API_KEY: 'hidden-key',
      GASFREE_NILE_API_SECRET: 'hidden-secret',
    },
  })

  assert.equal(result.status, 'preflight-only-not-production-ready')
  assert.equal(result.backendConfiguration.tatumApiKeyConfigured, true)
  assert.equal(result.backendConfiguration.databaseUrlConfigured, false)
  assert.equal(result.backendConfiguration.sponsorAdminTokenConfigured, true)
  assert.equal(result.networks.nile.addressMonitoring.bothRoleAddressesConfigured, true)
  assert.equal(result.networks.nile.addressMonitoring.roleAddressesDistinct, true)
  assert.equal(result.networks.nile.gasFree.credentialsConfigured, true)
  assert.equal(result.submission.enabled, false)
  assert.equal(result.submission.canSubmitSponsoredTransfer, false)
  assert.equal(result.submission.userFundedFallbackAllowed, false)

  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes(secret), false)
  assert.equal(serialized.includes('hidden-key'), false)
  assert.equal(serialized.includes('hidden-secret'), false)
  assert.equal(serialized.includes(addressA), false)
  assert.equal(serialized.includes(addressB), false)
})

test('invalid or missing sponsor addresses are not marked as configured', () => {
  const result = getSponsorIntegrationReadiness({
    env: {
      SPONSOR_FEE_MAINNET_ADDRESS: 'not-an-address',
      SPONSOR_ASSET_MAINNET_ADDRESS: addressB,
    },
  })
  const status = result.networks.mainnet.addressMonitoring
  assert.equal(status.feeSponsorAddressConfigured, false)
  assert.equal(status.assetPrincipalSponsorAddressConfigured, true)
  assert.equal(status.bothRoleAddressesConfigured, false)
  assert.equal(status.roleAddressesDistinct, null)
  assert.equal(result.submission.canSubmitSponsoredTransfer, false)
})

test('same fee and asset address is flagged and never enables submission', () => {
  const result = getSponsorIntegrationReadiness({
    env: {
      SPONSOR_FEE_SHASTA_ADDRESS: addressA,
      SPONSOR_ASSET_SHASTA_ADDRESS: addressA,
    },
  })
  assert.equal(result.networks.shasta.addressMonitoring.roleAddressesDistinct, false)
  assert.equal(result.submission.enabled, false)
  assert.equal(result.submission.canSubmitSponsoredTransfer, false)
})

test('GasFree credentials only show configuration presence, not zero-cost eligibility', () => {
  const result = getSponsorIntegrationReadiness({
    env: {
      GASFREE_MAINNET_API_KEY: 'key',
      GASFREE_MAINNET_API_SECRET: 'secret',
      GASFREE_NILE_API_KEY: 'key',
      GASFREE_NILE_API_SECRET: 'secret',
    },
  })
  assert.equal(result.networks.mainnet.gasFree.credentialsConfigured, true)
  assert.equal(result.networks.nile.gasFree.credentialsConfigured, true)
  assert.equal(result.networks.shasta.gasFree.documentedNetwork, false)
  assert.equal(result.networks.mainnet.gasFree.providesAssetPrincipal, false)
  assert.equal(result.networks.mainnet.gasFree.noUserCostPolicySatisfied, false)
  assert.equal(result.submission.canSubmitSponsoredTransfer, false)
})
