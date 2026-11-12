/**
 * Provider comparison, normalized adapter contract, and credit authorization
 * gates for restricted native-TRX funding.
 *
 * Ripple is selected for diligence only. No public Ripple principal-credit
 * facility or general-purpose fee sponsorship for native-TRX escrow calls has
 * been verified. No provider-specific submission adapter is installed.
 */
const REQUIRED_CAPABILITIES = Object.freeze([
  'native-trx-mainnet',
  'trongrid-trigger-smart-contract-with-call-value',
  'provider-approved-trx-principal-credit',
  'provider-paid-network-fees-for-escrow-call',
  'delegated-energy-bandwidth-for-escrow-call',
  'idempotent-transaction-submission',
  'transaction-status-query',
  'solidified-chain-and-contract-state-verification',
])
const PROVIDER_COMPARISON = Object.freeze([
  Object.freeze({
    id: 'ripple',
    name: 'Ripple Custody',
    nativeTrx: 'documented',
    ordinaryWalletPayout: 'documented',
    payableEscrowCall: 'not-verified',
    providerCredit: 'not-documented',
    principalCreditTerms: 'not-published',
    gasStationScope: 'non-native-asset-transactions-only',
    nativeTrxEscrowFeeCoverage: 'not-established',
    myanmarEligibility: 'not-publicly-confirmed',
    notes: 'Ripple documents native TRX support. Its Gas Station is funded by native tokens held in a sponsor account and is documented for non-native-asset transactions; this does not establish native-TRX principal credit or fee coverage for a payable escrow call. No public credit limit, tenor, pricing, collateral, or Myanmar eligibility terms were found.',
    docs: 'https://docs.ripple.com/products/wallet/vaults-and-wallets/supported-blockchains-and-tokens',
    gasStationDocs: 'https://docs.ripple.com/pt-br/products/custody/accounts-and-assets/gas-station/overview',
    gasStationApiDocs: 'https://docs.ripple.com/products/custody/accounts-and-assets/gas-station/manage-gas-station-api',
  }),
])
const ADAPTER_METHODS = Object.freeze([
  'getCapabilities', 'getCreditFacility', 'getLiquidity', 'reservePrincipalAndFees',
  'submitPayableEscrowFunding', 'getTransactionStatus', 'releaseReservation',
])
const present = (value) => typeof value === 'string' && value.trim().length > 0
const positiveIntegerString = (value) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value)

export function getRestrictedTrxProviderComparison() {
  return {
    fundingArrangement: 'provider-credit-plus-delegated-resources',
    selectedProvider: 'ripple',
    destinationWorkflow: 'escrow',
    excludedProviders: ['fireblocks', 'volet'],
    providers: PROVIDER_COMPARISON,
    conclusion: 'Ripple is a technical custody candidate only. No public Ripple TRX principal-credit terms, native-TRX escrow-call fee-credit terms, or Myanmar eligibility confirmation were found. Do not infer credit from custody, API, or Gas Station documentation.',
  }
}

