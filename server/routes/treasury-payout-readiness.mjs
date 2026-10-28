import { timingSafeEqual } from 'node:crypto'
import { Router } from 'express'

const OFFICIAL_MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/

function authorized(req, env) {
  const expected = env.TREASURY_ADMIN_API_TOKEN
  const header = req.headers?.authorization
  if (typeof expected !== 'string' || expected.length < 32
    || typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const suppliedBytes = Buffer.from(header.slice(7))
  const expectedBytes = Buffer.from(expected)
  return suppliedBytes.length === expectedBytes.length
    && timingSafeEqual(suppliedBytes, expectedBytes)
}

function decimalUnits(value, decimals) {
  let raw
  try {
    raw = BigInt(String(value))
  } catch {
    return null
  }
  if (raw < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null
  const scale = 10n ** BigInt(decimals)
  const whole = raw / scale
  const fraction = (raw % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  return fraction ? whole.toString() + '.' + fraction : whole.toString()
}

/**
 * Read-only owner diagnostic for a treasury-backed payout design.
 * It never creates balances, signs/broadcasts transfers, or enables withdrawals.
 * A real payout requires funded assets plus a separately approved signer adapter.
 */
export function createTreasuryPayoutReadinessRouter({
  env = process.env,
  tronWebFactory = async (apiKey) => {
    const { TronWeb } = await import('tronweb')
    const headers = apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {}
    return new TronWeb({ fullHost: 'https://api.trongrid.io', headers })
  },
} = {}) {
  const router = Router()

  router.get('/treasury/payout-readiness', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Vary', 'Authorization')

    if (!authorized(req, env)) {
      return res.status(401).json({ success: false, error: 'unauthorized' })
    }

    const address = typeof env.TREASURY_MAINNET_ADDRESS === 'string'
      ? env.TREASURY_MAINNET_ADDRESS.trim() : ''
    if (!ADDRESS_PATTERN.test(address)) {
      return res.status(200).json({
        success: true,
        status: 'treasury-address-not-configured',
        network: 'mainnet',
        configured: false,
        fundingVerified: false,
        transferSubmissionEnabled: false,
        requiredEnvironment: ['TREASURY_MAINNET_ADDRESS', 'TREASURY_ADMIN_API_TOKEN'],
        limitations: ['No funds are created by this service.', 'Treasury payout signing and broadcasting are not integrated by this read-only endpoint.'],
      })
    }

    try {
      const tronWeb = await tronWebFactory(env.TRONGRID_API_KEY)
      if (!tronWeb?.isAddress?.(address) || typeof tronWeb?.trx?.getBalance !== 'function'
        || typeof tronWeb?.contract !== 'function') {
        throw new Error('provider-unavailable')
      }
      const [balanceSun, tokenContract] = await Promise.all([
        tronWeb.trx.getBalance(address),
        tronWeb.contract([
          { constant: true, inputs: [{ name: 'owner', type: 'address' }], name: 'balanceOf', outputs: [{ name: 'balance', type: 'uint256' }], stateMutability: 'view', type: 'function' },
        ], OFFICIAL_MAINNET_USDT),
      ])
      const usdtBaseUnits = await tokenContract.balanceOf(address).call()
      const trx = decimalUnits(balanceSun, 6)
      const usdt = decimalUnits(usdtBaseUnits, 6)
      if (trx === null || usdt === null) throw new Error('invalid-provider-response')
      const hasUsdt = BigInt(String(usdtBaseUnits)) > 0n
      const hasTrx = BigInt(String(balanceSun)) > 0n
      return res.status(200).json({
        success: true,
        status: hasUsdt ? 'treasury-usdt-balance-verified' : 'treasury-usdt-balance-zero',
        network: 'mainnet',
        configured: true,
        treasuryAddress: address,
        tokenContract: OFFICIAL_MAINNET_USDT,
        token: { symbol: 'USDT', decimals: 6, balanceBaseUnits: String(usdtBaseUnits), balance: usdt },
        native: { symbol: 'TRX', decimals: 6, balanceSun: String(balanceSun), balance: trx },
        fundingVerified: true,
        transferSubmissionEnabled: false,
        limitations: [
          'This endpoint reads public-chain balances only; it does not prove ownership of a signing key or authorize spending.',
          'Treasury payouts require a separately secured signer/provider adapter, explicit owner approval, risk limits, and settlement reconciliation.',
          'A zero USDT balance cannot be turned into genuine USDT by a contract compiler or wallet UI.',
          'Exchange deposit credit and spendability are controlled by the receiving exchange.',
        ],
      })
    } catch {
      return res.status(503).json({
        success: false,
        status: 'treasury-chain-read-unavailable',
        network: 'mainnet',
        configured: true,
        fundingVerified: false,
        transferSubmissionEnabled: false,
        message: 'The treasury balance could not be independently verified. No payout was authorized.',
      })
    }
  })

  return router
}

export default createTreasuryPayoutReadinessRouter()
