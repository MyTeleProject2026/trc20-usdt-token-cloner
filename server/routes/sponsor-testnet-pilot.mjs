import { tatumProviderFetch } from '../tatum-provider-fetch.mjs'
import { Router } from 'express'
import { createSponsorRoleFundingReader } from '../sponsor-roles.mjs'
import { isValidTronAddress } from '../tron-address.mjs'

const NETWORKS = Object.freeze({
  shasta: 'https://tron-shasta.gateway.tatum.io',
  nile: 'https://tron-nile.gateway.tatum.io',
})
const TOKEN_ALLOWLIST_ENV = Object.freeze({
  shasta: { USDT: 'SPONSOR_USDT_SHASTA_CONTRACTS' },
  nile: { USDT: 'SPONSOR_USDT_NILE_CONTRACTS' },
})
const SAFE_PROVIDER_RESPONSE_FIELDS = new Set([
  'EnergyLimit', 'EnergyUsed', 'NetLimit', 'NetUsed', 'freeNetLimit', 'freeNetUsed',
  'TotalEnergyLimit', 'TotalEnergyWeight', 'TotalNetLimit', 'TotalNetWeight',
  'max_size', 'result', 'Error', 'error', 'message', 'code', 'status', 'statusCode',
  'data', 'success', 'timestamp', 'resource', 'visible',
])
const SAFE_RESOURCE_PROVIDER_ERROR_CATEGORIES = new Set([
  'account-not-found',
  'invalid-address',
  'endpoint-not-supported',
  'rate-limited',
  'invalid-request',
  'invalid-response-shape',
  'node-error-response',
  'provider-timeout',
  'provider-transport-error',
  'provider-request-failed',
  'invalid-json-response',
  'missing-resource-fields',
  'invalid-resource-fields',
  'resource-counter-exceeds-limit',
  'missing-delegation-ceiling',
  'invalid-delegation-ceiling',
])

function positiveInteger(value) {
  try {
    if (typeof value !== 'string' && typeof value !== 'number') return false
    const text = String(value)
    return /^(0|[1-9][0-9]*)$/.test(text) && BigInt(text) > 0n
  } catch {
    return false
  }
}

function tokenAllowlistConfigured(env, key) {
  const value = typeof env[key] === 'string' ? env[key].trim() : ''
  if (!value) return false
  const contracts = value.split(',').map((entry) => entry.trim())
  return contracts.length > 0 && contracts.every(isValidTronAddress)
}

function minimumDelegationStakeMet(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return false
  const text = String(value)
  if (!/^(0|[1-9][0-9]*)$/.test(text)) return false
  return BigInt(text) >= 1_000_000n
}

/**
 * Read only the selected testnet's latest solidified block from a fixed Tatum
 * origin. The caller cannot supply a host, path, headers, or credentials.
 */
export async function readTestnetSolidifiedHead({
  network,
  env = process.env,
  fetchImpl = tatumProviderFetch,
  timeoutMs = 8000,
} = {}) {
  const host = NETWORKS[network]
  if (!host) return { success: false, network: network ?? null, status: 'unsupported-testnet' }
  if (typeof env.TATUM_API_KEY !== 'string' || !env.TATUM_API_KEY.trim()) {
    return { success: false, network, status: 'provider-credentials-missing' }
  }
  if (typeof fetchImpl !== 'function') return { success: false, network, status: 'provider-unavailable' }

  try {
    const response = await fetchImpl(`${host}/walletsolidity/getnowblock`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-api-key': env.TATUM_API_KEY.trim(),
      },
      body: '{}',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      return {
        success: false,
        network,
        status: 'provider-http-error',
        providerStatus: response.status,
      }
    }
    const payload = await response.json()
    const blockNumber = payload?.block_header?.raw_data?.number
    const blockTimestamp = payload?.block_header?.raw_data?.timestamp
    const blockId = payload?.blockID
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 1
      || typeof blockId !== 'string' || !/^[0-9a-f]{64}$/i.test(blockId)
      || !Number.isSafeInteger(blockTimestamp) || blockTimestamp <= 0) {
      return { success: false, network, status: 'invalid-solidified-block-response' }
    }
    return {
      success: true,
      network,
      status: 'solidified-node-reachable',
      latestSolidifiedBlockNumber: blockNumber,
      latestSolidifiedBlockTimestamp: blockTimestamp,
      checkedAt: new Date().toISOString(),
    }
  } catch {
    // Do not return provider exceptions: they may include origin/credential details.
    return { success: false, network, status: 'provider-unreachable' }
  }
}

