import express from 'express'
import { createPublicTronReadClient } from '../public-tron-read-client.mjs'

export function createPublicTronReadRouter(options = {}) {
  const router = express.Router()
  const client = createPublicTronReadClient({
    origin: process.env.TRONGRID_API_ORIGIN || 'https://api.trongrid.io',
    apiKey: process.env.TRONGRID_API_KEY || '',
    ...options,
  })
  const handle = (fn) => async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
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
