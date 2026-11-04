import { Router } from 'express'
import { createHash } from 'node:crypto'
import { tatumProviderFetch } from '../tatum-provider-fetch.mjs'

const NETWORKS = Object.freeze({
  mainnet: 'https://tron-mainnet.gateway.tatum.io',
  nile: 'https://tron-nile.gateway.tatum.io',
  shasta: 'https://tron-shasta.gateway.tatum.io',
})
const ALLOWED_METHODS = new Set([
  'wallet/getaccount',
  'wallet/getaccountresource',
  'wallet/getaccountnet',
  'wallet/getnowblock',
  'wallet/getblockbynum',
  'wallet/getblockbyid',
  'wallet/gettransactionbyid',
  'wallet/gettransactioninfobyid',
  'wallet/getcontract',
  'wallet/getcontractinfo',
  'wallet/getchainparameters',
  'wallet/getdelegatedresource',
  'wallet/getdelegatedresourceaccountindex',
  'wallet/triggerconstantcontract',
  'wallet/estimateenergy',
  'wallet/createtransaction',
  'wallet/triggersmartcontract',
  'wallet/getsignweight',
  'wallet/broadcasttransaction',
  'walletsolidity/getaccount',
  'walletsolidity/getaccountresource',
  'walletsolidity/getnowblock',
  'walletsolidity/getblockbynum',
  'walletsolidity/gettransactionbyid',
  'walletsolidity/gettransactioninfobyid',
  'walletsolidity/getconfirmedtransaction',
  'walletsolidity/triggerconstantcontract',
])
const TX_ID_PATTERN = /^[0-9a-f]{64}$/i
const MAX_BODY_BYTES = 128 * 1024
const MAX_EXPIRY_AHEAD_MS = 10 * 60 * 1000

function validSignedBroadcast(body, now = Date.now()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || !Array.isArray(body.signature) || body.signature.length < 1 || body.signature.length > 5
    || body.signature.some((signature) => typeof signature !== 'string' || !/^[0-9a-f]{130}$/i.test(signature))
    || typeof body.txID !== 'string' || !TX_ID_PATTERN.test(body.txID)
    || typeof body.raw_data_hex !== 'string' || !/^[0-9a-f]+$/i.test(body.raw_data_hex)
    || body.raw_data_hex.length > MAX_BODY_BYTES * 2
    || !body.raw_data || typeof body.raw_data !== 'object'
    || !Number.isSafeInteger(body.raw_data.expiration)
    || body.raw_data.expiration <= now
    || body.raw_data.expiration > now + MAX_EXPIRY_AHEAD_MS) return false
  const calculatedId = createHash('sha256').update(Buffer.from(body.raw_data_hex, 'hex')).digest('hex')
  return calculatedId.toLowerCase() === body.txID.toLowerCase()
}

export function createTatumRpcRouter({
  env = process.env,
  fetchImpl = tatumProviderFetch,
  timeoutMs = 12_000,
  now = () => Date.now(),
  rateLimit = 120,
} = {}) {
  const router = Router()
  const attempts = new Map()

  router.post('/rpc/:network/:group/:method', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    res.setHeader('Pragma', 'no-cache')
    const network = req.params.network
    const path = req.params.group + '/' + req.params.method
    if (!Object.hasOwn(NETWORKS, network) || !ALLOWED_METHODS.has(path)) {
      return res.status(404).json({ success: false, error: 'tatum-rpc-method-not-allowed' })
    }
    const apiKey = typeof env.TATUM_API_KEY === 'string' ? env.TATUM_API_KEY.trim() : ''
    if (!apiKey) return res.status(503).json({ success: false, error: 'tatum-api-key-missing' })
    const clientAddress = typeof req.ip === 'string' ? req.ip : 'unknown'
    const windowStart = Math.floor(now() / 60_000) * 60_000
    const current = attempts.get(clientAddress)
    if (!current || current.windowStart !== windowStart) attempts.set(clientAddress, { windowStart, count: 1 })
    else if (current.count >= rateLimit) return res.status(429).json({ success: false, error: 'tatum-rpc-rate-limit' })
    else current.count += 1

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null
    if (!body || Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) {
      return res.status(400).json({ success: false, error: 'invalid-tatum-rpc-payload' })
    }
    if (path === 'wallet/broadcasttransaction' && !validSignedBroadcast(body, Number(now()))) {
      return res.status(400).json({ success: false, error: 'unsigned-or-invalid-broadcast-transaction' })
    }
    try {
      const response = await fetchImpl(NETWORKS[network] + '/' + path, {
        method: 'POST',
        redirect: 'error',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const raw = await response.text()
      let payload
      try { payload = JSON.parse(raw) } catch {
        return res.status(502).json({ success: false, error: 'invalid-tatum-rpc-response' })
      }
      if (!response.ok) return res.status(502).json({ success: false, error: 'tatum-rpc-provider-error', providerStatus: response.status })
      return res.status(200).json(payload)
    } catch {
      return res.status(502).json({ success: false, error: 'tatum-rpc-unavailable' })
    }
  })
  return router
}