function summarizeRole(role) {
  if (!role || typeof role !== 'object') {
    return { addressConfigured: false, onChainBalanceRead: false, status: 'role-status-unavailable' }
  }
  const tokens = Array.isArray(role.tokens) ? role.tokens.map((token) => ({
    asset: token.asset,
    status: token.status,
    ...(typeof token.balanceBaseUnits === 'string' ? { balanceBaseUnits: token.balanceBaseUnits } : {}),
    ...(Number.isSafeInteger(token.decimals) ? { decimals: token.decimals } : {}),
  })) : []
  return {
    addressConfigured: role.addressConfigured === true,
    onChainBalanceRead: role.onChainBalanceRead === true,
    status: typeof role.status === 'string' ? role.status : 'role-status-unavailable',
    native: role.native?.status === 'verified'
      ? {
          status: 'verified',
          balanceSun: role.native.balanceSun,
          balanceTRX: role.native.balanceTRX,
          hasPositiveBalance: positiveInteger(role.native.balanceSun),
          accountExists: role.native.accountExists === true,
        }
      : { status: 'not-verified' },
    tokens,
    tokenBalancesComplete: role.tokenBalancesComplete === true,
  }
}

export function buildNetworkSummary({ network, head, roleResult, env }) {
  const roles = roleResult?.roles || {}
  const feeRole = roles.networkFeeSponsor
  const assetRole = roles.assetPrincipalSponsor
  const feeConfigured = feeRole?.addressConfigured === true
  const assetConfigured = assetRole?.addressConfigured === true
  const rolesDistinct = roleResult?.configuredAddressesDistinct === true
  const feeChainRead = feeRole?.onChainBalanceRead === true
  const assetChainRead = assetRole?.onChainBalanceRead === true
  const resourceStatus = feeRole?.resourceStatus
  const resourceRead = resourceStatus?.resourceRead === true
  const delegation = roleResult?.feeSponsorDelegationToPrincipal
  const activeEnergy = delegation?.activeEnergyStakeSun
  const activeBandwidth = delegation?.activeBandwidthStakeSun
  // The supported USDT pilot needs both delegated Energy and Bandwidth.
  // A positive reading for only one resource must never be treated as a complete delegation.
  const delegationObserved = delegation?.success === true
    && minimumDelegationStakeMet(activeEnergy) && minimumDelegationStakeMet(activeBandwidth)

  const allowlists = Object.fromEntries(Object.entries(TOKEN_ALLOWLIST_ENV[network]).map(([asset, key]) => [
    asset, tokenAllowlistConfigured(env, key),
  ]))
  const usdtAllowlistConfigured = allowlists.USDT === true
  const usdtAllowlistKey = TOKEN_ALLOWLIST_ENV[network]?.USDT
  const allowlistedUsdtContracts = typeof usdtAllowlistKey === 'string'
    ? String(env[usdtAllowlistKey] || '').split(',').map(value => value.trim()).filter(Boolean)
    : []
  const assetPrincipalUsdtFundingVerified = assetRole?.tokenBalancesComplete === true
    && Array.isArray(assetRole.tokens)
    && assetRole.tokens.some(token =>
      ['USDT', 'USDT (testnet)'].includes(token?.asset)
      && token.status === 'verified'
      && allowlistedUsdtContracts.includes(token.tokenContract)
      && positiveInteger(token.balanceBaseUnits))

  const blockers = []
  if (head?.success !== true) blockers.push(`testnet-node-${head?.status || 'unavailable'}`)
  if (!feeConfigured) blockers.push('fee-sponsor-address-not-configured')
  if (!assetConfigured) blockers.push('asset-principal-sponsor-address-not-configured')
  if (feeConfigured && assetConfigured && !rolesDistinct) blockers.push('sponsor-role-addresses-must-be-distinct')
  if (!feeChainRead) blockers.push('fee-sponsor-on-chain-balance-not-verified')
  if (!assetChainRead) blockers.push('asset-principal-on-chain-balance-not-verified')
  if (!resourceRead) blockers.push('fee-sponsor-resource-capacity-not-verified')
  if (!delegationObserved) blockers.push('active-fee-to-principal-energy-and-bandwidth-delegation-not-verified')
  if (!usdtAllowlistConfigured) blockers.push('usdt-token-contract-allowlist-not-configured')
  if (usdtAllowlistConfigured && !assetPrincipalUsdtFundingVerified) {
    blockers.push('asset-principal-usdt-funding-not-verified-positive')
  }
  if (!env.DATABASE_URL?.trim()) blockers.push('project-database-not-configured')
  if (typeof env.SPONSOR_ADMIN_API_TOKEN !== 'string' || env.SPONSOR_ADMIN_API_TOKEN.length < 32) {
    blockers.push('sponsor-admin-token-not-configured')
  }
  if (!env.SPONSOR_APPROVED_AGREEMENT_REFERENCES?.trim()) blockers.push('approved-agreement-scope-not-configured')
  // Even a non-empty allowlist and agreement environment variable prove only
  // configuration. Ownership, sponsor consent and exact agreement scope need review.
  blockers.push('sponsor-ownership-and-spending-mandate-require-independent-review')
  blockers.push('post-transfer-fee-settlement-and-receiver-reconciliation-not-end-to-end-verified')

  return {
    network,
    preflightStatus: head?.success === true && feeConfigured && assetConfigured
      && rolesDistinct && feeChainRead && assetChainRead && resourceRead
      && delegationObserved && usdtAllowlistConfigured && assetPrincipalUsdtFundingVerified
      ? 'live-chain-preflight-passed-review-required'
      : 'blocked-by-live-or-configuration-prerequisites',
    networkNode: head?.success === true
      ? {
          reachable: true,
          status: head.status,
          latestSolidifiedBlockNumber: head.latestSolidifiedBlockNumber,
          latestSolidifiedBlockTimestamp: head.latestSolidifiedBlockTimestamp,
          checkedAt: head.checkedAt,
        }
      : {
          reachable: false,
          status: head?.status || 'provider-unavailable',
          ...(Number.isInteger(head?.providerStatus) ? { providerStatus: head.providerStatus } : {}),
        },
    roleConfiguration: {
      feeSponsorAddressConfigured: feeConfigured,
      assetPrincipalSponsorAddressConfigured: assetConfigured,
      rolesDistinct,
      feeSponsorOnChainBalanceRead: feeChainRead,
      assetPrincipalSponsorOnChainBalanceRead: assetChainRead,
      assetPrincipalUsdtFundingVerified,
    },
    sponsors: {
      networkFeeSponsor: summarizeRole(feeRole),
      assetPrincipalSponsor: summarizeRole(assetRole),
    },
    feeSponsorResources: {
      read: resourceRead,
      status: typeof resourceStatus?.status === 'string' ? resourceStatus.status : 'resource-read-unavailable',
      ...(Number.isInteger(resourceStatus?.providerStatus) ? { providerHttpStatus: resourceStatus.providerStatus } : {}),
      ...(typeof resourceStatus?.failureStage === 'string' ? { failureStage: resourceStatus.failureStage } : {}),
      ...(SAFE_RESOURCE_PROVIDER_ERROR_CATEGORIES.has(resourceStatus?.providerResponseCategory)
        ? { providerResponseCategory: resourceStatus.providerResponseCategory } : {}),
      ...(Array.isArray(resourceStatus?.providerResponseFields)
        ? { providerResponseFields: resourceStatus.providerResponseFields.filter((field) => SAFE_PROVIDER_RESPONSE_FIELDS.has(field)).slice(0, 12) }
        : {}),
      ...(resourceRead && resourceStatus.currentlyAvailableEnergy !== undefined
        ? { currentlyAvailableEnergy: resourceStatus.currentlyAvailableEnergy } : {}),
      ...(resourceRead && resourceStatus.currentlyAvailableBandwidth !== undefined
        ? { currentlyAvailableBandwidth: resourceStatus.currentlyAvailableBandwidth } : {}),
      delegation: {
        read: delegation?.success === true,
        status: typeof delegation?.status === 'string' ? delegation.status : 'delegation-read-unavailable',
        activeEnergyStakeSun: typeof activeEnergy === 'string' ? activeEnergy : null,
        activeBandwidthStakeSun: typeof activeBandwidth === 'string' ? activeBandwidth : null,
        activeDelegationObserved: delegationObserved,
        transactionAuditVerified: delegation?.transactionAuditVerified === true,
      },
    },
    tokenContractAllowlistConfigured: allowlists,
    approvalConfiguration: {
      databaseUrlConfigured: typeof env.DATABASE_URL === 'string' && env.DATABASE_URL.trim().length > 0,
      sponsorAdminApiTokenConfigured: typeof env.SPONSOR_ADMIN_API_TOKEN === 'string' && env.SPONSOR_ADMIN_API_TOKEN.length >= 32,
      agreementReferenceVariablePresent: typeof env.SPONSOR_APPROVED_AGREEMENT_REFERENCES === 'string'
        && env.SPONSOR_APPROVED_AGREEMENT_REFERENCES.trim().length > 0,
      testnetSignedBroadcastGateEnabled: env.SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED === 'true',
    },
    blockers,
    canSubmitSponsoredTransfer: false,
    submissionEnabled: false,
    userFundedFallbackAllowed: false,
  }
}

