import { Router } from 'express'
import { randomBytes } from 'node:crypto'
import { TronWeb } from 'tronweb'
import { isValidTronAddress } from '../tron-address.mjs'

const NETWORKS = new Set(['shasta', 'nile'])
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const SIGNATURE_PATTERN = /^0x[0-9a-f]{130}$/i
const CHALLENGE_TTL_MS = 5 * 60 * 1000
const SESSION_TTL_MS = 30 * 60 * 1000
const MAX_ENTRIES = 2000

function allowedOrigins(env = process.env) {
  return new Set(String(env.FRONTEND_ORIGIN || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      try { return new URL(value).origin } catch { return '' }
    })
    .filter(Boolean))
}

function validOrigin(req, origins) {
  const origin = req.get('origin')
  return typeof origin === 'string' && origins.has(origin)
}

function pruneExpired(store, now) {
  for (const [key, value] of store) {
    if (value.expiresAt <= now) store.delete(key)
  }
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value
    if (oldest === undefined) break
    store.delete(oldest)
  }
}

/**
 * A signed-message login proves control of one public TRON address only.
 * It never grants sponsor spending authority and never enables transfers.
 * Challenges and sessions are deliberately ephemeral and are invalidated by a
 * service restart. A durable production session store should be added before
 * using this identity for any privileged operation.
 */
export function createTronWalletAuthRouter({
  env = process.env,
  now = () => Date.now(),
  nonceFactory = () => randomBytes(24).toString('hex'),
  verifyMessage = async (message, signature) => {
    const tronWeb = new TronWeb({ fullHost: 'https://nile.trongrid.io' })
    return tronWeb.trx.verifyMessageV2(message, signature)
  },
} = {}) {
  const router = Router()
  const challenges = new Map()
  const sessions = new Map()
  const origins = allowedOrigins(env)

  router.post('/challenge', (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    if (!validOrigin(req, origins)) {
      return res.status(403).json({ success: false, error: 'origin-not-allowed', message: 'Open the official TRON Token Studio frontend to sign in.' })
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).some((key) => !['address', 'network'].includes(key))) {
      return res.status(400).json({ success: false, error: 'unexpected-fields' })
    }
    const address = typeof body.address === 'string' ? body.address.trim() : ''
    const network = body.network
    if (!ADDRESS_PATTERN.test(address) || !isValidTronAddress(address)) {
      return res.status(400).json({ success: false, error: 'invalid-address' })
    }
    if (!NETWORKS.has(network)) {
      return res.status(400).json({ success: false, error: 'unsupported-network', message: 'Wallet login is limited to Shasta and Nile testnets.' })
    }

    const current = now()
    pruneExpired(challenges, current)
    const nonce = nonceFactory()
    if (typeof nonce !== 'string' || !/^[0-9a-f]{48,128}$/i.test(nonce) || challenges.has(nonce)) {
      return res.status(503).json({ success: false, error: 'challenge-unavailable' })
    }
    const expiresAt = current + CHALLENGE_TTL_MS
    const message = [
      'TRON Token Studio wallet sign-in',
      'Purpose: prove control of this public address only; no transfer is authorized.',
      `Address: ${address}`,
      `Network: ${network}`,
      `Origin: ${req.get('origin')}`,
      `Nonce: ${nonce}`,
      `Issued At: ${new Date(current).toISOString()}`,
      `Expires At: ${new Date(expiresAt).toISOString()}`,
    ].join('\n')
    challenges.set(nonce, { address, network, message, origin: req.get('origin'), expiresAt })
    pruneExpired(challenges, current)
    return res.json({ success: true, address, network, nonce, message, expiresAt, scope: 'wallet-identity-only' })
  })

  router.post('/verify', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    if (!validOrigin(req, origins)) {
      return res.status(403).json({ success: false, error: 'origin-not-allowed' })
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).some((key) => !['address', 'network', 'nonce', 'signature'].includes(key))) {
      return res.status(400).json({ success: false, error: 'unexpected-fields' })
    }
    const address = typeof body.address === 'string' ? body.address.trim() : ''
    const network = body.network
    const nonce = typeof body.nonce === 'string' ? body.nonce : ''
    const signature = typeof body.signature === 'string' ? body.signature : ''
    if (!ADDRESS_PATTERN.test(address) || !isValidTronAddress(address)
      || !NETWORKS.has(network) || !/^[0-9a-f]{48,128}$/i.test(nonce)
      || !SIGNATURE_PATTERN.test(signature)) {
      return res.status(400).json({ success: false, error: 'invalid-login-payload' })
    }

    const current = now()
    pruneExpired(challenges, current)
    const challenge = challenges.get(nonce)
    // Consume before cryptographic verification so a signature cannot be replayed
    // concurrently or retried after a verification failure.
    challenges.delete(nonce)
    if (!challenge || challenge.expiresAt <= current
      || challenge.address !== address || challenge.network !== network
      || challenge.origin !== req.get('origin')) {
      return res.status(401).json({ success: false, error: 'challenge-expired-or-mismatched' })
    }

    let recovered
    try {
      recovered = await verifyMessage(challenge.message, signature)
    } catch {
      return res.status(401).json({ success: false, error: 'signature-verification-failed' })
    }
    if (recovered !== address) {
      return res.status(401).json({ success: false, error: 'signature-address-mismatch' })
    }

    const sessionToken = randomBytes(32).toString('base64url')
    const expiresAt = current + SESSION_TTL_MS
    pruneExpired(sessions, current)
    sessions.set(sessionToken, { address, network, origin: challenge.origin, expiresAt })
    pruneExpired(sessions, current)
    return res.json({
      success: true,
      authenticated: true,
      address,
      network,
      expiresAt,
      sessionToken,
      scope: 'wallet-identity-only',
      canSubmitSponsoredTransfer: false,
      submissionEnabled: false,
      note: 'Wallet ownership was verified by signature. This session does not authorize sponsor spending or enable transfers.',
    })
  })

  router.get('/session', (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    if (!validOrigin(req, origins)) {
      return res.status(403).json({ success: false, authenticated: false, error: 'origin-not-allowed' })
    }
    const authorization = req.get('authorization') || ''
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
    const current = now()
    pruneExpired(sessions, current)
    const session = sessions.get(token)
    if (!session || session.origin !== req.get('origin') || session.expiresAt <= current) {
      return res.status(401).json({ success: false, authenticated: false, error: 'session-invalid-or-expired' })
    }
    return res.json({
      success: true,
      authenticated: true,
      address: session.address,
      network: session.network,
      expiresAt: session.expiresAt,
      scope: 'wallet-identity-only',
      canSubmitSponsoredTransfer: false,
      submissionEnabled: false,
    })
  })

  router.post('/logout', (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const authorization = req.get('authorization') || ''
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
    if (token) sessions.delete(token)
    return res.json({ success: true, loggedOut: true, canSubmitSponsoredTransfer: false })
  })

  return router
}

export default createTronWalletAuthRouter()
