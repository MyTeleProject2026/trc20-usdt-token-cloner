import { Router } from 'express'
import { getTronMetaRelayerReadiness } from '../tron-meta-relayer-readiness.mjs'

export function createTronMetaRelayerRouter({ env = process.env } = {}) {
  const router = Router()

  router.get('/status', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    return res.json({ success: true, relayer: getTronMetaRelayerReadiness(env) })
  })

  // Intentionally hard-disabled. No environment flag can enable this route.
  // A future implementation must add reviewed meta-aware recipient contracts,
  // a verified forwarder, owner-signature verification, replay protection,
  // sponsor-budget controls, and an isolated signer before this endpoint changes.
  router.post('/submit', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    return res.status(503).json({
      success: false,
      status: 'relayer-submission-disabled',
      submissionEnabled: false,
      transactionBroadcastingAvailable: false,
      message: 'The TRON meta-relayer is in read-only readiness mode. No transaction was signed or broadcast.',
    })
  })

  return router
}

export default createTronMetaRelayerRouter()
