import { Router } from 'express'
import { createGasFreeClient } from '../gasfree-client.mjs'

export function createGasFreeRouter(client = createGasFreeClient()) {
  const router = Router()
  const capabilityCache = new Map()
  const cacheTtlMs = 30_000

  // Provider discovery is read-only. This route never signs, submits, or
  // broadcasts any transfer and never returns server-side API credentials.
  router.get('/capabilities', async (req, res) => {
    const network = req.query?.network
    if (typeof network !== 'string' || !['mainnet', 'nile'].includes(network)) {
      return res.status(400).json({
        success: false,
        status: 'invalid-network',
        message: "network must be mainnet or nile. GasFree's documented provider endpoints do not include Shasta.",
      })
    }

    try {
      const cached = capabilityCache.get(network)
      if (cached && cached.expiresAt > Date.now()) {
        return res.status(cached.httpStatus).json(cached.body)
      }

      const result = await client.getCapabilities(network)
      if (!result.configured) {
        const body = {
          success: false,
          status: 'not-configured',
          ...result,
          message: 'GasFree API access is not configured. Apply for provider API credentials; keep the API secret server-side.',
        }
        capabilityCache.set(network, { body, httpStatus: 503, expiresAt: Date.now() + 10_000 })
        return res.status(503).json(body)
      }
      if (!result.reachable) {
        const body = {
          success: false,
          status: result.reason || 'provider-unreachable',
          ...result,
          message: 'GasFree provider discovery could not be verified. No transfer was submitted.',
        }
        capabilityCache.set(network, { body, httpStatus: 502, expiresAt: Date.now() + 5_000 })
        return res.status(502).json(body)
      }
      const body = { success: true, status: 'provider-capabilities-read', checkedAt: new Date().toISOString(), ...result }
      capabilityCache.set(network, { body, httpStatus: 200, expiresAt: Date.now() + cacheTtlMs })
      return res.json(body)
    } catch {
      return res.status(502).json({
        success: false,
        status: 'provider-unreachable',
        network,
        message: 'GasFree provider discovery failed. No transfer was submitted.',
      })
    }
  })

  return router
}

export default createGasFreeRouter()
