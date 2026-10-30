import test from 'node:test'
import assert from 'node:assert/strict'
import { getSponsorIntegrationReadiness } from '../server/sponsor-integration-readiness.mjs'

const addressA = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const addressB = 'TTGhREx2pDSxFX555NWz1YwGpiBVPvQA7e'
const invalidChecksumAddress = `T${'a'.repeat(33)}`

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

test('rejects a Base58-shaped sponsor address with an invalid checksum', () => {
  const result = getSponsorIntegrationReadiness({
    env: {
      SPONSOR_FEE_MAINNET_ADDRESS: invalidChecksumAddress,
      SPONSOR_ASSET_MAINNET_ADDRESS: addressB,
    },
  })
  const status = result.networks.mainnet.addressMonitoring
  assert.equal(status.feeSponsorAddressConfigured, false)
  assert.equal(status.bothRoleAddressesConfigured, false)
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

test('addresses are trimmed before distinct-role comparison', () => {
  const result = getSponsorIntegrationReadiness({
    env: {
      SPONSOR_FEE_NILE_ADDRESS: `  ${addressA}  `,
      SPONSOR_ASSET_NILE_ADDRESS: addressA,
    },
  })
  const status = result.networks.nile.addressMonitoring
  assert.equal(status.feeSponsorAddressConfigured, true)
  assert.equal(status.assetPrincipalSponsorAddressConfigured, true)
  assert.equal(status.bothRoleAddressesConfigured, true)
  assert.equal(status.roleAddressesDistinct, false)
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

test('testnet token principal allowlists are ignored because only Mainnet Tether is supported', () => {
  const result = getSponsorIntegrationReadiness({
    env: {
      SPONSOR_USDT_NILE_CONTRACTS: `${addressA},${addressB}`,
      SPONSOR_VTRC_NILE_CONTRACTS: `${addressA},not-a-contract`,
    },
  })
  assert.equal(result.networks.nile.tokenContractAllowlist.officialMainnetUsdt, false)
  assert.equal(result.networks.nile.tokenContractAllowlist.testnetTokenPrincipalSupported, false)
  assert.equal(result.submission.canSubmitSponsoredTransfer, false)
})

test('testnet token contract variables cannot enable sponsor principal', () => {
  const result = getSponsorIntegrationReadiness({
    env: {
      SPONSOR_USDT_NILE_CONTRACTS: `${addressA},`,
      SPONSOR_VTRC_NILE_CONTRACTS: '   ',
    },
  })
  assert.equal(result.networks.nile.tokenContractAllowlist.officialMainnetUsdt, false)
  assert.equal(result.networks.nile.tokenContractAllowlist.testnetTokenPrincipalSupported, false)
})

test('production readiness lists unresolved sponsor-funding, authorization and settlement release gates', () => {
  const result = getSponsorIntegrationReadiness({ env: {} })
  const blockers = result.submission.blockers
  assert.ok(!blockers.includes('github-actions-runner-allocation-and-full-ci-validation-not-passing'))
  assert.ok(!blockers.includes('high-severity-google-protobuf-advisory-unresolved'))
  assert.ok(blockers.includes('external-sponsor-agreement-and-funded-accounts-not-independently-verified'))
  assert.ok(blockers.includes('provider-not-verified-to-provide-asset-principal-and-all-fees'))
  assert.ok(blockers.includes('secure-managed-signer-or-provider-authorization-path-not-integrated'))
  assert.ok(blockers.includes('independent-solidified-settlement-and-receiver-balance-reconciliation-not-end-to-end-verified'))
  assert.equal(result.submission.blockerCount, blockers.length)
  assert.equal(result.submission.enabled, false)
  assert.equal(result.submission.canSubmitSponsoredTransfer, false)
  assert.equal(result.submission.userFundedFallbackAllowed, false)
})
