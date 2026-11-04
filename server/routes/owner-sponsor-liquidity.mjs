import { createHash } from 'node:crypto'
import { Router } from 'express'
import { getWalletAuthSession, listSponsorBudgets, isApprovedSponsorAgreementScope } from '../database.mjs'
import { createSponsorFundingReader } from '../sponsor-funding.mjs'
import { reconcileSponsorBudgets } from '../sponsor-reconciliation.mjs'
import { isValidTronAddress } from '../tron-address.mjs'

const OFFICIAL_MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const MAX_SOURCES = 20

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function header(req, name) {
  const value = typeof req.get === 'function' ? req.get(name) : req.headers?.[name.toLowerCase()]
  return typeof value === 'string' ? value : ''
}

function validOwnerSessionToken(req) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header(req, 'authorization'))
  const origin = header(req, 'origin')
  return match && origin ? { tokenHash: digest(match[1]), origin } : null
}

function sumActiveApprovedCapacity(budgets) {
  return budgets.reduce((total, budget) => {
    if (budget.status !== 'active' || budget.approvalScopeVerified !== true) return total
    const cap = BigInt(budget.budget_base_units)
    const reserved = BigInt(budget.reserved_base_units)
    const spent = BigInt(budget.spent_base_units)
    if (reserved + spent > cap) throw new Error('invalid-sponsor-budget-invariant')
    return total + cap - reserved - spent
  }, 0n)
}

/**
 * Owner-authenticated, read-only aggregation of Mainnet sponsor USDT capacity.
 * Only active, exact-scope-approved asset-grant budgets with fresh solidified
 * USDT balances covering every commitment contribute to available capacity.
 * The owner wallet is excluded from sponsor sources by identity.
 */
