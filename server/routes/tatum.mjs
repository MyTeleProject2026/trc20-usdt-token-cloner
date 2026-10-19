import { Router } from 'express'
import { tatumApiBase, tatumFetch, MissingApiKeyError } from '../tatum-client.mjs'

const router = Router()
const addressPattern = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const txPattern = /^[0-9a-fA-F]{64}$/

router.get('/status', async (_req, res) => {
  if (!process.env.TATUM_API_KEY) return res.json({ status: 'no-api-key' })
  try {
    const response = await fetch(tatumApiBase(), { signal: AbortSignal.timeout(8000), headers: { 'x-api-key': process.env.TATUM_API_KEY } })
    res.json({ status: response.ok ? 'connected' : 'provider-response', providerStatus: response.status })
  } catch {
    res.json({ status: 'egress-failed' })
  }
})


// Read-only sponsor status. This endpoint deliberately cannot initiate transfers.
// It stays disabled until a real provider adapter, sponsor funding, and testnet
// verification have been implemented and reviewed.
router.get('/tron/sponsorship/status', async (_req, res) => {
  const { getSponsorshipStatus } = await import('../sponsorship-status.mjs')
  res.json({ success: true, sponsorship: getSponsorshipStatus() })
})

router.get('/tron/info', async (_req, res) => {
  try {
    const data = await tatumFetch('/v3/tron/info')
    res.json({ success: true, data })
  } catch (err) {
    if (err instanceof MissingApiKeyError) return res.status(503).json({ success: false, error: 'missing-api-key', message: 'Set TATUM_API_KEY in Render environment variables.' })
    res.status(502).json({ success: false, error: 'provider-request-failed', message: err.message })
  }
})

router.get('/tron/account/:address', async (req, res) => {
  const address = req.params.address
  if (!addressPattern.test(address)) return res.status(400).json({ success: false, error: 'invalid-address', message: 'Use a valid TRON Base58 address.' })
  try {
    const data = await tatumFetch(`/v3/tron/account/${encodeURIComponent(address)}`)
    res.json({ success: true, data })
  } catch (err) {
    if (err instanceof MissingApiKeyError) return res.status(503).json({ success: false, error: 'missing-api-key', message: 'Set TATUM_API_KEY in Render environment variables.' })
    res.status(502).json({ success: false, error: 'provider-request-failed', message: err.message })
  }
})

router.get('/tron/contract-by-tx/:hash', async (req, res) => {
  const hash = req.params.hash
  if (!txPattern.test(hash)) return res.status(400).json({ success: false, error: 'invalid-transaction-id', message: 'Transaction ID must be 64 hexadecimal characters.' })
  try {
    const data = await tatumFetch(`/v3/blockchain/sc/address/TRON/${encodeURIComponent(hash)}`)
    res.json({ success: true, data })
  } catch (err) {
    if (err instanceof MissingApiKeyError) return res.status(503).json({ success: false, error: 'missing-api-key', message: 'Set TATUM_API_KEY in Render environment variables.' })
    res.status(502).json({ success: false, error: 'provider-request-failed', message: err.message })
  }
})

// Contract deployment is performed by the user's local wallet in the frontend.
// The server intentionally never accepts or stores a wallet private key.
router.post('/tron/deploy', (req, res) => {
  const { name, symbol, decimals, totalSupply, recipient } = req.body || {}
  if (/tether/i.test(String(name || '')) || String(symbol || '').trim().toUpperCase() === 'USDT') {
    return res.status(400).json({ success: false, error: 'reserved-token-identity', message: 'Use a distinct token identity. This app deploys an independent TRC-20 asset, not official Tether USDT.' })
  }
  if (Number(decimals) !== 18 || !Number.isSafeInteger(Number(totalSupply)) || Number(totalSupply) <= 0 || !addressPattern.test(String(recipient || ''))) {
    return res.status(400).json({ success: false, error: 'invalid-token-parameters', message: 'Provide a positive whole-token supply, an 18-decimal configuration, and a valid TRON recipient address.' })
  }
  return res.status(409).json({ success: false, error: 'local-wallet-signing-required', message: 'Token deployment is signed directly in the browser. Do not submit wallet private keys to the API.' })
})

// The browser signs transfers locally and broadcasts directly to the selected TRON node.
router.post('/tron/transfer', (_req, res) => res.status(409).json({
  success: false,
  error: 'local-wallet-signing-required',
  message: 'Transfers must be signed locally by the token owner. This API never accepts private keys or signs transactions for users.',
}))

export default router
