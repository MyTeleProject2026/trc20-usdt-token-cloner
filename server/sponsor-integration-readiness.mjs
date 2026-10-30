import { createGasFreeClient } from './gasfree-client.mjs'
import { isValidTronAddress } from './tron-address.mjs'

const NETWORKS = ['mainnet', 'shasta', 'nile']

function configuredAddress(env, key) {
  const value = env[key]
  return isValidTronAddress(typeof value === 'string' ? value.trim() : value)
}

function normalizedAddress(env, key) {
  const value = env[key]
  return typeof value === 'string' ? value.trim() : ''
}

function configuredContractList(env, key) {
  const value = env[key]
  if (typeof value !== 'string' || !value.trim()) return false
  const entries = value.split(',').map((item) => item.trim())
  // Reject empty entries and malformed/checksum-invalid addresses instead of
  // reporting a partially valid allowlist as configured.
  return entries.length > 0 && entries.every(isValidTronAddress)
}

/**
 * Returns deployment/configuration diagnostics without returning secrets or
 * public sponsor addresses. Environment presence is never transaction authority.
 */
export function getSponsorIntegrationReadiness({
  env = process.env,
  gasFreeClient = createGasFreeClient({ env }),
} = {}) {
  const networks = Object.fromEntries(NETWORKS.map((network) => {
    const key = network.toUpperCase()
    const generalAddressConfigured = configuredAddress(env, `SPONSOR_${key}_ADDRESS`)
    const feeAddressConfigured = configuredAddress(env, `SPONSOR_FEE_${key}_ADDRESS`)
    const assetAddressConfigured = configuredAddress(env, `SPONSOR_ASSET_${key}_ADDRESS`)
    // Configuration validity trims whitespace; identity comparisons must use
    // the same canonical values, or identical addresses can look distinct.
    const feeAddress = normalizedAddress(env, `SPONSOR_FEE_${key}_ADDRESS`)
    const assetAddress = normalizedAddress(env, `SPONSOR_ASSET_${key}_ADDRESS`)
    const gasFreeSupported = network === 'mainnet' || network === 'nile'
    const gasFreeCredentialsConfigured = gasFreeSupported
      && typeof gasFreeClient.isConfigured === 'function'
      && gasFreeClient.isConfigured(network) === true

    return [network, {
      addressMonitoring: {
        generalAddressConfigured,
        feeSponsorAddressConfigured: feeAddressConfigured,
        assetPrincipalSponsorAddressConfigured: assetAddressConfigured,
        bothRoleAddressesConfigured: feeAddressConfigured && assetAddressConfigured,
        roleAddressesDistinct: feeAddressConfigured && assetAddressConfigured
          ? feeAddress !== assetAddress : null,
      },
      tokenContractAllowlist: {
        usdt: network === 'mainnet' || configuredContractList(env, `SPONSOR_USDT_${key}_CONTRACTS`),
      },
      gasFree: {
        documentedNetwork: gasFreeSupported,
        credentialsConfigured: gasFreeCredentialsConfigured,
        discoveryReachabilityVerified: false,
        submitSignBroadcastAdapterIntegrated: false,
        providesAssetPrincipal: false,
        noUserCostPolicySatisfied: false,
      },
    }]
  }))

  const blockers = [
    'external-sponsor-agreement-and-funded-accounts-not-independently-verified',
    'provider-not-verified-to-provide-asset-principal-and-all-fees',
    'production-provider-sign-submit-broadcast-adapter-not-verified',
    'production-managed-signer-security-review-not-complete',
    'secure-managed-signer-or-provider-authorization-path-not-integrated',
    'transaction-time-sponsor-consent-and-spending-mandate-verification-not-integrated',
    'atomic-fee-resource-budget-reservation-and-settlement-not-integrated',
    'independent-solidified-settlement-and-receiver-balance-reconciliation-not-end-to-end-verified',
    'authenticated-exchange-deposit-credit-verification-not-integrated',
    'successful-supported-testnet-end-to-end-run-not-recorded',
    'independent-security-review-not-recorded',
    'mainnet-operator-release-approval-not-recorded',
  ]

  return {
    success: true,
    status: 'preflight-only-not-production-ready',
    checkedAt: new Date().toISOString(),
    backendConfiguration: {
      tatumApiKeyConfigured: typeof env.TATUM_API_KEY === 'string' && env.TATUM_API_KEY.trim().length > 0,
      databaseUrlConfigured: typeof env.DATABASE_URL === 'string' && env.DATABASE_URL.trim().length > 0,
      frontendOriginConfigured: typeof env.FRONTEND_ORIGIN === 'string' && env.FRONTEND_ORIGIN.split(',').some((origin) => /^https?:\/\//i.test(origin.trim())),
      sponsorAdminTokenConfigured: typeof env.SPONSOR_ADMIN_API_TOKEN === 'string' && env.SPONSOR_ADMIN_API_TOKEN.length >= 32,
      testnetSignedBroadcastExplicitlyEnabled: env.SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED === 'true',
      agreementReferenceVariablePresent: typeof env.SPONSOR_APPROVED_AGREEMENT_REFERENCES === 'string' && env.SPONSOR_APPROVED_AGREEMENT_REFERENCES.trim().length > 0,
    },
    networks,
    submission: {
      enabled: false,
      canSubmitSponsoredTransfer: false,
      testnetSignedBroadcastFlagConfigured: env.SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED === 'true',
      userFundedFallbackAllowed: false,
      blockerCount: blockers.length,
      blockers,
    },
    limitations: [
      'This route only reports configuration presence and TRON Base58Check address validity; it does not read on-chain balances, verify sponsor consent, call provider discovery, sign, or submit transactions.',
      'A valid public address is not proof of account control, spend authority, spendable token balance, or network-fee coverage.',
      'A configured provider API key is not proof of provider reachability or approval for sponsored transfer submissions.',
      'The experimental Shasta/Nile sponsor-wallet route is a separate feature flag and never enables Mainnet or production readiness.',
      'A solidified on-chain transfer is not proof that an exchange credited a deposit.',
    ],
  }
}