export function getRestrictedTrxProviderReadiness(env = process.env) {
  const configuredProvider = present(env.RESTRICTED_TRX_PROVIDER) ? env.RESTRICTED_TRX_PROVIDER.trim().toLowerCase() : ''
  const provider = configuredProvider ? (configuredProvider === 'ripple' ? 'ripple' : '') : 'ripple'
  const contract = present(env.RESTRICTED_TRX_ESCROW_CONTRACT) ? env.RESTRICTED_TRX_ESCROW_CONTRACT.trim() : ''
  const runtimeCodeHashConfigured = /^[0-9a-f]{64}$/i.test(String(env.RESTRICTED_TRX_ESCROW_RUNTIME_CODE_SHA256 || '').trim())
  const apiKeyConfigured = present(env.RESTRICTED_TRX_PROVIDER_API_KEY)
  const apiSecretConfigured = present(env.RESTRICTED_TRX_PROVIDER_API_SECRET)
  const providerAccountConfigured = present(env.RESTRICTED_TRX_PROVIDER_ACCOUNT_ID)
  const providerAgreementConfigured = env.RESTRICTED_TRX_PROVIDER_AGREEMENT_CONFIRMED === 'true'
  // Permanently false in this research/implementation stage. Do not derive this
  // from environment variables, credentials, provider selection, or UI state.
  const adapterImplemented = false // OAuth transport exists; the provider-specific credit/funding adapter is not verified or enabled.
  const blockers = []
  if (!provider) blockers.push('ripple-not-selected')
  if (!providerAccountConfigured) blockers.push('provider-account-not-configured')
  if (!providerAgreementConfigured) blockers.push('provider-funding-agreement-not-confirmed')
  if (!apiKeyConfigured || !apiSecretConfigured) blockers.push('provider-credentials-not-configured')
  if (!contract) blockers.push('escrow-contract-not-deployed')
  if (!runtimeCodeHashConfigured) blockers.push('audited-escrow-runtime-code-hash-not-configured')
  if (!adapterImplemented) blockers.push('ripple-provider-api-adapter-not-implemented')
  blockers.push(
    'published-ripple-principal-credit-terms-not-found',
    'ripple-credit-facility-not-approved-or-authenticated',
    'ripple-native-trx-escrow-call-support-not-verified',
    'provider-paid-network-fee-coverage-not-verified',
    'delegated-energy-bandwidth-not-verified',
    'myanmar-customer-eligibility-not-confirmed',
    'escrow-contract-audit-and-mainnet-deployment-not-verified',
    'independent-solidified-chain-verifier-not-integrated',
    'live-escrow-submission-hard-disabled',
  )
  return Object.freeze({
    provider: provider || null,
    providerSelection: provider ? 'selected-for-diligence-only' : 'ripple-required',
    fundingArrangement: 'provider-credit-plus-delegated-resources',
    feeCoverageArrangement: 'provider-paid-plus-delegated-resources',
    walletApiTransportImplemented: true,
    providerCreditFacilityApiVerified: false,
    delegatedResourceAdapterImplemented: false,
    destinationWorkflow: 'escrow',
    network: 'TRON_MAINNET',
    asset: 'TRX',
    unit: 'SUN',
    contractConfigured: Boolean(contract),
    runtimeCodeHashConfigured,
    providerAccountConfigured,
    providerAgreementConfigured,
    credentialsConfigured: apiKeyConfigured && apiSecretConfigured,
    adapterImplemented,
    capabilitiesRequired: REQUIRED_CAPABILITIES,
    principalAvailableSun: null,
    feeBudgetSun: null,
    creditLimitSun: null,
    availableCreditSun: null,
    liquidityVerified: false,
    creditFacilityVerified: false,
    payableEscrowCallVerified: false,
    nativeTrxEscrowFeeCreditVerified: false,
    chainVerificationIntegrated: false,
    canCreateEscrowPosition: false,
    canBroadcastEscrowFunding: false,
    canBroadcastWalletPayout: false,
    liveExecutionHardDisabled: true,
    blockers,
    message: 'Ripple OAuth transport is implemented, but no principal-credit facility, provider-paid escrow fee authorization, delegated-resource API, or payable escrow submission capability is verified. All live escrow submissions remain hard-disabled.',
  })
}

/**
 * Validate an authenticated Ripple API response obtained server-to-server.
 * Never accept this object from a browser, request body, or UI configuration.
 * This validates the shape/scope of evidence; it does not itself authenticate
 * the API response or approve production execution.
 */
