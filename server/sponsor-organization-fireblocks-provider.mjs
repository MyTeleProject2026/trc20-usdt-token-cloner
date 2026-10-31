import {
  createFireblocksClient,
  fireblocksConfiguration,
  fireblocksAssetIdentifierMatches,
  isOfficialFireblocksUsdtAsset,
  isNativeFireblocksTrxAsset,
  providerAssetAvailableBaseUnits,
  maxFireblocksEstimatedFeeSun,
} from './fireblocks-client.mjs'
import { preflightSponsorOrganizationPayoutIntent } from './sponsor-organization-transaction-preflight.mjs'

const OFFICIAL_MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const NUMERIC_ID = /^[1-9][0-9]{0,17}$/
const VAULT_ID = /^\d{1,32}$/
const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function decimalFromSixDecimalBaseUnits(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,77}$/.test(value)) return null
  const units = BigInt(value)
  const whole = units / 1_000_000n
  const fraction = (units % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return fraction ? whole.toString() + '.' + fraction : whole.toString()
}

function hasSixDecimals(asset) {
  const values = [asset?.decimals, asset?.onchain?.decimals, asset?.onChain?.decimals]
    .filter((value) => value !== undefined && value !== null)
  return values.length > 0 && values.every((value) => Number(value) === 6)
}

function sponsorFireblocksConfiguration(env = process.env) {
  const fields = {
    organizationId: 'SPONSOR_FIREBLOCKS_REGISTRY_ORGANIZATION_ID',
    principalAccountId: 'SPONSOR_FIREBLOCKS_REGISTRY_PRINCIPAL_ACCOUNT_ID',
    feeAccountId: 'SPONSOR_FIREBLOCKS_REGISTRY_FEE_ACCOUNT_ID',
    principalVaultAccountId: 'SPONSOR_FIREBLOCKS_PRINCIPAL_VAULT_ACCOUNT_ID',
    feeVaultAccountId: 'SPONSOR_FIREBLOCKS_FEE_VAULT_ACCOUNT_ID',
    usdtAssetId: 'SPONSOR_FIREBLOCKS_USDT_ASSET_ID',
    trxAssetId: 'SPONSOR_FIREBLOCKS_TRX_ASSET_ID',
  }
  const values = Object.fromEntries(Object.entries(fields).map(([key, envName]) => [
    key, typeof env[envName] === 'string' ? env[envName].trim() : '',
  ]))
  const missing = Object.entries(fields)
    .filter(([key]) => !values[key])
    .map(([, envName]) => envName)
  if (values.organizationId && !NUMERIC_ID.test(values.organizationId)) missing.push(fields.organizationId + ' (numeric registry ID required)')
  if (values.principalAccountId && !NUMERIC_ID.test(values.principalAccountId)) missing.push(fields.principalAccountId + ' (numeric registry ID required)')
  if (values.feeAccountId && !NUMERIC_ID.test(values.feeAccountId)) missing.push(fields.feeAccountId + ' (numeric registry ID required)')
  if (values.principalVaultAccountId && !VAULT_ID.test(values.principalVaultAccountId)) missing.push(fields.principalVaultAccountId + ' (numeric Fireblocks vault ID required)')
  if (values.feeVaultAccountId && !VAULT_ID.test(values.feeVaultAccountId)) missing.push(fields.feeVaultAccountId + ' (numeric Fireblocks vault ID required)')
  if (values.usdtAssetId && !ASSET_ID.test(values.usdtAssetId)) missing.push(fields.usdtAssetId + ' (invalid Fireblocks asset ID)')
  if (values.trxAssetId && !ASSET_ID.test(values.trxAssetId)) missing.push(fields.trxAssetId + ' (invalid Fireblocks asset ID)')
  if (values.principalVaultAccountId && values.feeVaultAccountId
    && values.principalVaultAccountId === values.feeVaultAccountId) {
    missing.push('distinct Fireblocks vault accounts are required for principal and fee roles')
  }
  const principalEnv = {
    ...env,
    FIREBLOCKS_VAULT_ACCOUNT_ID: values.principalVaultAccountId,
    FIREBLOCKS_USDT_ASSET_ID: values.usdtAssetId,
    FIREBLOCKS_TRX_ASSET_ID: values.trxAssetId,
  }
  const feeEnv = {
    ...env,
    FIREBLOCKS_VAULT_ACCOUNT_ID: values.feeVaultAccountId,
    FIREBLOCKS_USDT_ASSET_ID: values.usdtAssetId,
    FIREBLOCKS_TRX_ASSET_ID: values.trxAssetId,
  }
  const principalProvider = fireblocksConfiguration(principalEnv)
  const feeProvider = fireblocksConfiguration(feeEnv)
  if (!principalProvider.providerConfigured || !feeProvider.providerConfigured) {
    missing.push(...[...new Set([...principalProvider.providerMissing, ...feeProvider.providerMissing])])
  }
  return {
    configured: missing.length === 0,
    missing: [...new Set(missing)],
    values,
    principalEnv,
    feeEnv,
  }
}