export function createOwnerSponsorLiquidityRouter({
  env = process.env,
  getSession = getWalletAuthSession,
  listBudgets = listSponsorBudgets,
  isApprovedScope = isApprovedSponsorAgreementScope,
  readFunding = null,
  now = () => Date.now(),
} = {}) {
  const router = Router()
  const defaultReadFunding = (address) => createSponsorFundingReader({
    env: { ...env, SPONSOR_MAINNET_ADDRESS: address },
  })('mainnet', { refresh: true })

  router.get('/sponsor-liquidity', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Vary', 'Authorization, Origin')

    if (req.query?.network !== 'mainnet') {
      return res.status(400).json({
        success: false, error: 'mainnet-required',
        availableBaseUnits: '0', onChainBalanceBaseUnits: '0',
        canSubmitSponsoredTransfer: false, submissionEnabled: false,
      })
    }

    // OWNER_WALLET_ADDRESS is the identity accepted by owner-console login.
    // Also exclude TREASURY_OWNER_ADDRESS if an older deployment has it set separately.
    const ownerAddress = [env.OWNER_WALLET_ADDRESS, env.TREASURY_OWNER_ADDRESS]
      .find((value) => typeof value === 'string' && value.trim())?.trim() || ''
    const excludedOwnerAddresses = new Set(
      [env.OWNER_WALLET_ADDRESS, env.TREASURY_OWNER_ADDRESS]
        .filter((value) => typeof value === 'string' && ADDRESS_PATTERN.test(value.trim()))
        .map((value) => value.trim()),
    )
    if (!isValidTronAddress(ownerAddress)) {
      return res.status(503).json({
        success: false, error: 'treasury-owner-not-configured',
        availableBaseUnits: '0', sources: [],
        canSubmitSponsoredTransfer: false, submissionEnabled: false,
      })
    }

    const sessionIdentity = validOwnerSessionToken(req)
    if (!sessionIdentity) {
      return res.status(401).json({
        success: false, error: 'owner-session-required',
        availableBaseUnits: '0', sources: [],
        canSubmitSponsoredTransfer: false, submissionEnabled: false,
      })
    }

    let lookup
    try {
      lookup = await getSession({ ...sessionIdentity, nowMs: now() })
    } catch {
      lookup = null
    }
    const session = lookup?.session
    if (lookup?.success !== true) {
      return res.status(503).json({
        success: false, error: 'owner-session-storage-unavailable',
        availableBaseUnits: '0', sources: [],
        canSubmitSponsoredTransfer: false, submissionEnabled: false,
      })
    }
    if (!session || session.network !== 'mainnet' || session.origin !== sessionIdentity.origin) {
      return res.status(401).json({
        success: false, error: 'owner-session-invalid-or-expired',
        availableBaseUnits: '0', sources: [],
        canSubmitSponsoredTransfer: false, submissionEnabled: false,
      })
    }
    if (session.address !== ownerAddress) {
      return res.status(403).json({
        success: false, error: 'owner-wallet-not-authorized',
        availableBaseUnits: '0', sources: [],
        canSubmitSponsoredTransfer: false, submissionEnabled: false,
      })
    }

    try {
      const ledger = await listBudgets({ network: 'mainnet', limit: 100 })
      if (ledger?.success !== true) {
        return res.status(503).json({
          success: false, error: 'sponsor-budget-ledger-unavailable',
          availableBaseUnits: '0', sources: [],
          canSubmitSponsoredTransfer: false, submissionEnabled: false,
        })
      }
      if (!Array.isArray(ledger.budgets) || ledger.budgets.length >= 100) {
        return res.status(503).json({
          success: false, error: 'sponsor-budget-ledger-truncated',
          availableBaseUnits: '0', sources: [],
          canSubmitSponsoredTransfer: false, submissionEnabled: false,
        })
      }

      const matchingBudgets = ledger.budgets
        .filter((budget) => budget.network === 'mainnet'
          && budget.purpose === 'asset-grant'
          && budget.asset === 'USDT'
          && budget.token_contract === OFFICIAL_MAINNET_USDT
          && typeof budget.sponsor_address === 'string'
          && ADDRESS_PATTERN.test(budget.sponsor_address)
          && !excludedOwnerAddresses.has(budget.sponsor_address))
        .map((budget) => ({
          ...budget,
          approvalScopeVerified: budget.status === 'active'
            && typeof budget.review_reference === 'string'
            && budget.review_reference.trim().length > 0
            && budget.approved_at != null
            && isApprovedScope({ consentReference: budget.approval_reference, budget }),
        }))

      const addresses = [...new Set(matchingBudgets.map((budget) => budget.sponsor_address))]
      if (addresses.length > MAX_SOURCES) {
        return res.status(503).json({
          success: false, error: 'sponsor-source-limit-exceeded',
          availableBaseUnits: '0', sourceCount: addresses.length,
          sources: [], canSubmitSponsoredTransfer: false, submissionEnabled: false,
        })
      }

      const sources = []
      // Bound concurrent provider reads to avoid a burst against the existing Tatum plan.
      for (let offset = 0; offset < addresses.length; offset += 4) {
        const batch = addresses.slice(offset, offset + 4)
        const rows = await Promise.all(batch.map(async (address) => {
          const sourceBudgets = matchingBudgets.filter((budget) => budget.sponsor_address === address)
          let funding
          try {
            funding = readFunding
              ? await readFunding(address)
              : await defaultReadFunding(address)
          } catch {
            funding = null
          }
          const snapshotValid = funding?.status === 'solidified-sponsor-balances-read'
            && funding.onChainBalanceRead === true
            && funding.network === 'mainnet'
            && funding.sponsorAddress === address
            && typeof funding.checkedAt === 'string'
            && funding.source === 'Tatum TRON SolidityNode account and constant-contract queries'
          const token = Array.isArray(funding?.tokens)
            ? funding.tokens.find((item) => item?.asset === 'USDT'
              && item?.tokenContract === OFFICIAL_MAINNET_USDT
              && item?.status === 'verified'
              && item?.decimals === 6
              && typeof item?.balanceBaseUnits === 'string'
              && /^(0|[1-9][0-9]*)$/.test(item.balanceBaseUnits))
            : null
          if (!snapshotValid || !token) {
            return {
              address,
              status: 'balance-unavailable',
              onChainBalanceVerified: false,
              onChainBalanceBaseUnits: null,
              availableBaseUnits: '0',
              approvedBudgetCount: sourceBudgets.filter((item) => item.approvalScopeVerified).length,
              budgetCount: sourceBudgets.length,
              checkedAt: funding?.checkedAt || null,
              reconciliationStatus: 'balance-unavailable',
            }
          }

          let reconciliation
          let activeAvailable
          try {
            reconciliation = reconcileSponsorBudgets({
              network: 'mainnet',
              fundingSnapshot: funding,
              budgets: sourceBudgets,
            })
            activeAvailable = sumActiveApprovedCapacity(sourceBudgets)
          } catch {
            reconciliation = { success: false, status: 'invalid-budget-ledger-record', groups: [] }
            activeAvailable = 0n
          }
          const usdtGroup = reconciliation.groups?.find((group) =>
            group.asset === 'USDT' && group.tokenContract === OFFICIAL_MAINNET_USDT)
          const covered = reconciliation.success === true
            && reconciliation.covered === true
            && usdtGroup?.status === 'covered'
            && sourceBudgets.some((budget) => budget.status === 'active' && budget.approvalScopeVerified === true)
          return {
            address,
            status: covered ? (activeAvailable > 0n ? 'verified-allowlisted-capacity' : 'no-unreserved-capacity')
              : reconciliation.status || 'sponsor-budget-not-covered',
            onChainBalanceVerified: true,
            onChainBalanceBaseUnits: token.balanceBaseUnits,
            availableBaseUnits: covered ? activeAvailable.toString() : '0',
            approvedBudgetCount: sourceBudgets.filter((item) => item.status === 'active' && item.approvalScopeVerified).length,
            budgetCount: sourceBudgets.length,
            committedBaseUnits: usdtGroup?.committedBaseUnits ?? '0',
            unreservedLedgerBaseUnits: usdtGroup?.unreservedLedgerBaseUnits ?? '0',
            checkedAt: funding.checkedAt,
            reconciliationStatus: reconciliation.status || 'unavailable',
          }
        }))
        sources.push(...rows)
      }

      const totalAvailable = sources.reduce((sum, source) => sum + BigInt(source.availableBaseUnits || '0'), 0n)
      const totalOnChain = sources.reduce((sum, source) => sum
        + (source.onChainBalanceVerified && source.onChainBalanceBaseUnits ? BigInt(source.onChainBalanceBaseUnits) : 0n), 0n)
      const verifiedSources = sources.filter((source) => source.onChainBalanceVerified).length
      const eligibleSources = sources.filter((source) => source.status === 'verified-allowlisted-capacity').length
      return res.status(200).json({
        success: true,
        status: sources.length === 0 ? 'no-approved-sponsor-sources'
          : totalAvailable > 0n ? 'verified-sponsor-capacity-available'
            : 'sponsor-sources-verified-no-available-capacity',
        network: 'mainnet',
        tokenContract: OFFICIAL_MAINNET_USDT,
        decimals: 6,
        checkedAt: new Date(now()).toISOString(),
        sourceCount: sources.length,
        verifiedSourceCount: verifiedSources,
        eligibleSourceCount: eligibleSources,
        onChainBalanceBaseUnits: totalOnChain.toString(),
        availableBaseUnits: totalAvailable.toString(),
        sources,
        ownerWalletExcluded: true,
        approvalBasis: 'operator-configured-exact-sponsor-agreement-scope-allowlist',
        organizationAuthorizationIndependentlyVerified: false,
        signerAuthorizationVerified: false,
        canSubmitSponsoredTransfer: false,
        submissionEnabled: false,
        limitations: [
          'Only non-owner sponsor addresses with exact-scope-approved active Mainnet official-USDT asset-grant budgets are counted as available capacity.',
          'Each source must have a fresh solidified on-chain balance covering all matching budget commitments; otherwise its available capacity is zero.',
          'Raw on-chain sponsor balance and approved unreserved budget capacity are reported separately.',
          'This is read-only funding aggregation. It does not prove that an authorized signer is available or enable withdrawal submission.',
          'A Mainnet transfer and an exchange credit are separate events; exchange credit must be verified with the receiving service.',
        ],
      })
    } catch {
      return res.status(503).json({
        success: false, error: 'sponsor-liquidity-aggregation-unavailable',
        availableBaseUnits: '0', sources: [],
        canSubmitSponsoredTransfer: false, submissionEnabled: false,
      })
    }
  })

  return router
}

export default createOwnerSponsorLiquidityRouter
