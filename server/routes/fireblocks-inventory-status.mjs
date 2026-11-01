import { createHash } from 'node:crypto'
import { Router } from 'express'
import { getWalletAuthSession, getLatestFireblocksInventorySnapshot } from '../database.mjs'
import { isValidTronAddress } from '../tron-address.mjs'

const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const REPOSITORY = 'MyTeleProject2026/trc20-usdt-token-cloner'
const CHECK_NAMES = [
  'fireblocksApiAuthenticated', 'vaultAccountVerified', 'usdtAssetActivated',
  'officialUsdtAssetVerified', 'usdtAddressMatches', 'trxAssetActivated',
  'nativeTrxAssetVerified', 'trxAddressMatches', 'officialUsdtChainVerified',
  'treasuryTrxChainBalanceRead', 'databaseReady',
]
const BALANCE_NAMES = [
  'fireblocksUsdtAvailableBaseUnits', 'chainUsdtBalanceBaseUnits',
  'fireblocksTrxAvailableBaseUnits', 'chainTrxBalanceSun',
]

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function header(req, name) {
  const value = typeof req.get === 'function' ? req.get(name) : req.headers?.[name.toLowerCase()]
  return typeof value === 'string' ? value : ''
}

function sanitizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null
  const configuration = snapshot.configuration && typeof snapshot.configuration === 'object'
    && !Array.isArray(snapshot.configuration) ? snapshot.configuration : {}
  const checks = snapshot.checks && typeof snapshot.checks === 'object'
    && !Array.isArray(snapshot.checks) ? snapshot.checks : {}
  const balances = snapshot.balances && typeof snapshot.balances === 'object'
    && !Array.isArray(snapshot.balances) ? snapshot.balances : {}
  const reasons = Array.isArray(snapshot.reasons)
    ? snapshot.reasons.filter((item) => typeof item === 'string' && /^[a-z0-9-]{1,96}$/.test(item)).slice(0, 30)
    : []
  const checkedAt = snapshot.checkedAt instanceof Date
    ? snapshot.checkedAt.toISOString()
    : typeof snapshot.checkedAt === 'string' && Number.isFinite(Date.parse(snapshot.checkedAt))
      ? new Date(snapshot.checkedAt).toISOString() : null
  const runId = typeof snapshot.workflowRunId === 'string' && /^[0-9]{1,24}$/.test(snapshot.workflowRunId)
    ? snapshot.workflowRunId : null

  return {
    id: typeof snapshot.id === 'string' && /^[0-9]{1,24}$/.test(snapshot.id) ? snapshot.id : null,
    workflowRunId: runId,
    workflowRunAttempt: Number.isSafeInteger(snapshot.workflowRunAttempt) ? snapshot.workflowRunAttempt : null,
    repository: snapshot.repository === REPOSITORY ? REPOSITORY : null,
    branch: snapshot.branch === 'main' ? 'main' : null,
    commitSha: typeof snapshot.commitSha === 'string' && /^[0-9a-f]{40}$/.test(snapshot.commitSha) ? snapshot.commitSha : null,
    verificationStatus: snapshot.verificationStatus === 'verified' ? 'verified'
      : snapshot.verificationStatus === 'blocked' ? 'blocked' : 'unknown',
    checkedAt,
    configuration: {
      apiBase: typeof configuration.apiBase === 'string' ? configuration.apiBase : null,
      vaultAccountId: typeof configuration.vaultAccountId === 'string' ? configuration.vaultAccountId : null,
      usdtAssetId: typeof configuration.usdtAssetId === 'string' ? configuration.usdtAssetId : null,
      trxAssetId: typeof configuration.trxAssetId === 'string' ? configuration.trxAssetId : null,
      treasuryAddress: typeof configuration.treasuryAddress === 'string'
        && ADDRESS_PATTERN.test(configuration.treasuryAddress) ? configuration.treasuryAddress : null,
      signerMode: configuration.signerMode === 'fireblocks' ? 'fireblocks' : null,
      network: configuration.network === 'mainnet' ? 'mainnet' : null,
      usdtContract: configuration.usdtContract === 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
        ? configuration.usdtContract : null,
      usdtDecimals: configuration.usdtDecimals === 6 ? 6 : null,
      trxDecimals: configuration.trxDecimals === 6 ? 6 : null,
      apiKeyConfigured: configuration.apiKeyConfigured === true,
      rsaKeyConfigured: configuration.rsaKeyConfigured === true,
    },
    checks: Object.fromEntries(CHECK_NAMES.map((name) => [
      name, checks[name] === true ? true : checks[name] === false ? false : null,
    ])),
    balances: Object.fromEntries(BALANCE_NAMES.map((name) => {
      const value = balances[name]
      return [name, typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) ? value : null]
    })),
    reasons,
    workflowRunUrl: runId
      ? 'https://github.com/' + REPOSITORY + '/actions/runs/' + encodeURIComponent(runId)
      : null,
  }
}

export function createFireblocksInventoryStatusRouter({
  env = process.env,
  getSession = getWalletAuthSession,
  readLatestSnapshot = getLatestFireblocksInventorySnapshot,
  isValidAddress = isValidTronAddress,
  now = () => Date.now(),
} = {}) {
  const router = Router()

  router.get('/fireblocks/inventory/latest', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Vary', 'Authorization, Origin')

    const ownerAddress = typeof env.OWNER_WALLET_ADDRESS === 'string' ? env.OWNER_WALLET_ADDRESS.trim() : ''
    const treasuryOwnerAddress = typeof env.TREASURY_OWNER_ADDRESS === 'string' ? env.TREASURY_OWNER_ADDRESS.trim() : ''
    if (!ADDRESS_PATTERN.test(ownerAddress) || !ADDRESS_PATTERN.test(treasuryOwnerAddress)
      || !isValidAddress(ownerAddress) || !isValidAddress(treasuryOwnerAddress)
      || ownerAddress !== treasuryOwnerAddress) {
      return res.status(503).json({ success: false, error: 'treasury-owner-configuration-invalid' })
    }

    const authorization = header(req, 'authorization')
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization)
    const origin = header(req, 'origin')
    if (!match || !origin || origin.length > 512) {
      return res.status(401).json({ success: false, error: 'owner-session-required' })
    }

    let lookup
    try {
      lookup = await getSession({ tokenHash: digest(match[1]), origin, nowMs: now() })
    } catch {
      lookup = null
    }
    if (lookup?.success !== true) {
      return res.status(503).json({ success: false, error: 'owner-session-storage-unavailable' })
    }

    const session = lookup.session
    if (!session || session.network !== 'mainnet' || session.origin !== origin) {
      return res.status(401).json({ success: false, error: 'owner-session-invalid-or-expired' })
    }
    if (session.address !== ownerAddress) {
      return res.status(403).json({ success: false, error: 'owner-wallet-not-authorized' })
    }

    let result
    try {
      result = await readLatestSnapshot()
    } catch {
      result = null
    }
    if (result?.success !== true) {
      return res.status(503).json({ success: false, error: 'fireblocks-inventory-status-unavailable' })
    }

    return res.status(200).json({
      success: true,
      snapshot: sanitizeSnapshot(result.snapshot),
      // Inventory evidence is informational; it never grants transfer permission.
      payoutExecutionEnabled: false,
    })
  })

  return router
}

export default createFireblocksInventoryStatusRouter