export function createSponsorTestnetPilotRouter(options = {}) {
  const router = Router()
  const env = options.env ?? process.env
  const fetchImpl = options.fetchImpl ?? tatumProviderFetch
  const readHead = options.readHead ?? ((network) => readTestnetSolidifiedHead({ network, env, fetchImpl }))
  const readRoles = options.readRoles ?? createSponsorRoleFundingReader({ env, fetchImpl })

  router.get('/sponsorship/testnet-pilot-readiness', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    const requestedNetwork = req.query?.network ?? 'both'
    const refreshValue = req.query?.refresh
    if (refreshValue !== undefined && refreshValue !== '0' && refreshValue !== '1') {
      return res.status(400).json({ success: false, error: 'invalid-refresh', canSubmitSponsoredTransfer: false })
    }
    const selectedNetworks = requestedNetwork === 'both'
      ? ['nile', 'shasta']
      : typeof requestedNetwork === 'string' && Object.hasOwn(NETWORKS, requestedNetwork)
        ? [requestedNetwork] : null
    if (!selectedNetworks) {
      return res.status(400).json({
        success: false,
        error: 'invalid-network',
        message: 'network must be nile, shasta, or both.',
        canSubmitSponsoredTransfer: false,
      })
    }

    const results = await Promise.all(selectedNetworks.map(async (network) => {
      const [headResult, roleResultValue] = await Promise.allSettled([
        readHead(network),
        readRoles(network, { refresh: refreshValue === '1' }),
      ])
      const head = headResult.status === 'fulfilled'
        ? headResult.value : { success: false, network, status: 'provider-unavailable' }
      const roleResult = roleResultValue.status === 'fulfilled' ? roleResultValue.value : null
      return [network, buildNetworkSummary({ network, head, roleResult, env })]
    }))
    const networks = Object.fromEntries(results)
    const allPreflightPassed = selectedNetworks.every((network) =>
      networks[network].preflightStatus === 'live-chain-preflight-passed-review-required')
    return res.status(200).json({
      success: true,
      status: allPreflightPassed
        ? 'testnet-live-preflight-passed-review-required'
        : 'testnet-live-preflight-completed-with-blockers',
      checkedAt: new Date().toISOString(),
      networks,
      submission: {
        enabled: false,
        canSubmitSponsoredTransfer: false,
        userFundedFallbackAllowed: false,
      },
      limitations: [
        'This endpoint performs read-only solidified-block, sponsor-balance, resource and delegation checks on the requested testnet(s).',
        'It reports configured public addresses only as booleans and never returns sponsor addresses or provider credentials.',
        'On-chain balances and resource snapshots do not prove account ownership, sponsor consent, spend authority or a guaranteed transaction fee.',
        'A valid environment agreement reference is not independent proof of a signed mandate covering the exact transaction.',
        'The diagnostic endpoint never enables signing or broadcast. Transaction fee settlement and receiver-balance reconciliation still require an end-to-end test.',
      ],
    })
  })

  return router
}

export default createSponsorTestnetPilotRouter()
