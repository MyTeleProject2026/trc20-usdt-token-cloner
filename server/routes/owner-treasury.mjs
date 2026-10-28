import { createHash } from 'node:crypto'
import { Router } from 'express'
import { getWalletAuthSession } from '../database.mjs'
import { createSponsorFundingReader } from '../sponsor-funding.mjs'
import { isValidTronAddress } from '../tron-address.mjs'

const OFFICIAL_MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function header(req, name) {
  const value = typeof req.get === 'function' ? req.get(name) : req.headers?.[name.toLowerCase()]
  return typeof value === 'string' ? value : ''
}

/**
 * Resolve the public address to monitor. TREASURY_MAINNET_ADDRESS is the
 * explicit watch-only target; the legacy sponsor address remains compatible.
 * The owner identity address is the final fallback for one-wallet deployments.
 */
export function resolveOwnerTreasuryFundingAddress(env = process.env) {
  for (const name of ['TREASURY_MAINNET_ADDRESS', 'SPONSOR_MAINNET_ADDRESS', 'TREASURY_OWNER_ADDRESS']) {
    const value = typeof env[name] === 'string' ? env[name].trim() : ''
    if (value) return value
  }
  return ''
}

/**
 * Owner-only, read-only treasury status. A valid Mainnet wallet signature proves
 * owner identity; it does not grant permission to spend. This route never mints,
 * signs, broadcasts, or claims an exchange credited a deposit.
 */
export function createOwnerTreasuryRouter({
  env = process.env,
  getSession = getWalletAuthSession,
  readFunding = null,
  isValidAddress = isValidTronAddress,
  now = () => Date.now(),
} = {}) {
  const router = Router()
  const fundingAddress = resolveOwnerTreasuryFundingAddress(env)
  const fundingEnv = { ...env, SPONSOR_MAINNET_ADDRESS: fundingAddress }
  const readFundingStatus = readFunding || createSponsorFundingReader({ env: fundingEnv })

  router.get('/funding-status', async (req, res) => {
    res.setHeader?.('Cache-Control', 'no-store, private')
    res.setHeader?.('Pragma', 'no-cache')
    res.setHeader?.('Vary', 'Authorization, Origin')

    if (req.query?.network !== 'mainnet') {
      return res.status(400).json({
        success: false,
        error: 'mainnet-required',
        message: 'Owner treasury status is available only for TRON Mainnet.',
        canSubmitSponsoredTransfer: false,
        submissionEnabled: false,
      })
    }

    const ownerAddress = typeof env.TREASURY_OWNER_ADDRESS === 'string'
      ? env.TREASURY_OWNER_ADDRESS.trim() : ''
    if (!ownerAddress || !isValidAddress(ownerAddress)) {
      return res.status(503).json({
        success: false,
        error: 'treasury-owner-not-configured',
        requiredEnvironment: ['TREASURY_OWNER_ADDRESS'],
        canSubmitSponsoredTransfer: false,
        submissionEnabled: false,
      })
    }
    // Fail closed before making a provider request if the configured watch
    // address is missing or malformed. A UI must never treat an arbitrary
    // provider-returned address as the configured treasury.
    if (!fundingAddress || !isValidAddress(fundingAddress)) {
      return res.status(503).json({
        success: false,
        error: 'treasury-funding-address-invalid',
        requiredEnvironment: ['TREASURY_MAINNET_ADDRESS', 'SPONSOR_MAINNET_ADDRESS', 'TREASURY_OWNER_ADDRESS'],
        canSubmitSponsoredTransfer: false,
        submissionEnabled: false,
      })
    }

    const authorization = header(req, 'authorization')
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization)
    const origin = header(req, 'origin')
    if (!match || !origin) {
      return res.status(401).json({
        success: false,
        error: 'owner-session-required',
        canSubmitSponsoredTransfer: false,
        submissionEnabled: false,
      })
    }

    let lookup
    try {
      lookup = await getSession({ tokenHash: digest(match[1]), origin, nowMs: now() })
    } catch {
      lookup = null
    }
    if (lookup?.success !== true) {
      return res.status(503).json({
        success: false,
        error: 'owner-session-storage-unavailable',
        canSubmitSponsoredTransfer: false,
        submissionEnabled: false,
      })
    }
    const session = lookup.session
    if (!session || session.network !== 'mainnet' || session.origin !== origin) {
      return res.status(401).json({
        success: false,
        error: 'owner-session-invalid-or-expired',
        canSubmitSponsoredTransfer: false,
        submissionEnabled: false,
      })
    }
    if (session.address !== ownerAddress) {
      return res.status(403).json({
        success: false,
        error: 'owner-wallet-not-authorized',
        message: 'Sign in with the wallet configured as TREASURY_OWNER_ADDRESS.',
        canSubmitSponsoredTransfer: false,
        submissionEnabled: false,
      })
    }

    let funding
    try {
      funding = await readFundingStatus('mainnet')
    } catch {
      funding = null
    }
    if (funding?.onChainBalanceRead !== true) {
      return res.status(503).json({
        success: false,
        error: 'treasury-balance-unavailable',
        message: 'A verified on-chain treasury balance is unavailable. No transfer was attempted.',
        canSubmitSponsoredTransfer: false,
        submissionEnabled: false,
      })
    }
    // The balance response must be from the exact configured Mainnet address.
    // This prevents a stale, misconfigured, or incorrect provider result from
    // being presented to the owner as funds available for a treasury payout.
    if (funding.network !== 'mainnet' || funding.sponsorAddress !== fundingAddress) {
      return res.status(503).json({
        success: false,
        error: 'treasury-funding-address-mismatch',
        message: 'The verified balance response did not match the configured Mainnet treasury address. No payout is authorized.',
        canSubmitSponsoredTransfer: false,
        submissionEnabled: false,
      })
    }

    const token = Array.isArray(funding.tokens)
      ? funding.tokens.find((item) => item?.asset === 'USDT' && item?.tokenContract === OFFICIAL_MAINNET_USDT)
      : null
    const tokenBalanceVerified = token?.status === 'verified'
      && token?.decimals === 6
      && typeof token?.balanceBaseUnits === 'string'
      && /^(0|[1-9][0-9]*)$/.test(token.balanceBaseUnits)
    const officialUsdt = tokenBalanceVerified
      ? {
          status: 'verified',
          tokenContract: OFFICIAL_MAINNET_USDT,
          balanceBaseUnits: token.balanceBaseUnits,
          decimals: 6,
        }
      : { status: 'unavailable', tokenContract: OFFICIAL_MAINNET_USDT }

    return res.status(200).json({
      success: true,
      ownerAccessVerified: true,
      status: 'on-chain-funding-read',
      network: 'mainnet',
      checkedAt: typeof funding.checkedAt === 'string' ? funding.checkedAt : new Date(now()).toISOString(),
      treasuryAddress: funding.sponsorAddress,
      onChainBalanceRead: true,
      native: funding.native?.status === 'verified'
        ? { status: 'verified', asset: 'TRX', balanceTRX: funding.native.balanceTRX }
        : { status: 'unavailable', asset: 'TRX' },
      officialUsdt,
      canSubmitSponsoredTransfer: false,
      submissionEnabled: false,
      limitations: [
        'This is a read-only snapshot of actual on-chain balances at the configured treasury address.',
        'It does not create USDT, authorize spending, sign a transaction, or submit a payout.',
        'A real payout requires actual USDT in the treasury and a separately reviewed, securely authorized signer workflow.',
        'An on-chain transfer does not guarantee that an external exchange credits a deposit.',
      ],
    })
  })

  return router
}

export default createOwnerTreasuryRouter
