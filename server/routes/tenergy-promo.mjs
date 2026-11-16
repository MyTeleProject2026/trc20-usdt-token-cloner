import { Router } from 'express'

const TENERGY_PROMO_API = 'https://api.tenergy.me/v1'
const DEFAULT_OWNER = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const NONCE_RE = /^[A-Za-z0-9._:-]{8,256}$/
const SIGNATURE_RE = /^(?:0x)?[0-9a-f]{130}$/i

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, private')
  res.setHeader('Pragma', 'no-cache')
}

function safeCode(payload) {
  const value = payload?.slug || payload?.code || payload?.error || payload?.Error
  return typeof value === 'string' ? value.slice(0, 80) : 'provider-error'
}

async function providerRequest(path, { method = 'GET', body, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const response = await fetchImpl(TENERGY_PROMO_API + path, {
    method,
    redirect: 'error',
    headers: body === undefined ? { accept: 'application/json' } : {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  let payload = null
  try { payload = await response.json() } catch {}
  return { response, payload }
}

function publicPromo(payload) {
  const state = ['active', 'cap_reached_today', 'not_started', 'ended', 'off'].includes(payload?.state)
    ? payload.state : 'unknown'
  const grant = payload?.grant && payload.grant.resource === 'energy'
    && Number.isSafeInteger(payload.grant.amount) && payload.grant.amount > 0
    ? { resource: 'energy', amount: payload.grant.amount, durationSeconds: Number.isSafeInteger(payload.grant.duration_seconds) ? payload.grant.duration_seconds : null }
    : null
  return {
    network: payload?.network === 'mainnet' ? 'mainnet' : null,
    state,
    startsAt: typeof payload?.starts_at === 'string' ? payload.starts_at : null,
    endsAt: typeof payload?.ends_at === 'string' ? payload.ends_at : null,
    leftToday: Number.isSafeInteger(payload?.left_today) ? payload.left_today : null,
    resetsAt: typeof payload?.resets_at === 'string' ? payload.resets_at : null,
    grant,
    tokenName: typeof payload?.token?.name === 'string' ? payload.token.name : null,
    tokenId: typeof payload?.token?.id === 'string' ? payload.token.id : null,
  }
}

function publicRedemption(payload) {
  if (!payload || !['granting', 'delegated', 'failed'].includes(payload.status)
    || !Number.isSafeInteger(payload.energy) || payload.energy < 0) return null
  return {
    status: payload.status,
    energy: payload.energy,
    method: payload.method === 'signature' ? 'signature' : 'forward',
    redeemedAt: typeof payload.redeemed_at === 'string' ? payload.redeemed_at : null,
    expiresAt: typeof payload.expires_at === 'string' ? payload.expires_at : null,
  }
}

export function createTenergyPromoRouter({
  fetchImpl = fetch,
  allowedAddress = DEFAULT_OWNER,
  timeoutMs = 8000,
  now = Date.now,
} = {}) {
  const router = Router()
  const requestTimes = new Map()

  function allowRequest(address, action) {
    const key = address + ':' + action
    const recent = (requestTimes.get(key) || []).filter((time) => now() - time < 60_000)
    if (recent.length >= 5) return false
    recent.push(now())
    requestTimes.set(key, recent)
    if (requestTimes.size > 100) requestTimes.delete(requestTimes.keys().next().value)
    return true
  }

  function validateAddress(req, res) {
    const address = typeof req.body?.address === 'string'
      ? req.body.address
      : typeof req.query?.address === 'string' ? req.query.address : ''
    if (!ADDRESS_RE.test(address) || address !== allowedAddress) {
      res.status(403).json({ success: false, status: 'wallet-not-allowed', message: 'Only the configured TRON Mainnet owner wallet can use this promotional claim route.' })
      return null
    }
    return address
  }

  async function readPromo() {
    const { response, payload } = await providerRequest('/promo', { fetchImpl, timeoutMs })
    if (!response.ok || !payload || typeof payload !== 'object') {
      const error = new Error('TEnergy promotional availability could not be checked.')
      error.providerStatus = response.status
      throw error
    }
    return publicPromo(payload)
  }

  async function readRedemption(address) {
    const { response, payload } = await providerRequest('/promo/redemptions/' + encodeURIComponent(address), { fetchImpl, timeoutMs })
    if (response.status === 404) return null
    if (!response.ok) {
      const error = new Error('TEnergy promotional redemption status could not be checked.')
      error.providerStatus = response.status
      throw error
    }
    const result = publicRedemption(payload)
    if (!result) throw new Error('TEnergy returned an invalid promotional redemption record.')
    return result
  }

  router.get('/tenergy/promo/status', async (req, res) => {
    noStore(res)
    const address = validateAddress(req, res)
    if (!address) return
    try {
      const [promo, redemption] = await Promise.all([readPromo(), readRedemption(address)])
      return res.json({
        success: true,
        network: 'mainnet',
        provider: 'tenergy',
        checkedAt: new Date(now()).toISOString(),
        promo,
        redemption,
        requiresOwnerMessageSignature: !redemption && promo.state === 'active',
        claimSubmitsNoTransaction: true,
        resourceCoverage: { energy: true, bandwidth: false, contractDeploymentFee: false },
      })
    } catch (error) {
      return res.status(Number.isInteger(error.providerStatus) ? 502 : 503).json({
        success: false,
        status: 'provider-unavailable',
        provider: 'tenergy',
        message: 'The TEnergy promotional service could not be checked. No claim or transaction was submitted.',
      })
    }
  })

  router.post('/tenergy/promo/challenge', async (req, res) => {
    noStore(res)
    const address = validateAddress(req, res)
    if (!address) return
    if (!req.body || Object.keys(req.body).some((key) => key !== 'address')) {
      return res.status(400).json({ success: false, status: 'invalid-request' })
    }
    if (!allowRequest(address, 'challenge')) return res.status(429).json({ success: false, status: 'rate-limited' })
    try {
      const promo = await readPromo()
      if (promo.state !== 'active' || !promo.grant) {
        return res.status(409).json({ success: false, status: 'promo-unavailable', promoState: promo.state, message: 'The one-time Energy promotion is not currently open.' })
      }
      const existing = await readRedemption(address)
      if (existing) {
        return res.status(409).json({ success: false, status: 'promo-already-redeemed', redemption: existing })
      }
      const { response, payload } = await providerRequest('/promo/redeem/challenge', {
        method: 'POST', body: { address }, fetchImpl, timeoutMs,
      })
      if (!response.ok) {
        const code = safeCode(payload)
        const mapped = code === 'promo_not_eligible' ? 'promo-not-eligible'
          : code === 'promo_already_redeemed' ? 'promo-already-redeemed'
          : code === 'promo_redeem_unavailable' ? 'promo-unavailable'
          : response.status === 429 ? 'rate-limited' : 'challenge-rejected'
        return res.status(response.status === 403 ? 403 : response.status === 409 ? 409 : response.status === 429 ? 429 : 502).json({
          success: false, status: mapped, providerCode: code,
          message: mapped === 'promo-not-eligible'
            ? 'This owner address was not included in TEnergy’s original promotional token drop.'
            : mapped === 'promo-unavailable'
              ? 'The TEnergy promotion is not currently available.'
              : 'TEnergy did not issue an eligible claim challenge. No wallet signature was requested.',
        })
      }
      if (payload?.address !== address || typeof payload?.message !== 'string'
        || !payload.message || typeof payload?.nonce !== 'string' || !NONCE_RE.test(payload.nonce)
        || !Number.isFinite(Date.parse(payload.expires_at))) {
        return res.status(502).json({ success: false, status: 'invalid-provider-challenge', message: 'TEnergy returned an incomplete or mismatched claim challenge.' })
      }
      return res.status(200).json({
        success: true,
        status: 'challenge-ready',
        address,
        message: payload.message,
        nonce: payload.nonce,
        expiresAt: payload.expires_at,
        purpose: payload.purpose === 'promo_redeem' ? 'promo_redeem' : null,
        fee: '0',
        transactionRequired: false,
      })
    } catch {
      return res.status(503).json({ success: false, status: 'provider-unavailable', message: 'TEnergy claim eligibility could not be checked. No wallet message or transaction was requested.' })
    }
  })

  router.post('/tenergy/promo/redeem', async (req, res) => {
    noStore(res)
    const address = validateAddress(req, res)
    if (!address) return
    if (!req.body || Object.keys(req.body).some((key) => !['address', 'nonce', 'signature'].includes(key))
      || typeof req.body.nonce !== 'string' || !NONCE_RE.test(req.body.nonce)
      || typeof req.body.signature !== 'string' || !SIGNATURE_RE.test(req.body.signature)) {
      return res.status(400).json({ success: false, status: 'invalid-signed-challenge' })
    }
    if (!allowRequest(address, 'redeem')) return res.status(429).json({ success: false, status: 'rate-limited' })
    try {
      const { response, payload } = await providerRequest('/promo/redeem', {
        method: 'POST',
        body: { address, nonce: req.body.nonce, signature: req.body.signature.replace(/^0x/i, '') },
        fetchImpl,
        timeoutMs,
      })
      if (!response.ok) {
        const code = safeCode(payload)
        const mapped = code === 'promo_not_eligible' ? 'promo-not-eligible'
          : code === 'promo_already_redeemed' ? 'promo-already-redeemed'
          : code === 'promo_redeem_unavailable' ? 'promo-unavailable'
          : response.status === 429 ? 'rate-limited' : 'redemption-rejected'
        return res.status(response.status === 403 ? 403 : response.status === 409 ? 409 : response.status === 429 ? 429 : 502).json({
          success: false, status: mapped, providerCode: code,
          message: 'TEnergy did not accept the promotional claim. No token transfer was made.',
        })
      }
      const redemption = publicRedemption(payload)
      if (payload?.address !== address || !redemption) {
        return res.status(502).json({ success: false, status: 'invalid-provider-redemption', message: 'TEnergy returned a mismatched or incomplete redemption result.' })
      }
      return res.status(200).json({
        success: true,
        network: 'mainnet',
        provider: 'tenergy',
        redemption,
        walletTicketDiscarded: Boolean(payload.wallet_ticket),
        message: redemption.status === 'delegated'
          ? 'TEnergy reports the Energy delegation has been made; the app must independently confirm Mainnet resources before using it.'
          : 'The claim was accepted. Energy is not usable until delegation is independently confirmed on Mainnet.',
      })
    } catch {
      return res.status(503).json({ success: false, status: 'provider-unavailable', message: 'TEnergy redemption status is unknown. Check its status before retrying; the claim is single-use.' })
    }
  })

  return router
}

export default createTenergyPromoRouter()
