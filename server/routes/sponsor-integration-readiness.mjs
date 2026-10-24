import { Router } from 'express'
import { getSponsorIntegrationReadiness } from '../sponsor-integration-readiness.mjs'

export { getSponsorIntegrationReadiness } from '../sponsor-integration-readiness.mjs'

export function createSponsorIntegrationReadinessRouter(options) {
  const router = Router()
  router.get('/sponsorship/integration-readiness', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).json(getSponsorIntegrationReadiness(options))
  })
  return router
}

export default createSponsorIntegrationReadinessRouter()
