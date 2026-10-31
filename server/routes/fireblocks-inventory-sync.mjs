import { timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import { TronWeb } from 'tronweb'
import { createFireblocksClient, fireblocksConfiguration } from '../fireblocks-client.mjs'
import { persistFireblocksInventorySnapshot } from '../database.mjs'

const USDT_MAINNET = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const MAINNET_RPC = 'https://api.trongrid.io'
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/

export function matchesFireblocksInventoryBearer(authHeader, expectedToken) {
  if (typeof authHeader !== 'string' || typeof expectedToken !== 'string' || expectedToken.length < 32) return false
  const match = /^Bearer ([A-Za-z0-9._~-]{32,512})$/.exec(authHeader)
  if (!match) return false
  const actual = Buffer.from(match[1], 'utf8')
  const expected = Buffer.from(expectedToken, 'utf8')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function createFireblocksInventorySyncRouter({ env = process.env } = {}) {
  const router = Router()
  router.post('/fireblocks/inventory-sync', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const token = env.FIREBLOCKS_SYNC_TRIGGER_TOKEN || ''
    if (!matchesFireblocksInventoryBearer(req.get('authorization'), token)) {
      return res.status(401).json({ success: false, error: 'inventory-sync-unauthorized' })
    }
    return res.status(503).json({ success: false, error: 'inventory-sync-not-configured' })
  })
  return router
}

export default createFireblocksInventorySyncRouter
