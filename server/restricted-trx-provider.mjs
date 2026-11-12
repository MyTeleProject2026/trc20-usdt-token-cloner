/**
 * Provider comparison, normalized adapter contract, and credit authorization
 * gates for restricted native-TRX funding.
 * No provider is a source of credit unless its authenticated response proves an approved facility.
 */
const REQUIRED_CAPABILITIES = Object.freeze([
  'native-trx-mainnet', 'payable-contract-call', 'provider-principal-funding',
  'network-fee-funding', 'idempotent-transaction-submission', 'transaction-status-query',
])
const PROVIDER_COMPARISON = Object.freeze([
  Object.freeze({ id: 'cobo', name: 'Cobo MPC Co-Managed Custody', nativeTrx: 'documented',
    ordinaryWalletPayout: 'documented', payableEscrowCall: 'not-verified', providerCredit: 'not-documented',
    notes: 'TRON send/receive custody and API withdrawal workflows are documented. This does not prove credit or TRON TVM payable contract calls with attached TRX.',
    docs: 'https://docs.cobo.com/cobo-mpc-waas/cobo-mpc-co-managed-custody/quick-start-guide/mpc-wallet-management-on-cobo-custody-web' }),
  Object.freeze({ id: 'ripple', name: 'Ripple Custody', nativeTrx: 'documented',
    ordinaryWalletPayout: 'documented', payableEscrowCall: 'not-verified', providerCredit: 'not-documented',
    notes: 'TRON native TRX support is documented. Public asset support does not establish a credit line or escrow contract-call workflow.',
    docs: 'https://docs.ripple.com/products/wallet/vaults-and-wallets/supported-blockchains-and-tokens' }),
  Object.freeze({ id: 'volet', name: 'Volet Merchant API', nativeTrx: 'documented',
    ordinaryWalletPayout: 'documented', payableEscrowCall: 'not-documented', providerCredit: 'not-documented',
    notes: 'TRX custodial payouts to external wallets are documented, but the account must be verified and sufficiently funded. This is not evidence of provider credit or escrow contract-call support.',
    docs: 'https://volet.com/docs/guides/mass-payouts/payout-methods/custodial-payouts/' }),
])
const ADAPTER_METHODS = Object.freeze([
  'getCapabilities', 'getCreditFacility', 'getLiquidity', 'reservePrincipalAndFees',
  'submitPayableEscrowFunding', 'submitWalletPayout', 'getTransactionStatus', 'releaseReservation',
])
const present = (value) => typeof value === 'string' && value.trim().length > 0
const positiveIntegerString = (value) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value)

export function getRestrictedTrxProviderComparison() {
  return {
    fundingArrangement: 'credit',
    destinationWorkflows: ['escrow', 'ordinary-wallet-payout'],
    providers: PROVIDER_COMPARISON,
    conclusion: 'No listed provider has publicly documented the required provider-funded TRX credit facility. Custody/payout support is not credit approval.',
  }
}

