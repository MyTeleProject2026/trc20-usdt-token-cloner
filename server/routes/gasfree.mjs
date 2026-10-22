import { Router } from 'express'
import { createGasFreeClient } from '../gasfree-client.mjs'

export function createGasFreeRouter(client = createGasFreeClient()) {
  const router = Router()

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
      const result = await client.getCapabilities(network)
      if (!result.configured) {
        return res.status(503).json({
          success: false,
          status: 'not-configured',
          ...result,
          message: 'GasFree API access is not configured. Apply for provider API credentials; keep the API secret server-side.',
        })
      }
      if (!result.reachable) {
        return res.status(502).json({
          success: false,
          status: result.reason || 'provider-unreachable',
          ...result,
          message: 'GasFree provider discovery could not be verified. No transfer was submitted.',
        })
      }
      return res.json({ success: true, status: 'provider-capabilities-read', ...result })
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
