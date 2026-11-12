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
  router.get('/escrow/:contractAddress/beneficiary/:beneficiaryAddress/count', handle(async (req) => {
    const { contractAddress, beneficiaryAddress } = req.params
    if (!TronWeb.isAddress(contractAddress) || !TronWeb.isAddress(beneficiaryAddress)) {
      const error = new Error('Invalid TRON contract or beneficiary address')
      error.status = 400
      throw error
    }
    const ownerAddress = String(env.TREASURY_OWNER_ADDRESS || env.OWNER_WALLET_ADDRESS || '').trim()
    if (!TronWeb.isAddress(ownerAddress)) {
      const error = new Error('Owner wallet address is not configured')
      error.status = 503
      throw error
    }
    const beneficiaryHex = TronWeb.address.toHex(beneficiaryAddress).replace(/^41/i, '').toLowerCase()
    const parameter = beneficiaryHex.padStart(64, '0')
    const result = await client.triggerSolidifiedConstantContract({
      contractAddress,
      functionSelector: 'getBeneficiaryPositionCount(address)',
      parameter,
      ownerAddress,
    })
    if (!/^[0-9a-f]{64}$/i.test(result.resultHex)) throw new Error('Invalid escrow position count response')
    const count = BigInt('0x' + result.resultHex)
    if (count > 1000n) throw new Error('Escrow position count exceeds the safe UI read limit')
    return { beneficiary: beneficiaryAddress, count: count.toString(), source: result.source }
  }))
  router.get('/escrow/:contractAddress/beneficiary/:beneficiaryAddress/request/:index', handle(async (req) => {
    const { contractAddress, beneficiaryAddress, index: indexText } = req.params
    if (!TronWeb.isAddress(contractAddress) || !TronWeb.isAddress(beneficiaryAddress)
      || !/^(0|[1-9][0-9]*)$/.test(indexText)) {
      const error = new Error('Invalid escrow request lookup parameters')
      error.status = 400
      throw error
    }
    const index = BigInt(indexText)
    if (index > 999n) {
      const error = new Error('Escrow position index exceeds the safe UI read limit')
      error.status = 400
      throw error
    }
    const ownerAddress = String(env.TREASURY_OWNER_ADDRESS || env.OWNER_WALLET_ADDRESS || '').trim()
    if (!TronWeb.isAddress(ownerAddress)) {
      const error = new Error('Owner wallet address is not configured')
      error.status = 503
      throw error
    }
    const beneficiaryHex = TronWeb.address.toHex(beneficiaryAddress).replace(/^41/i, '').toLowerCase()
    const parameter = beneficiaryHex.padStart(64, '0') + index.toString(16).padStart(64, '0')
    const result = await client.triggerSolidifiedConstantContract({
      contractAddress,
      functionSelector: 'getBeneficiaryPositionRequestId(address,uint256)',
      parameter,
      ownerAddress,
    })
    if (!/^[0-9a-f]{64}$/i.test(result.resultHex)) throw new Error('Invalid escrow request ID response')
    return { beneficiary: beneficiaryAddress, index: index.toString(), requestId: '0x' + result.resultHex, source: result.source }
  }))
  router.get('/escrow/:contractAddress/position/:requestId', handle(async (req) => {
    const { contractAddress, requestId } = req.params
    if (!TronWeb.isAddress(contractAddress) || !/^0x[0-9a-f]{64}$/i.test(requestId)) {
      const error = new Error('Invalid escrow position lookup parameters')
      error.status = 400
      throw error
    }
    const ownerAddress = String(env.TREASURY_OWNER_ADDRESS || env.OWNER_WALLET_ADDRESS || '').trim()
    if (!TronWeb.isAddress(ownerAddress)) {
      const error = new Error('Owner wallet address is not configured')
      error.status = 503
      throw error
    }
    const result = await client.triggerSolidifiedConstantContract({
      contractAddress,
      functionSelector: 'getPosition(bytes32)',
      parameter: requestId.slice(2),
      ownerAddress,
    })
    if (!/^[0-9a-f]{256}$/i.test(result.resultHex)) throw new Error('Invalid escrow position response')
    const hex = result.resultHex
    const beneficiary = TronWeb.address.fromHex('41' + hex.slice(24, 64))
    const amountSun = BigInt('0x' + hex.slice(64, 128)).toString()
    const unlockAt = BigInt('0x' + hex.slice(128, 192)).toString()
    const claimed = BigInt('0x' + hex.slice(192, 256)) !== 0n
    return { requestId, beneficiary, amountSun, unlockAt, claimed, source: result.source }
  }))
  return router
}

export default createPublicTronReadRouter()