/**
 * Read-only bridge between an organization-linked payout intent and the
 * organization's two Fireblocks vault accounts. It verifies exact registry
 * bindings, token metadata, provider balances and the provider's high fee
 * estimate. It never creates a Fireblocks transaction or signs/broadcasts.
 *
 * This first production adapter deliberately supports one approved organization
 * with separate principal and fee vault accounts in one Fireblocks workspace.
 */
export async function preflightSponsorOrganizationFireblocksProvider({
  store,
  intentId,
  env = process.env,
  fireblocksClientFactory = createFireblocksClient,
  chainPreflight = preflightSponsorOrganizationPayoutIntent,
  fetchImpl,
  readSecretFile,
  tronWebFactory = async () => {
    const { TronWeb } = await import('tronweb')
    return new TronWeb({ fullHost: 'https://api.trongrid.io' })
  },
  timeoutMs = 8000,
} = {}) {
  const fail = (reason, extra = {}) => ({
    success: false,
    status: reason,
    reason,
    canSubmitSponsoredTransfer: false,
    submissionEnabled: false,
    transactionSubmitted: false,
    userFundedFallbackAllowed: false,
    ...extra,
  })

  if (!store || typeof store.getPayoutIntentForPreflight !== 'function'
    || typeof intentId !== 'string' || !NUMERIC_ID.test(intentId)) {
    return fail('invalid-fireblocks-sponsor-preflight-request')
  }

  const config = sponsorFireblocksConfiguration(env)
  if (!config.configured) {
    return fail('sponsor-fireblocks-provider-not-configured', { missing: config.missing })
  }

  let loaded
  try {
    loaded = await store.getPayoutIntentForPreflight(intentId)
  } catch {
    return fail('sponsor-payout-intent-read-unavailable')
  }
  if (!loaded?.success || !loaded.intent) return fail(loaded?.reason || 'sponsor-payout-intent-not-found')
  const intent = loaded.intent

  if (intent.status !== 'sponsor_authorization_complete'
    || loaded.sponsorOwnerApprovalsVerified !== true) {
    return fail('both-sponsor-owner-approvals-required')
  }
  if (intent.network !== 'mainnet' || intent.asset !== 'USDT'
    || intent.tokenContract !== OFFICIAL_MAINNET_USDT) {
    return fail('fireblocks-adapter-requires-official-mainnet-usdt')
  }

  const values = config.values
  if (String(intent.principalOrganizationId || '') !== values.organizationId
    || String(intent.feeOrganizationId || '') !== values.organizationId
    || String(intent.principalAccountId || '') !== values.principalAccountId
    || String(intent.feeAccountId || '') !== values.feeAccountId
    || values.principalAccountId === values.feeAccountId
    || intent.principalSponsorAddress === intent.feeSponsorAddress) {
    return fail('fireblocks-vault-to-registry-account-binding-mismatch')
  }

  const amountUsdt = decimalFromSixDecimalBaseUnits(intent.amountBaseUnits)
  if (!amountUsdt || !/^[1-9][0-9]{0,77}$/.test(intent.feeCapSun || '')) {
    return fail('fireblocks-payout-amount-or-fee-cap-invalid')
  }

  let chain
  try {
    chain = await chainPreflight({
      store, intentId, env, fetchImpl, tronWebFactory,
      timeoutMs,
    })
  } catch {
    return fail('tron-transaction-specific-preflight-unavailable')
  }
  if (chain?.success !== true
    || chain.status !== 'transaction-specific-resource-preflight-passed-review-required') {
    return fail('tron-resource-preflight-not-passed', {
      chainPreflightStatus: chain?.status || chain?.reason || 'unknown',
      chainPreflight: chain || null,
    })
  }

  try {
    const clientOptions = {}
    if (typeof fetchImpl === 'function') clientOptions.fetchImpl = fetchImpl
    if (typeof readSecretFile === 'function') clientOptions.readSecretFile = readSecretFile
    const principalClient = fireblocksClientFactory(config.principalEnv, clientOptions)
    const feeClient = fireblocksClientFactory(config.feeEnv, clientOptions)
    if (principalClient?.isConfigured?.() !== true
      || feeClient?.isConfigured?.() !== true) {
      return fail('fireblocks-role-specific-provider-configuration-incomplete')
    }

    const [principalVault, feeVault, principalMetadata, feeMetadata, principalAddresses, feeAddresses, principalAsset, feeAsset] = await Promise.all([
      principalClient.getVaultAccount(),
      feeClient.getVaultAccount(),
      principalClient.getAssetMetadata(values.usdtAssetId),
      feeClient.getAssetMetadata(values.trxAssetId),
      principalClient.getAssetAddresses(values.usdtAssetId),
      feeClient.getAssetAddresses(values.trxAssetId),
      principalClient.getVaultAccountAsset(values.usdtAssetId),
      feeClient.getVaultAccountAsset(values.trxAssetId),
    ])

    if (String(principalVault?.id ?? '') !== values.principalVaultAccountId
      || String(feeVault?.id ?? '') !== values.feeVaultAccountId) {
      return fail('fireblocks-vault-account-identity-mismatch')
    }
    if (!fireblocksAssetIdentifierMatches(principalMetadata, values.usdtAssetId)
      || !isOfficialFireblocksUsdtAsset(principalMetadata, await tronWebFactory(), OFFICIAL_MAINNET_USDT)
      || !hasSixDecimals(principalMetadata)) {
      return fail('fireblocks-asset-is-not-official-six-decimal-tron-usdt')
    }
    if (!isNativeFireblocksTrxAsset(feeMetadata, values.trxAssetId)) {
      return fail('fireblocks-fee-asset-is-not-native-trx')
    }

    const principalAddressList = Array.isArray(principalAddresses?.addresses) ? principalAddresses.addresses : []
    const feeAddressList = Array.isArray(feeAddresses?.addresses) ? feeAddresses.addresses : []
    if (principalAddressList.length !== 1 || principalAddressList[0] !== intent.principalSponsorAddress
      || feeAddressList.length !== 1 || feeAddressList[0] !== intent.feeSponsorAddress) {
      return fail('fireblocks-wallet-address-does-not-match-verified-sponsor-account')
    }

    if (!fireblocksAssetIdentifierMatches(principalAsset, values.usdtAssetId)
      || !fireblocksAssetIdentifierMatches(feeAsset, values.trxAssetId)) {
      return fail('fireblocks-vault-asset-identification-mismatch')
    }
    const providerUsdtAvailable = providerAssetAvailableBaseUnits(principalAsset)
    const providerTrxAvailable = providerAssetAvailableBaseUnits(feeAsset)
    if (providerUsdtAvailable === null || providerTrxAvailable === null) {
      return fail('fireblocks-provider-available-balance-unavailable')
    }
    if (BigInt(providerUsdtAvailable) < BigInt(intent.amountBaseUnits)) {
      return fail('fireblocks-principal-provider-balance-insufficient', {
        providerUsdtAvailableBaseUnits: providerUsdtAvailable,
        requestedAmountBaseUnits: intent.amountBaseUnits,
      })
    }

    const estimate = await principalClient.estimateUsdtTransferFee({
      recipientAddress: intent.receiverAddress,
      amountUsdt,
    })
    const estimatedFeeSun = maxFireblocksEstimatedFeeSun(estimate)
    if (estimatedFeeSun === null) return fail('fireblocks-fee-estimate-incomplete')
    if (BigInt(estimatedFeeSun) > BigInt(intent.feeCapSun)) {
      return fail('fireblocks-estimated-fee-exceeds-approved-fee-cap', {
        estimatedFeeSun,
        approvedFeeCapSun: intent.feeCapSun,
      })
    }

    return {
      success: true,
      status: 'fireblocks-custody-preflight-passed-review-required',
      intent: {
        id: intent.id,
        intentDigest: intent.intentDigest,
        organizationId: values.organizationId,
        principalRegistryAccountId: values.principalAccountId,
        feeRegistryAccountId: values.feeAccountId,
        network: intent.network,
        asset: intent.asset,
        tokenContract: intent.tokenContract,
        receiverAddress: intent.receiverAddress,
        amountBaseUnits: intent.amountBaseUnits,
        feeCapSun: intent.feeCapSun,
      },
      provider: {
        name: 'Fireblocks',
        workspaceReachable: true,
        principalVaultAccountVerified: true,
        feeVaultAccountVerified: true,
        principalWalletAddressVerified: true,
        feeWalletAddressVerified: true,
        officialUsdtAssetVerified: true,
        nativeTrxFeeAssetVerified: true,
        providerUsdtAvailableBaseUnits: providerUsdtAvailable,
        providerTrxAvailableBaseUnits: providerTrxAvailable,
        estimatedHighNetworkFeeSun: estimatedFeeSun,
        estimatedFeeWithinApprovedCap: true,
      },
      tronResourcePreflight: {
        status: chain.status,
        estimatedNetworkFeeSun: chain.resourceEstimate?.estimatedNetworkFeeSun || null,
        principalResourcesCoverCurrentEstimate: chain.resourceEstimate?.principalResourcesCoverCurrentEstimate === true,
        feeSponsorDelegationObserved: chain.resourceEstimate?.feeSponsorDelegationObserved === true,
      },
      transactionCreated: false,
      transactionSigned: false,
      transactionSubmitted: false,
      transactionSpecificFeeCoverageVerified: false,
      canSubmitSponsoredTransfer: false,
      submissionEnabled: false,
      userFundedFallbackAllowed: false,
      blockers: [
        'Provider vault IDs and assets are checked read-only; no Fireblocks transaction request is created.',
        'The provider organization must separately confirm its transaction policy, approvers, and legal mandate.',
        'A human production release review and a separately implemented, idempotent submission/settlement workflow are still required.',
      ],
    }
  } catch {
    return fail('fireblocks-provider-preflight-unavailable')
  }
}

export { sponsorFireblocksConfiguration }
export default preflightSponsorOrganizationFireblocksProvider