export function getRestrictedTrxProviderReadiness(env = process.env) {
  const configuredProvider = present(env.RESTRICTED_TRX_PROVIDER) ? env.RESTRICTED_TRX_PROVIDER.trim().toLowerCase() : ''
  const provider = configuredProvider && configuredProvider !== 'compare' ? configuredProvider : ''
  const contract = present(env.RESTRICTED_TRX_ESCROW_CONTRACT) ? env.RESTRICTED_TRX_ESCROW_CONTRACT.trim() : ''
  const apiKeyConfigured = present(env.RESTRICTED_TRX_PROVIDER_API_KEY)
  const apiSecretConfigured = present(env.RESTRICTED_TRX_PROVIDER_API_SECRET)
  const providerAccountConfigured = present(env.RESTRICTED_TRX_PROVIDER_ACCOUNT_ID)
  const providerAgreementConfigured = env.RESTRICTED_TRX_PROVIDER_AGREEMENT_CONFIRMED === 'true'
  // False until an institution-specific API implementation and provider-side credit evidence are reviewed.
  const adapterImplemented = false
  const blockers = []
  if (!provider) blockers.push('provider-not-selected')
  if (provider && !PROVIDER_COMPARISON.some((candidate) => candidate.id === provider)) blockers.push('provider-not-supported-by-adapter-registry')
  if (!providerAccountConfigured) blockers.push('provider-account-not-configured')
  if (!providerAgreementConfigured) blockers.push('provider-funding-agreement-not-confirmed')
  if (!apiKeyConfigured || !apiSecretConfigured) blockers.push('provider-credentials-not-configured')
  if (!contract) blockers.push('escrow-contract-not-deployed')
  if (!adapterImplemented) blockers.push('provider-api-adapter-not-implemented')
  blockers.push('provider-credit-facility-not-verified', 'provider-liquidity-not-independently-verified',
    'payable-tron-contract-call-not-verified', 'wallet-payout-provider-authorization-not-verified')
  return Object.freeze({
    provider: provider || null,
    providerSelection: configuredProvider === 'compare' ? 'comparison-only' : 'individual-provider-required',
    fundingArrangement: 'credit',
    destinationWorkflows: Object.freeze(['escrow', 'ordinary-wallet-payout']),
    network: 'TRON_MAINNET', asset: 'TRX',
    contractConfigured: Boolean(contract), providerAccountConfigured, providerAgreementConfigured,
    credentialsConfigured: apiKeyConfigured && apiSecretConfigured, adapterImplemented,
    capabilitiesRequired: REQUIRED_CAPABILITIES,
    principalAvailableSun: null, feeBudgetSun: null, creditLimitSun: null, availableCreditSun: null,
    liquidityVerified: false, creditFacilityVerified: false,
    canCreateEscrowPosition: false, canBroadcastEscrowFunding: false, canBroadcastWalletPayout: false,
    blockers,
    message: 'Credit funding is not enabled. No provider credit, TRX principal, or fee budget is assumed.',
  })
}

/**
 * Validate an authenticated provider API response obtained server-to-server.
 * Never accept this object from a browser, request body, or UI configuration.
 */
export function assertRestrictedTrxCreditAuthorization(facility, {
  destination, amountSun, feeBudgetSun, now = Date.now(),
} = {}) {
  const fail = (code) => {
    const error = new Error('Provider credit authorization is insufficient')
    error.code = code
    throw error
  }
  if (!facility || facility.status !== 'approved' || facility.facilityType !== 'credit') fail('provider-credit-not-approved')
  if (!present(facility.agreementReference) || !present(facility.providerAuthorizationId)) fail('provider-credit-evidence-missing')
  if (!positiveIntegerString(facility.creditLimitSun) || !positiveIntegerString(facility.availableCreditSun)
    || !positiveIntegerString(facility.feeBudgetSun)) fail('provider-credit-amounts-invalid')
  if (!Number.isFinite(Date.parse(facility.expiresAt)) || Date.parse(facility.expiresAt) <= now) fail('provider-credit-authorization-expired')
  if (!['escrow', 'ordinary-wallet-payout'].includes(destination)
    || !Array.isArray(facility.allowedDestinations) || !facility.allowedDestinations.includes(destination)) {
    fail('provider-credit-destination-not-authorized')
  }
  if (!positiveIntegerString(amountSun) || !positiveIntegerString(feeBudgetSun)) fail('provider-credit-request-amount-invalid')
  if (BigInt(amountSun) > BigInt(facility.availableCreditSun) || BigInt(amountSun) > BigInt(facility.creditLimitSun)) {
    fail('provider-credit-principal-insufficient')
  }
  if (BigInt(feeBudgetSun) > BigInt(facility.feeBudgetSun)) fail('provider-credit-fee-budget-insufficient')
  return Object.freeze({
    providerAuthorizationId: facility.providerAuthorizationId,
    agreementReference: facility.agreementReference, destination, amountSun, feeBudgetSun, expiresAt: facility.expiresAt,
  })
}

/** Method presence alone never grants broadcast permission. */
export function assertRestrictedTrxProviderAdapter(adapter) {
  const missing = ADAPTER_METHODS.filter((method) => typeof adapter?.[method] !== 'function')
  if (missing.length) {
    const error = new Error('Restricted TRX provider adapter is incomplete')
    error.code = 'provider-adapter-incomplete'
    error.missingMethods = missing
    throw error
  }
  return adapter
}
