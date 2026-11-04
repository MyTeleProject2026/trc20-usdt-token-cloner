import { Router } from 'express'
import { createSponsorRoleFundingReader } from '../sponsor-roles.mjs'
import { getDatabaseStatus } from '../database.mjs'
import { isValidTronAddress } from '../tron-address.mjs'

export const OFFICIAL_MAINNET_USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

// This diagnostic must never become a transfer switch. Mainnet signing/broadcast
// remains a separate, reviewed implementation and release decision.
export const MAINNET_DIRECT_SPONSOR_EXECUTION_DISABLED = true

function isPositiveInteger(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value)
}

function matchesApprovedScope(env, expected) {
  const scopes = String(env.SPONSOR_APPROVED_AGREEMENT_REFERENCES || '')
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
  return scopes.some((entry) => {
    const fields = entry.split('|')
    if (fields.length !== 7) return false
    const [, sponsorReference, network, sponsorAddress, purpose, asset, tokenContract] = fields
    return sponsorReference.length > 0
      && network === 'mainnet'
      && sponsorAddress === expected.sponsorAddress
      && purpose === expected.purpose
      && asset === expected.asset
      && tokenContract === expected.tokenContract
  })
}

function isFresh(checkedAt, nowMs) {
  if (typeof checkedAt !== 'string') return false
  const timestamp = Date.parse(checkedAt)
  return Number.isFinite(timestamp) && timestamp <= nowMs + 5_000 && nowMs - timestamp <= 15_000
}

/**
 * Summarize Mainnet sponsor diagnostics without exposing wallet addresses,
 * credentials, signing material, or claiming that a balance is spend authority.
 */
