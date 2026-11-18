import { Router } from 'express'
import { createTenergyPromoClient } from '../providers/tenergy-promo.mjs'

const ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/

export function createTenergyPromoRouter({ env = process.env, promo = createTenergyPromoClient() } = {}) {
  const router = Router()

  function ownerAddress(req, res) {
    res.setHeader('Cache-Control', 'no-store, private')
    res.setHeader('Pragma', 'no-cache')
    const configured = typeof env.OWNER_WALLET_ADDRESS === 'string' ? env.OWNER_WALLET_ADDRESS.trim() : ''
    const requested = req.body?.address ?? req.query?.address
    if (!ADDRESS.test(configured)) {
      res.status(503).json({ success: false, status: 'owner-wallet-not-configured' })
      return null
    }
    if (requested !== configured) {
      res.status(403).json({ success: false, status: 'owner-wallet-mismatch' })
      return null
    }
    return configured
  }

  router.get('/resource-promo/terms', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const result = await promo.getPromo()
    return res.status(result.success ? 200 : 503).json(result)
  })

  router.get('/resource-promo/status', async (req, res) => {
    const address = ownerAddress(req, res)
    if (!address) return
    const result = await promo.getRedemption(address)
    return res.status(result.success ? 200 : 503).json(result)
  })

  router.post('/resource-promo/challenge', async (req, res) => {
    const address = ownerAddress(req, res)
    if (!address) return
    const result = await promo.createChallenge(address)
    const status = result.success ? 201
      : result.status === 'invalid-address' ? 400
        : result.status === 'promo-not-eligible' || result.status === 'promo-already-redeemed' ? 409
          : 503
    return res.status(status).json(result)
  })

  router.post('/resource-promo/redeem', async (req, res) => {
    const address = ownerAddress(req, res)
    if (!address) return
    const result = await promo.redeem({
      address,
      nonce: req.body?.nonce,
      signature: req.body?.signature,
    })
    const status = result.success ? 200
      : result.status === 'invalid-redemption-request' ? 400
        : result.status === 'promo-not-eligible' || result.status === 'promo-already-redeemed' ? 409
          : 503
    return res.status(status).json(result)
  })

  return router
}

export default createTenergyPromoRouter()
