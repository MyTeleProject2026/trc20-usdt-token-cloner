/**
 * Provider-funded restricted native TRX liquidity adapter boundary.
 *
 * This module intentionally does not treat configuration, a dashboard credit,
 * or a provider account label as money. A concrete provider adapter may be
 * enabled only after its API contract, account permissions, and funding
 * semantics are implemented and verified.
 */
const REQUIRED_CAPABILITIES = Object.freeze([
  'native-trx-mainnet',
  'payable-contract-call',
  'provider-principal-funding',
  'network-fee-funding',
  'idempotent-transaction-submission',
  'transaction-status-query',
])

function present(value) {
  return typeof value === 'string' && value.trim().length > 0
}

export function getRestrictedTrxProviderReadiness(env = process.env) {
  const provider = present(env.RESTRICTED_TRX_PROVIDER)
    ? env.RESTRICTED_TRX_PROVIDER.trim().toLowerCase()
    : ''
  const contract = present(env.RESTRICTED_TRX_ESCROW_CONTRACT)
    ? env.RESTRICTED_TRX_ESCROW_CONTRACT.trim()
    : ''
  const apiKeyConfigured = present(env.RESTRICTED_TRX_PROVIDER_API_KEY)
  const apiSecretConfigured = present(env.RESTRICTED_TRX_PROVIDER_API_SECRET)
  const providerAccountConfigured = present(env.RESTRICTED_TRX_PROVIDER_ACCOUNT_ID)
  const providerAgreementConfigured = env.RESTRICTED_TRX_PROVIDER_AGREEMENT_CONFIRMED === 'true'
  const adapterImplemented = false

  const blockers = []
  if (!provider) blockers.push('provider-not-selected')
  if (!providerAccountConfigured) blockers.push('provider-account-not-configured')
  if (!providerAgreementConfigured) blockers.push('provider-funding-agreement-not-confirmed')
  if (!apiKeyConfigured || !apiSecretConfigured) blockers.push('provider-credentials-not-configured')
  if (!contract) blockers.push('escrow-contract-not-deployed')
  if (!adapterImplemented) blockers.push('provider-api-adapter-not-implemented')
  blockers.push('provider-liquidity-not-independently-verified')

  return Object.freeze({
    provider: provider || null,
    network: 'TRON_MAINNET',
    asset: 'TRX',
    contractConfigured: Boolean(contract),
    providerAccountConfigured,
    providerAgreementConfigured,
    credentialsConfigured: apiKeyConfigured && apiSecretConfigured,
    adapterImplemented,
    capabilitiesRequired: REQUIRED_CAPABILITIES,
    principalAvailableSun: null,
    feeBudgetSun: null,
    liquidityVerified: false,
    canCreateEscrowPosition: false,
    canBroadcastTransaction: false,
    blockers,
    message: 'Provider funding is not enabled. No provider liquidity or credit is assumed.',
  })
}

/**
 * Adapter contract for future concrete integrations. An adapter must provide
 * authoritative, authenticated provider responses; do not implement this by
 * reading a frontend balance or accepting a client-supplied amount.
 */
export function assertRestrictedTrxProviderAdapter(adapter) {
  const methods = [
    'getCapabilities',
    'getLiquidity',
    'reservePrincipalAndFees',
    'submitPayableEscrowFunding',
    'getTransactionStatus',
    'releaseReservation',
  ]
  const missing = methods.filter((method) => typeof adapter?.[method] !== 'function')
  if (missing.length) {
    const error = new Error('Restricted TRX provider adapter is incomplete')
    error.code = 'provider-adapter-incomplete'
    error.missingMethods = missing
    throw error
  }
  return adapter
}