export function buildMainnetDirectSponsorReadiness({
  roleResult,
  database,
  env = process.env,
  nowMs = Date.now(),
} = {}) {
  const roles = roleResult?.roles || {}
  const fee = roles.networkFeeSponsor || {}
  const principal = roles.assetPrincipalSponsor || {}
  const feeAddress = typeof fee.address === 'string' ? fee.address.trim() : ''
  const principalAddress = typeof principal.address === 'string' ? principal.address.trim() : ''
  const feeAddressValid = isValidTronAddress(feeAddress)
  const principalAddressValid = isValidTronAddress(principalAddress)
  const rolesDistinct = feeAddressValid && principalAddressValid
    && feeAddress !== principalAddress
    && roleResult?.configuredAddressesDistinct === true
  const fresh = roleResult?.success === true && isFresh(roleResult.checkedAt, nowMs)
  const officialUsdt = Array.isArray(principal.tokens)
    ? principal.tokens.find((token) =>
        token?.asset === 'USDT'
        && token?.tokenContract === OFFICIAL_MAINNET_USDT_CONTRACT
        && token?.status === 'verified'
        && token?.decimals === 6
        && isPositiveInteger(token?.balanceBaseUnits))
    : null
  const principalFundingRead = principal.onChainBalanceRead === true
    && principal.tokenBalancesComplete === true
    && Boolean(officialUsdt)
  const feeFundingRead = fee.onChainBalanceRead === true
    && fee.resourceStatus?.resourceRead === true
  const delegation = roleResult?.feeSponsorDelegationToPrincipal || {}
  const auditedResources = new Set(Array.isArray(delegation.auditedResourceTypes)
    ? delegation.auditedResourceTypes : [])
  const delegationAudited = delegation.success === true
    && delegation.transactionAuditVerified === true
    && auditedResources.has('ENERGY')
    && auditedResources.has('BANDWIDTH')
    && isPositiveInteger(delegation.activeEnergyStakeSun)
    && isPositiveInteger(delegation.activeBandwidthStakeSun)
  const feeScope = feeAddressValid && matchesApprovedScope(env, {
    sponsorAddress: feeAddress,
    purpose: 'network-fee',
    asset: 'TRX',
    tokenContract: '-',
  })
  const principalScope = principalAddressValid && matchesApprovedScope(env, {
    sponsorAddress: principalAddress,
    purpose: 'asset-grant',
    asset: 'USDT',
    tokenContract: OFFICIAL_MAINNET_USDT_CONTRACT,
  })
  const databaseReady = database?.ready === true
  const blockers = []

  if (!fresh) blockers.push('fresh-mainnet-sponsor-role-snapshot-required')
  if (!feeAddressValid) blockers.push('mainnet-network-fee-sponsor-address-not-configured-or-invalid')
  if (!principalAddressValid) blockers.push('mainnet-asset-principal-sponsor-address-not-configured-or-invalid')
  if (feeAddressValid && principalAddressValid && !rolesDistinct) blockers.push('mainnet-sponsor-role-addresses-must-be-distinct')
  if (!feeFundingRead) blockers.push('mainnet-fee-sponsor-balance-or-resource-read-unavailable')
  if (!principalFundingRead) blockers.push('official-mainnet-usdt-principal-balance-not-independently-verified-positive')
  if (!delegationAudited) blockers.push('mainnet-fee-to-principal-energy-and-bandwidth-delegation-not-audited')
  if (!feeScope) blockers.push('exact-mainnet-network-fee-sponsor-agreement-scope-not-configured')
  if (!principalScope) blockers.push('exact-mainnet-usdt-principal-sponsor-agreement-scope-not-configured')
  if (!databaseReady) blockers.push('project-database-not-ready')
  blockers.push('mainnet-direct-request-reservation-and-sponsor-wallet-signing-route-not-implemented')
  blockers.push('transaction-specific-mainnet-fee-capacity-and-execution-reconciliation-not-verified')
  blockers.push('sponsor-legal-authority-account-ownership-and-source-of-funds-require-independent-review')
  blockers.push('funded-mainnet-acceptance-transfer-and-independent-security-approval-required')

  const diagnosticsRead = roleResult?.success === true && database !== null && database !== undefined
  return {
    success: diagnosticsRead,
    status: diagnosticsRead
      ? 'mainnet-direct-sponsor-diagnostics-completed'
      : 'mainnet-direct-sponsor-diagnostics-unavailable',
    network: 'mainnet',
    model: 'sponsor-wallet-direct-to-recipient',
    readOnly: true,
    checkedAt: typeof roleResult?.checkedAt === 'string' ? roleResult.checkedAt : new Date(nowMs).toISOString(),
    sponsorRoles: {
      networkFeeSponsor: {
        addressConfigured: feeAddressValid,
        onChainBalanceRead: fee.onChainBalanceRead === true,
        nativeTrxBalanceRead: fee.native?.status === 'verified',
        resourceRead: fee.resourceStatus?.resourceRead === true,
        agreementScopeConfigured: feeScope,
      },
      assetPrincipalSponsor: {
        addressConfigured: principalAddressValid,
        onChainBalanceRead: principal.onChainBalanceRead === true,
        officialUsdtContract: OFFICIAL_MAINNET_USDT_CONTRACT,
        officialUsdtBalanceVerified: Boolean(officialUsdt),
        agreementScopeConfigured: principalScope,
      },
      addressesDistinct: rolesDistinct,
      feeResourceDelegationTransactionAuditVerified: delegationAudited,
    },
    database: {
      configured: database?.configured === true,
      ready: databaseReady,
    },
    preflightReady: false,
    mainnetExecutionDisabled: MAINNET_DIRECT_SPONSOR_EXECUTION_DISABLED,
    canCreateSigningIntent: false,
    canSubmitSponsoredTransfer: false,
    unpaidFallbackToUserFunds: false,
    blockers,
    limitations: [
      'The sponsor wallet, not the requester or platform treasury, is intended to send USDT directly to the recipient.',
      'This endpoint is diagnostic only. It does not reserve sponsor principal, prepare a transaction, request a wallet signature, or broadcast.',
      'Configured agreement references are scope allowlists, not proof of a legally authorized sponsor or source of funds.',
      'A positive on-chain balance does not prove that the sponsor has authorized this withdrawal or that the transaction fee will be fully covered.',
      'A solidified TRON transfer does not prove that an exchange credited the deposit.',
    ],
  }
}

export function createMainnetDirectSponsorReadinessRouter({
  env = process.env,
  readRoles = createSponsorRoleFundingReader({ env }),
  readDatabase = getDatabaseStatus,
  now = () => Date.now(),
} = {}) {
  const router = Router()

  router.get('/sponsorship/mainnet-direct/readiness', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    res.setHeader('Pragma', 'no-cache')
    const refresh = req.query?.refresh
    if (refresh !== undefined && refresh !== '0' && refresh !== '1') {
      return res.status(400).json({
        success: false,
        error: 'invalid-refresh',
        message: 'refresh must be 0 or 1.',
        canSubmitSponsoredTransfer: false,
      })
    }

    try {
      const [roleResult, database] = await Promise.all([
        readRoles('mainnet', { refresh: refresh === '1' }),
        readDatabase(),
      ])
      const result = buildMainnetDirectSponsorReadiness({
        roleResult,
        database,
        env,
        nowMs: now(),
      })
      return res.status(result.success ? 200 : 503).json(result)
    } catch {
      return res.status(503).json({
        success: false,
        status: 'mainnet-direct-sponsor-diagnostics-unavailable',
        network: 'mainnet',
        readOnly: true,
        preflightReady: false,
        mainnetExecutionDisabled: true,
        canCreateSigningIntent: false,
        canSubmitSponsoredTransfer: false,
        unpaidFallbackToUserFunds: false,
        blockers: ['mainnet-sponsor-role-or-database-diagnostics-unavailable'],
      })
    }
  })

  return router
}

export default createMainnetDirectSponsorReadinessRouter()
