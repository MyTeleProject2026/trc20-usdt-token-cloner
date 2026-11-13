import { isValidTronAddress } from './tron-address.mjs'

function addressConfigured(value) {
  return typeof value === 'string' && isValidTronAddress(value.trim())
}

/**
 * Readiness only. This deliberately does not load a private key, instantiate a
 * signer, build a transaction, or broadcast anything.
 */
export function getTronMetaRelayerReadiness(env = process.env) {
  const sponsorAddress = typeof env.TRON_META_RELAYER_SPONSOR_ADDRESS === 'string'
    ? env.TRON_META_RELAYER_SPONSOR_ADDRESS.trim()
    : ''
  const forwarderAddress = typeof env.TRON_META_RELAYER_FORWARDER_ADDRESS === 'string'
    ? env.TRON_META_RELAYER_FORWARDER_ADDRESS.trim()
    : ''
  const tokenAddress = typeof env.TRON_META_RELAYER_TOKEN_ADDRESS === 'string'
    ? env.TRON_META_RELAYER_TOKEN_ADDRESS.trim()
    : ''
  const vaultAddress = typeof env.TRON_META_RELAYER_VAULT_ADDRESS === 'string'
    ? env.TRON_META_RELAYER_VAULT_ADDRESS.trim()
    : ''
  const nativeTreasuryAddress = typeof env.TRON_META_RELAYER_NATIVE_TREASURY_ADDRESS === 'string'
    ? env.TRON_META_RELAYER_NATIVE_TREASURY_ADDRESS.trim()
    : ''
  const payoutRouterAddress = typeof env.TRON_META_RELAYER_PAYOUT_ROUTER_ADDRESS === 'string'
    ? env.TRON_META_RELAYER_PAYOUT_ROUTER_ADDRESS.trim()
    : ''

  const checks = {
    sponsorWalletAddressConfigured: addressConfigured(sponsorAddress),
    trustedForwarderAddressConfigured: addressConfigured(forwarderAddress),
    metaAwareTokenAddressConfigured: addressConfigured(tokenAddress),
    metaAwareVaultAddressConfigured: addressConfigured(vaultAddress),
    nativeTrxTreasuryAddressConfigured: addressConfigured(nativeTreasuryAddress),
    combinedPayoutRouterAddressConfigured: addressConfigured(payoutRouterAddress),
    explicitFeatureOptIn: env.TRON_META_RELAYER_ENABLED === 'true',
    onChainForwarderCodeVerified: false,
    recipientMetaTxSupportVerified: false,
    isolatedSponsorSignerAvailable: false,
    sponsorFundingVerified: false,
  }

  const blockers = []
  if (!checks.sponsorWalletAddressConfigured) blockers.push('sponsor-wallet-required')
  if (!checks.trustedForwarderAddressConfigured) blockers.push('trusted-forwarder-not-deployed')
  if (!checks.metaAwareTokenAddressConfigured || !checks.metaAwareVaultAddressConfigured) {
    blockers.push('meta-aware-recipient-contracts-not-deployed')
  }
  if (!checks.nativeTrxTreasuryAddressConfigured) blockers.push('native-trx-payout-treasury-not-configured')
  if (!checks.combinedPayoutRouterAddressConfigured) blockers.push('combined-payout-router-not-configured')
  if (!checks.explicitFeatureOptIn) blockers.push('explicit-feature-opt-in-missing')
  blockers.push('on-chain-forwarder-code-verification-required')
  blockers.push('recipient-meta-transaction-support-verification-required')
  blockers.push('isolated-sponsor-signer-or-kms-integration-required')
  blockers.push('sponsor-funding-and-resource-preflight-required')
  blockers.push('live-relay-execution-is-not-implemented')

  return {
    network: 'TRON Mainnet',
    mode: 'readiness-only',
    status: 'blocked',
    checks,
    blockers,
    submissionEnabled: false,
    transactionBroadcastingAvailable: false,
    note: 'This endpoint is diagnostic only. It never reads signing keys, signs transactions, or broadcasts to TRON Mainnet.',
  }
}
