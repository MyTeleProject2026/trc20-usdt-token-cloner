import { Router } from 'express'
import { tatumApiBase, tatumFetch, MissingApiKeyError } from '../tatum-client.mjs'

const router = Router()

// Health check — a present key says nothing about egress, so make a real request.
router.get('/status', async (_req, res) => {
  if (!process.env.TATUM_API_KEY) return res.json({ status: 'no-api-key' })
  try {
    await fetch(tatumApiBase(), { signal: AbortSignal.timeout(8000) })
    res.json({ status: 'connected' })
  } catch (error) {
    res.json({ status: 'egress-failed', error: error.message })
  }
})

// Current Tron blockchain block info (live connectivity test)
router.get('/tron/info', async (_req, res) => {
  try {
    const data = await tatumFetch('/v3/tron/info')
    res.json({ success: true, data })
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      return res.status(400).json({ success: false, error: 'missing-api-key', message: 'Tatum API Key is not configured' })
    }
    res.status(500).json({ success: false, error: err.message })
  }
})

// Deploy TRC-20 Token to Tron network
router.post('/tron/deploy', async (req, res) => {
  try {
    const { name, symbol, decimals, totalSupply, recipient } = req.body

    // Check for configured Tron signing key
    const signingKey = process.env.TRON_PRIVATE_KEY
    if (!signingKey) {
      return res.status(400).json({
        success: false,
        error: 'missing-signing-key',
        message: 'No TRON_PRIVATE_KEY configured in server environment. Add TRON_PRIVATE_KEY as workspace secret for real on-chain automated broadcasting.',
        preparedPayload: {
          name: name || 'Tether USD',
          symbol: symbol || 'USDT',
          decimals: Number(decimals) || 6,
          totalSupply: Number(totalSupply) || 1000000000,
          recipient: recipient || 'TYMwiDu22V6XG3yk6W9cTVBz48okKLRczh',
          note: 'Payload is validated and ready for signing on Tron'
        }
      })
    }

    const payload = {
      name: name || 'Tether USD',
      symbol: symbol || 'USDT',
      decimals: Number(decimals) || 6,
      totalSupply: Number(totalSupply) || 1000000000,
      recipient: recipient || 'TYMwiDu22V6XG3yk6W9cTVBz48okKLRczh',
      fromPrivateKey: signingKey
    }

    const result = await tatumFetch('/v3/tron/trc20/deploy', {
      method: 'POST',
      body: JSON.stringify(payload)
    })

    res.json({ success: true, result })
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      return res.status(400).json({ success: false, error: 'missing-api-key', message: 'Tatum API Key is not configured' })
    }
    res.status(500).json({ success: false, error: err.message })
  }
})

// Get TRON Account details and TRC-20 balances
router.get('/tron/account/:address', async (req, res) => {
  try {
    const { address } = req.params
    const data = await tatumFetch(`/v3/tron/account/${encodeURIComponent(address)}`)
    res.json({ success: true, data })
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      return res.status(400).json({ success: false, error: 'missing-api-key', message: 'Tatum API Key is not configured' })
    }
    res.status(500).json({ success: false, error: err.message })
  }
})

// Verify Smart Contract deployment address by transaction hash
router.get('/tron/contract-by-tx/:hash', async (req, res) => {
  try {
    const { hash } = req.params
    const data = await tatumFetch(`/v3/blockchain/sc/address/TRON/${encodeURIComponent(hash)}`)
    res.json({ success: true, data })
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      return res.status(400).json({ success: false, error: 'missing-api-key', message: 'Tatum API Key is not configured' })
    }
    res.status(500).json({ success: false, error: err.message })
  }
})

// Transfer TRC-20 Tokens
router.post('/tron/transfer', async (req, res) => {
  try {
    const { tokenAddress, to, amount, feeLimit } = req.body

    const signingKey = process.env.TRON_PRIVATE_KEY
    if (!signingKey) {
      return res.status(400).json({
        success: false,
        error: 'missing-signing-key',
        message: 'No TRON_PRIVATE_KEY configured in server environment. Add TRON_PRIVATE_KEY as workspace secret to broadcast real TRC-20 transfers.',
        preparedPayload: {
          tokenAddress,
          to,
          amount: String(amount),
          feeLimit: Number(feeLimit) || 10
        }
      })
    }

    const payload = {
      fromPrivateKey: signingKey,
      tokenAddress,
      to,
      amount: String(amount),
      feeLimit: Number(feeLimit) || 10
    }

    const result = await tatumFetch('/v3/tron/trc20/transaction', {
      method: 'POST',
      body: JSON.stringify(payload)
    })

    res.json({ success: true, result })
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      return res.status(400).json({ success: false, error: 'missing-api-key', message: 'Tatum API Key is not configured' })
    }
    res.status(500).json({ success: false, error: err.message })
  }
})

export default router
