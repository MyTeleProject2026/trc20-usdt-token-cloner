import { Router } from 'express'
import { createHmac, timingSafeEqual } from 'node:crypto'

const OKX_ORIGIN = 'https://www.okx.com'
const MAX_LIMIT = 100
const CURRENCY = /^[A-Z0-9]{2,20}$/
const TX_ID = /^[A-Za-z0-9:_-]{8,160}$/

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a || ''))
  const right = Buffer.from(String(b || ''))
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right)
}

function signature(secret, timestamp, method, requestPath, body = '') {
  return createHmac('sha256', secret).update(timestamp + method + requestPath + body).digest('base64')
}

function safeDeposit(record) {
  // Only fields returned by OKX are exposed; never infer or synthesize credit.
  return {
    currency: String(record.ccy || ''),
    chain: String(record.chain || ''),
    amount: String(record.amt || ''),
    transactionId: String(record.txId || ''),
    depositAddress: String(record.to || ''),
    memo: String(record.tag || ''),
    statusCode: String(record.state ?? ''),
    status: ({
      '0': 'waiting-confirmation',
      '1': 'credited-not-withdrawable',
      '2': 'successful',
      '8': 'pending-temporary-deposit-suspension',
      '11': 'address-blacklist-match',
      '12': 'account-or-deposit-frozen',
      '13': 'sub-account-deposit-interception',
      '14': 'kyc-limit',
      '17': 'travel-rule-pending',
    })[String(record.state)] || 'exchange-reported-unknown',
    actualDepositBlockchainConfirmed: String(record.actualDepBlkConfirm ?? ''),
    recordedAt: String(record.ts ?? ''),
    source: 'OKX authenticated deposit-history response',
  }
}

export function createOkxDepositStatusRouter({
  env = process.env,
  fetchImpl = fetch,
  now = () => new Date(),
} = {}) {
  const router = Router()

  router.get('/deposit-status', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Vary', 'Authorization')

    const accessToken = env.OKX_STATUS_ACCESS_TOKEN
    const apiKey = env.OKX_API_KEY
    const secret = env.OKX_API_SECRET
    const passphrase = env.OKX_API_PASSPHRASE
    if (![accessToken, apiKey, secret, passphrase].every((value) => typeof value === 'string' && value.length >= 12)) {
      return res.status(503).json({
        success: false,
        status: 'not-configured',
        message: 'OKX read-only status integration is not configured on the server.',
      })
    }

    const supplied = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '')
    if (!constantTimeEqual(supplied, accessToken)) {
      return res.status(401).json({ success: false, error: 'unauthorized' })
    }

    const params = new URLSearchParams()
    const ccy = typeof req.query.ccy === 'string' ? req.query.ccy.trim().toUpperCase() : ''
    const txId = typeof req.query.txId === 'string' ? req.query.txId.trim() : ''
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 100
    const after = typeof req.query.after === 'string' ? req.query.after : ''
    const before = typeof req.query.before === 'string' ? req.query.before : ''
    if (ccy && !CURRENCY.test(ccy)) return res.status(400).json({ success: false, error: 'invalid-currency' })
    if (txId && !TX_ID.test(txId)) return res.status(400).json({ success: false, error: 'invalid-transaction-id' })
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return res.status(400).json({ success: false, error: 'invalid-limit' })
    for (const [name, value] of [['after', after], ['before', before]]) {
      if (value && (!/^\d{13}$/.test(value) || !Number.isFinite(Number(value)))) {
        return res.status(400).json({ success: false, error: 'invalid-' + name })
      }
    }
    if (ccy) params.set('ccy', ccy)
    if (txId) params.set('txId', txId)
    params.set('limit', String(limit))
    if (after) params.set('after', after)
    if (before) params.set('before', before)

    const requestPath = '/api/v5/asset/deposit-history' + (params.size ? '?' + params.toString() : '')
    const timestamp = now().toISOString()
    const headers = {
      'OK-ACCESS-KEY': apiKey,
      'OK-ACCESS-SIGN': signature(secret, timestamp, 'GET', requestPath),
      'OK-ACCESS-TIMESTAMP': timestamp,
      'OK-ACCESS-PASSPHRASE': passphrase,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    }

    try {
      const upstream = await fetchImpl(OKX_ORIGIN + requestPath, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
      })
      const payload = await upstream.json().catch(() => null)
      if (!upstream.ok || !payload || payload.code !== '0' || !Array.isArray(payload.data)) {
        return res.status(502).json({
          success: false,
          status: 'exchange-api-error',
          upstreamStatus: upstream.status,
          upstreamCode: typeof payload?.code === 'string' ? payload.code : 'unavailable',
          message: 'OKX did not return a valid deposit-history response. No credit status was inferred.',
        })
      }
      const deposits = payload.data.map(safeDeposit)
      return res.json({
        success: true,
        exchange: 'OKX',
        status: 'exchange-records-returned',
        count: deposits.length,
        deposits,
        note: 'Statuses reflect OKX API records only. A missing record is not proof of a failed deposit; confirm network, address, memo/tag, and account with OKX support.',
      })
    } catch {
      return res.status(502).json({
        success: false,
        status: 'exchange-unreachable',
        message: 'Could not reach OKX deposit history. No credit status was inferred.',
      })
    }
  })

  return router
}

export default createOkxDepositStatusRouter()
