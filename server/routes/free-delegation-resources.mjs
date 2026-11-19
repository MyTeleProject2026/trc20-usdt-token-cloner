import { Router } from 'express'
import { createFreeDelegationResourceReader } from '../free-delegation-resources.mjs'

export function createFreeDelegationResourcesRouter(options = {}) {
  const router = Router()
  const readStatus = options.readStatus ?? createFreeDelegationResourceReader(options)
  const allowedAddress = options.allowedAddress ?? 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'

  router.get('/resources/free-delegation/status', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    const address = typeof req.query?.address === 'string' ? req.query.address : ''
    if (address !== allowedAddress) {
      return res.status(403).json({
        success: false,
        error: 'wallet-not-allowed',
        message: 'This free-delegation policy is restricted to the configured TRON Mainnet owner wallet.',
      })
    }
    const refresh = req.query?.refresh
    if (refresh !== undefined && refresh !== '0' && refresh !== '1') {
      return res.status(400).json({ success: false, error: 'invalid-refresh' })
    }
    const result = await readStatus(address, { refresh: refresh === '1' })
    return res.status(result.success ? 200 : 503).json(result)
  })
  return router
}

export default createFreeDelegationResourcesRouter()
