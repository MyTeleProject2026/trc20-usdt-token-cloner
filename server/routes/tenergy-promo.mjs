import { Router } from 'express'
import { createTenergyPromoClient } from '../providers/tenergy-promo.mjs'
import { tatumProviderFetch } from '../tatum-provider-fetch.mjs'

const ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/

export function createTenergyPromoRouter({
  env = process.env,
  promo = createTenergyPromoClient(),
  fetchImpl = tatumProviderFetch,
} = {}) {
  const router = Router()

  async function readSolidifiedOwnerResources(address) {
    if (typeof env.TATUM_API_KEY !== 'string' || !env.TATUM_API_KEY.trim()) {
      return { verified: false, status: 'tatum-mainnet-resource-reader-not-configured' }
    }
    try {
      const response = await fetchImpl('https://tron-mainnet.gateway.tatum.io/walletsolidity/getaccountresource', {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json', 'x-api-key': env.TATUM_API_KEY.trim() },
        body: JSON.stringify({ address, visible: true }),
        signal: AbortSignal.timeout(8000),
      })
      if (!response.ok) return { verified: false, status: 'solidified-resource-read-unavailable' }
      const body = await response.json()
      const integer = (value) => value === undefined || value === null ? '0'
        : typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) ? value
          : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : null
      const limit = integer(body?.EnergyLimit)
      const used = integer(body?.EnergyUsed)
      const bandwidthLimit = integer(body?.NetLimit)
      const bandwidthUsed = integer(body?.NetUsed)
      if (limit === null || used === null || bandwidthLimit === null || bandwidthUsed === null
        || BigInt(used) > BigInt(limit) || BigInt(bandwidthUsed) > BigInt(bandwidthLimit)) {
        return { verified: false, status: 'solidified-resource-response-invalid' }
      }
      return {
        verified: true,
        status: 'solidified-owner-resource-snapshot-read',
        source: 'Tatum TRON SolidityNode',
        energyLimit: limit,
        energyUsed: used,
        currentlyAvailableEnergy: (BigInt(limit) - BigInt(used)).toString(),
        bandwidthLimit,
        bandwidthUsed,
        currentlyAvailableBandwidth: (BigInt(bandwidthLimit) - BigInt(bandwidthUsed)).toString(),
        checkedAt: new Date().toISOString(),
        note: 'This is an independent current resource snapshot, not proof that a particular grant caused the full balance.',
      }
    } catch {
      return { verified: false, status: 'solidified-resource-read-unavailable' }
    }
  }

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
    if (result.success && result.status === 'delegated') {
      result.solidifiedOwnerResources = await readSolidifiedOwnerResources(address)
    }
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