export function assertRestrictedTrxCreditAuthorization(facility, {
  destination, amountSun, feeBudgetSun, escrowAddress, delegatedResourceVerification, now = Date.now(),
} = {}) {
  const fail = (code) => {
    const error = new Error('Provider credit authorization is insufficient')
    error.code = code
    throw error
  }
  if (!facility || facility.providerId !== 'ripple' || facility.authenticated !== true
    || facility.status !== 'approved' || facility.facilityType !== 'credit') {
    fail('provider-credit-not-approved-or-authenticated')
  }
  if (facility.asset !== 'TRX' || facility.network !== 'TRON_MAINNET') fail('provider-credit-asset-or-network-mismatch')
  if (!present(facility.agreementReference) || !present(facility.providerAuthorizationId)) fail('provider-credit-evidence-missing')
  if (!positiveIntegerString(facility.creditLimitSun) || !positiveIntegerString(facility.availableCreditSun)
    || !positiveIntegerString(facility.feeBudgetSun)) fail('provider-credit-amounts-invalid')
  if (!Array.isArray(facility.permittedTransactionTypes)
    || !facility.permittedTransactionTypes.includes('TriggerSmartContract')) {
    fail('provider-tron-payable-contract-call-not-authorized')
  }
  const combinedFeeMode = facility.feeFundingMode === 'provider-paid-plus-delegated-resources'
  if (facility.feeFundingMode !== 'credit' && !combinedFeeMode) fail('provider-escrow-fee-funding-mode-not-authorized')
  if (!Number.isFinite(Date.parse(facility.expiresAt)) || Date.parse(facility.expiresAt) <= now) fail('provider-credit-authorization-expired')
  if (destination !== 'escrow' || !Array.isArray(facility.allowedDestinations)
    || !facility.allowedDestinations.includes('escrow')) {
    fail('provider-credit-destination-not-authorized')
  }
  if (!positiveIntegerString(amountSun) || !positiveIntegerString(feeBudgetSun)) fail('provider-credit-request-amount-invalid')
  if (BigInt(amountSun) > BigInt(facility.availableCreditSun) || BigInt(amountSun) > BigInt(facility.creditLimitSun)) {
    fail('provider-credit-principal-insufficient')
  }
  if (BigInt(feeBudgetSun) > BigInt(facility.feeBudgetSun)) fail('provider-credit-fee-budget-insufficient')

  let delegatedResourceEvidence = null
  if (combinedFeeMode) {
    const resources = facility.delegatedResources
    const chainEvidence = delegatedResourceVerification
    const validAddress = typeof escrowAddress === 'string' && /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(escrowAddress)
    const hasEnergy = positiveIntegerString(resources?.energyLimit)
    const hasBandwidth = positiveIntegerString(resources?.bandwidthLimit)
    const resourceTxIds = chainEvidence?.resourceTransactionIds
    const verifiedEnergy = positiveIntegerString(chainEvidence?.energyLimit)
    const verifiedBandwidth = positiveIntegerString(chainEvidence?.bandwidthLimit)
    if (!validAddress || !resources || !chainEvidence || chainEvidence.verified !== true
      || chainEvidence.solidified !== true || resources.status !== 'active'
      || resources.network !== 'TRON_MAINNET' || chainEvidence.network !== 'TRON_MAINNET'
      || resources.receiverAddress !== escrowAddress || chainEvidence.receiverAddress !== escrowAddress
      || (!hasEnergy && !hasBandwidth)
      || (hasEnergy && (!verifiedEnergy || BigInt(chainEvidence.energyLimit) < BigInt(resources.energyLimit)))
      || (hasBandwidth && (!verifiedBandwidth || BigInt(chainEvidence.bandwidthLimit) < BigInt(resources.bandwidthLimit)))
      || !Array.isArray(resourceTxIds) || resourceTxIds.length === 0
      || resourceTxIds.some((id) => typeof id !== 'string' || !/^[0-9a-f]{64}$/i.test(id))
      || !Number.isFinite(Date.parse(resources.expiresAt)) || Date.parse(resources.expiresAt) <= now) {
      fail('provider-delegated-resources-not-verified-for-escrow')
    }
    delegatedResourceEvidence = Object.freeze({
      receiverAddress: resources.receiverAddress,
      energyLimit: hasEnergy ? chainEvidence.energyLimit : '0',
      bandwidthLimit: hasBandwidth ? chainEvidence.bandwidthLimit : '0',
      resourceTransactionIds: Object.freeze([...resourceTxIds]),
      expiresAt: resources.expiresAt,
    })
  }
  return Object.freeze({
    providerId: 'ripple',
    providerAuthorizationId: facility.providerAuthorizationId,
    agreementReference: facility.agreementReference,
    destination: 'escrow',
    amountSun,
    feeBudgetSun,
    feeFundingMode: facility.feeFundingMode,
    delegatedResourceEvidence,
    expiresAt: facility.expiresAt,
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
