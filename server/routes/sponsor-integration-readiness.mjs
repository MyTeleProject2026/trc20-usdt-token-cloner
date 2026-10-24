import { Router } from 'express'
import { createGasFreeClient } from '../gasfree-client.mjs'

const NETWORKS = ['mainnet', 'shasta', 'nile']
const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/

function configuredAddress(env, key) {
  const value = env[key]
  return typeof value === 'string' && TRON_ADDRESS.test(value.trim())
}

function configuredList(env, key) {
  return typeof env[key] === 'string' && env[key].split(',').some((item) => item.trim().length > 0)
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
    const feeAddress = typeof env[`SPONSOR_FEE_${key}_ADDRESS`] === 'string'
      ? env[`SPONSOR_FEE_${key}_ADDRESS`].trim() : ''
    const assetAddress = typeof env[`SPONSOR_ASSET_${key}_ADDRESS`] === 'string'
      ? env[`SPONSOR_ASSET_${key}_ADDRESS`].trim() : ''
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
        usdt: network === 'mainnet' || configuredList(env, `SPONSOR_USDT_${key}_CONTRACTS`),
        vtrc: configuredList(env, `SPONSOR_VTRC_${key}_CONTRACTS`),
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
    'provider-specific-sign-submit-and-broadcast-adapter-not-integrated',
    'secure-managed-signer-or-provider-authorization-path-not-integrated',
    'transaction-time-sponsor-consent-and-spending-mandate-verification-not-integrated',
    'transaction-time-atomic-principal-and-fee-reservation-not-connected-to-submission',
    'independent-solidified-settlement-and-receiver-balance-reconciliation-not-end-to-end-verified',
    'authenticated-exchange-deposit-credit-verification-not-integrated',
    'successful-supported-testnet-end-to-end-run-and-security-review-not-recorded',
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
      approvedAgreementReferenceConfigured: typeof env.SPONSOR_APPROVED_AGREEMENT_REFERENCES === 'string' && env.SPONSOR_APPROVED_AGREEMENT_REFERENCES.trim().length > 0,
    },
    networks,
    submission: {
      enabled: false,
      canSubmitSponsoredTransfer: false,
      userFundedFallbackAllowed: false,
      blockerCount: blockers.length,
      blockers,
    },
    limitations: [
      'This route only reports configuration presence and address formatting; it does not read on-chain balances, verify sponsor consent, call provider discovery, sign, or submit transactions.',
      'A configured address is not proof of account control, spend authority, spendable token balance, or network-fee coverage.',
      'A configured provider API key is not proof of provider reachability or approval for sponsored transfer submissions.',
      'A solidified on-chain transfer is not proof that an exchange credited a deposit.',
    ],
  }
}

export function createSponsorIntegrationReadinessRouter(options) {
  const router = Router()
  router.get('/sponsorship/integration-readiness', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).json(getSponsorIntegrationReadiness(options))
  })
  return router
}

export default createSponsorIntegrationReadinessRouter()
