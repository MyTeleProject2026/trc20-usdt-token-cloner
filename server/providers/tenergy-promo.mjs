const BASE_URL = 'https://api.tenergy.me/v1'
const ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const NONCE = /^[A-Za-z0-9_-]{8,160}$/
const SIGNATURE = /^(?:0x)?[0-9a-f]{130}$/i
const PROMO_STATES = new Set(['active', 'cap_reached_today', 'not_started', 'ended', 'off'])
const REDEMPTION_STATES = new Set(['granting', 'delegated', 'failed'])

function safeError(status, httpStatus) {
  return { success: false, status, ...(Number.isInteger(httpStatus) ? { httpStatus } : {}) }
}

function cleanRedemption(body, address) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || body.address !== address || !REDEMPTION_STATES.has(body.status)
    || !Number.isSafeInteger(body.energy) || body.energy < 0
    || typeof body.redeemed_at !== 'string' || !Number.isFinite(Date.parse(body.redeemed_at))
    || (body.expires_at !== null && (typeof body.expires_at !== 'string' || !Number.isFinite(Date.parse(body.expires_at))))) {
    throw new Error('tenergy-promo-redemption-schema-invalid')
  }
  // The provider also returns a short-lived wallet_ticket. It is an account
  // credential, not needed to verify a resource grant, so never forward it.
  return {
    address,
    method: body.method === 'signature' || body.method === 'forward' ? body.method : 'unknown',
    redeemedAt: body.redeemed_at,
    status: body.status,
    energy: body.energy,
    expiresAt: body.expires_at,
    hasAccount: body.has_account === true,
  }
}

/**
 * TEnergy's published Mainnet promo flow: public eligibility challenge,
 * owner-signed TIP-191 message, then a one-time free Energy delegation.
 * This adapter never holds a wallet key and never submits a TRON transaction
 * from the owner's account. The provider verifies the signature and delegates
 * from its own resource pool.
 */
export function createTenergyPromoClient({ fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  async function request(path, method = 'GET', body) {
    const response = await fetchImpl(BASE_URL + path, {
      method,
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
    let payload
    try { payload = await response.json() } catch { throw new Error('tenergy-promo-invalid-json') }
    if (!response.ok) {
      const error = new Error('tenergy-promo-request-failed')
      error.status = response.status
      error.providerCode = Number.isInteger(payload?.code) ? payload.code : undefined
      throw error
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('tenergy-promo-invalid-response')
    }
    return payload
  }

  async function getPromo() {
    try {
      const body = await request('/promo')
      if (body.network !== 'mainnet' || !PROMO_STATES.has(body.state)) throw new Error('tenergy-promo-schema-invalid')
      if (body.state === 'active' && (!body.grant || body.grant.resource !== 'energy'
        || !Number.isSafeInteger(body.grant.amount) || body.grant.amount <= 0
        || !Number.isSafeInteger(body.grant.duration_seconds) || body.grant.duration_seconds <= 0)) {
        throw new Error('tenergy-promo-schema-invalid')
      }
      return {
        success: true, provider: 'tenergy', network: 'mainnet', state: body.state,
        startsAt: body.starts_at ?? null, endsAt: body.ends_at ?? null,
        capPerDay: body.cap_per_day ?? null, leftToday: body.left_today ?? null,
        resetsAt: body.resets_at ?? null,
        grant: body.grant ? {
          resource: body.grant.resource,
          amount: body.grant.amount,
          durationSeconds: body.grant.duration_seconds,
        } : null,
        eligibleByAddress: false,
        note: 'Promo terms are public. Eligibility is checked for the exact owner address when requesting a challenge.',
      }
    } catch (error) {
      return safeError('promo-terms-unavailable', error.status)
    }
  }

  async function createChallenge(address) {
    if (typeof address !== 'string' || !ADDRESS.test(address)) return safeError('invalid-address')
    try {
      const body = await request('/promo/redeem/challenge', 'POST', { address })
      if (body.address !== address || body.purpose !== 'promo_redeem'
        || typeof body.nonce !== 'string' || !NONCE.test(body.nonce)
        || typeof body.message !== 'string' || body.message.length < 16 || body.message.length > 2048
        || typeof body.expires_at !== 'string' || !Number.isFinite(Date.parse(body.expires_at))) {
        throw new Error('tenergy-promo-challenge-schema-invalid')
      }
      return {
        success: true, provider: 'tenergy', network: 'mainnet',
        address, nonce: body.nonce, purpose: body.purpose,
        message: body.message, issuedAt: body.issued_at ?? null,
        expiresAt: body.expires_at,
        signing: 'TIP-191 personal-sign; sign the exact message verbatim in the owner wallet',
      }
    } catch (error) {
      return safeError(error.providerCode === 3038 ? 'promo-not-eligible'
        : error.providerCode === 3039 ? 'promo-already-redeemed'
          : error.providerCode === 3040 ? 'promo-not-available'
            : 'promo-challenge-unavailable', error.status)
    }
  }

  async function redeem({ address, nonce, signature } = {}) {
    if (typeof address !== 'string' || !ADDRESS.test(address)
      || typeof nonce !== 'string' || !NONCE.test(nonce)
      || typeof signature !== 'string' || !SIGNATURE.test(signature)) {
      return safeError('invalid-redemption-request')
    }
    try {
      const body = await request('/promo/redeem', 'POST', {
        address, nonce, signature: signature.replace(/^0x/i, ''),
      })
      const redemption = cleanRedemption(body, address)
      return { success: true, provider: 'tenergy', network: 'mainnet', ...redemption }
    } catch (error) {
      return safeError(error.providerCode === 3038 ? 'promo-not-eligible'
        : error.providerCode === 3039 ? 'promo-already-redeemed'
          : error.providerCode === 3040 ? 'promo-not-available'
            : 'promo-redemption-unavailable', error.status)
    }
  }

  async function getRedemption(address) {
    if (typeof address !== 'string' || !ADDRESS.test(address)) return safeError('invalid-address')
    try {
      const body = await request('/promo/redemptions/' + encodeURIComponent(address))
      return { success: true, provider: 'tenergy', network: 'mainnet', ...cleanRedemption(body, address) }
    } catch (error) {
      if (error.status === 404) return { success: true, provider: 'tenergy', network: 'mainnet', address, status: 'not-claimed' }
      return safeError('promo-redemption-status-unavailable', error.status)
    }
  }

  return Object.freeze({ getPromo, createChallenge, redeem, getRedemption })
}
