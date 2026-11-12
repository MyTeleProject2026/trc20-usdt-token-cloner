import { createHash } from 'node:crypto'
import express from 'express'
import { getWalletAuthSession } from '../database.mjs'
import { TronWeb } from 'tronweb'
import { createPublicTronReadClient } from '../public-tron-read-client.mjs'

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function bearerToken(req) {
  const value = req.get('authorization') || ''
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(value)
  return match ? match[1] : ''
}

export function createPublicTronReadRouter({
  env = process.env,
  getSession = getWalletAuthSession,
  now = () => Date.now(),
  publicClient = null,
  ...clientOptions
} = {}) {
  const router = express.Router()
  const client = publicClient || createPublicTronReadClient({
    origin: env.TRONGRID_API_ORIGIN || 'https://api.trongrid.io',
    apiKey: env.TRONGRID_API_KEY || '',
    ...clientOptions,
  })

  const handle = (fn) => async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Vary', 'Authorization, Origin')

    const token = bearerToken(req)
    const origin = req.get('origin') || ''
    const ownerAddress = String(env.TREASURY_OWNER_ADDRESS || env.OWNER_WALLET_ADDRESS || '').trim()
    if (!token || !origin || !ownerAddress || !TronWeb.isAddress(ownerAddress)) {
      return res.status(401).json({ success: false, error: 'owner-session-required' })
    }

    let lookup
    try {
      lookup = await getSession({ tokenHash: digest(token), origin, nowMs: now() })
    } catch {
      lookup = null
    }
    const session = lookup?.session
    if (lookup?.success !== true || !session || session.network !== 'mainnet' || session.origin !== origin) {
      return res.status(401).json({ success: false, error: 'owner-session-invalid-or-expired' })
    }
    if (session.address !== ownerAddress) {
      return res.status(403).json({ success: false, error: 'owner-wallet-not-authorized' })
    }

    try {
      const result = await fn(req)
      return res.json({ success: true, data: result })
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 502
      return res.status(status).json({
        success: false,
        error: status === 400 ? error.message : 'TRON public API read failed',
      })
    }
  }

  router.get('/account/:address', handle((req) => client.getSolidifiedAccount(req.params.address)))
  router.get('/resources/:address', handle((req) => client.getAccountResources(req.params.address)))
  router.get('/transaction/:txid', handle((req) => client.getSolidifiedTransaction(req.params.txid)))
  return router
}

export default createPublicTronReadRouter()
