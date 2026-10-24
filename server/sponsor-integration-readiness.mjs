import { createHash } from 'node:crypto'
import { createGasFreeClient } from './gasfree-client.mjs'

const NETWORKS = ['mainnet', 'shasta', 'nile']
const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function isValidTronAddress(value) {
  if (typeof value !== 'string') return false
  const address = value.trim()
  if (!TRON_ADDRESS.test(address)) return false

  // TRON user-facing addresses are Base58Check encodings of a 0x41-prefixed
  // 21-byte payload plus the first four bytes of double-SHA256(payload).
  let decodedNumber = 0n
  for (const character of address) {
    const digit = BASE58_ALPHABET.indexOf(character)
    if (digit < 0) return false
    decodedNumber = decodedNumber * 58n + BigInt(digit)
  }

  const decodedBytes = []
  while (decodedNumber > 0n) {
    decodedBytes.unshift(Number(decodedNumber & 0xffn))
    decodedNumber >>= 8n
  }
  let leadingZeroBytes = 0
  while (leadingZeroBytes < address.length && address[leadingZeroBytes] === '1') {
    leadingZeroBytes++
  }
  const bytes = [...Array(leadingZeroBytes).fill(0), ...decodedBytes]
  if (bytes.length !== 25 || bytes[0] !== 0x41) return false

  const payload = Buffer.from(bytes.slice(0, 21))
  const expectedChecksum = createHash('sha256')
    .update(createHash('sha256').update(payload).digest())
    .digest()
    .subarray(0, 4)
  return Buffer.from(bytes.slice(21)).equals(expectedChecksum)
}

function configuredAddress(env, key) {
  return isValidTronAddress(env[key])
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
        vtrc: configuredContractList(env, `SPONSOR_VTRC_${key}_CONTRACTS`),
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
      agreementReferenceVariablePresent: typeof env.SPONSOR_APPROVED_AGREEMENT_REFERENCES === 'string' && env.SPONSOR_APPROVED_AGREEMENT_REFERENCES.trim().length > 0,
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
      'This route only reports configuration presence and TRON Base58Check address validity; it does not read on-chain balances, verify sponsor consent, call provider discovery, sign, or submit transactions.',
      'A valid public address is not proof of account control, spend authority, spendable token balance, or network-fee coverage.',
      'A configured provider API key is not proof of provider reachability or approval for sponsored transfer submissions.',
      'A solidified on-chain transfer is not proof that an exchange credited a deposit.',
    ],
  }
}
