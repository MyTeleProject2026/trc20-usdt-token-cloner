import { createHash, randomBytes, timingSafeEqual, scrypt as scryptCallback } from 'node:crypto'
import { promisify } from 'node:util'
import { Router } from 'express'
import { Trx } from 'tronweb'
import { isValidTronAddress } from '../tron-address.mjs'
import {
  persistWalletAuthChallenge,
  consumeWalletAuthChallenge,
  persistWalletAuthSession,
  getWalletAuthSession,
  revokeWalletAuthSession,
} from '../database.mjs'

const scrypt = promisify(scryptCallback)
const NETWORKS = new Set(['mainnet', 'shasta', 'nile'])
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const NONCE_PATTERN = /^[0-9a-f]{48,128}$/i
const SIGNATURE_PATTERN = /^0x[0-9a-f]{130}$/i
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const CHALLENGE_TTL_MS = 5 * 60 * 1000
const SESSION_TTL_MS = 30 * 60 * 1000

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function constantTimeHexEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string'
    || !/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

function normalizeAllowedOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = new URL(value.trim())
    const desktopOrigin = parsed.protocol === 'tronstudio:' && parsed.host.toLowerCase() === 'app'
    const secureWebOrigin = parsed.protocol === 'https:'
    const localWebOrigin = parsed.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase())
    if (!(desktopOrigin || secureWebOrigin || localWebOrigin)
      || parsed.username || parsed.password || parsed.search || parsed.hash
      || (parsed.pathname !== '' && parsed.pathname !== '/')) return null
    return desktopOrigin ? 'tronstudio://app' : parsed.origin
  } catch {
    return null
  }
}

function allowedOrigins(env = process.env) {
  return new Set([
    env.FRONTEND_ORIGIN,
    env.PACKAGED_APP_ORIGINS,
    env.OKX_UI_ORIGIN,
  ].filter((value) => typeof value === 'string' && value.trim())
    .flatMap((value) => value.split(','))
    .map(normalizeAllowedOrigin)
    .filter(Boolean))
}

function validOrigin(req, origins) {
  const origin = req.get('origin')
  return typeof origin === 'string'
    && origin === normalizeAllowedOrigin(origin)
    && origins.has(origin)
}

function buildChallengeMessage({ address, network, origin, nonce, issuedAt, expiresAt }) {
  return [
    'TRON Token Studio wallet sign-in',
    'Purpose: prove control of this public address only; no transfer is authorized.',
    `Address: ${address}`,
    `Network: ${network}`,
    `Origin: ${origin}`,
    `Nonce: ${nonce}`,
    `Issued At: ${new Date(issuedAt).toISOString()}`,
    `Expires At: ${new Date(expiresAt).toISOString()}`,
  ].join('\n')
}

function setNoStore(res) {
  res.setHeader('Cache-Control', 'no-store, private')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Vary', 'Origin, Authorization')
}

function bearerToken(req) {
  const authorization = req.get('authorization') || ''
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization)
  return match ? match[1] : ''
}

/**
 * Sign-in proves control of a specific public TRON address on Mainnet, Shasta,
 * or Nile. Challenges are one-use; PostgreSQL stores only a nonce digest plus
 * public challenge metadata/timestamps, and short-lived sessions are stored by
 * token hash. A successful signature creates a network-scoped wallet account.
 * No private key is accepted or stored. Identity alone never grants sponsor
 * spending authority or enables a transfer.
 */
export function createTronWalletAuthRouter({
  env = process.env,
  now = () => Date.now(),
  nonceFactory = () => randomBytes(24).toString('hex'),
  // Message signature recovery is a local cryptographic operation; it does
  // not require a Mainnet/Nile/Shasta RPC request or provider credentials.
  verifyMessage = async (message, signature) => Trx.verifyMessageV2(message, signature),
  store = {
    createChallenge: persistWalletAuthChallenge,
    consumeChallenge: consumeWalletAuthChallenge,
    createSession: persistWalletAuthSession,
    getSession: getWalletAuthSession,
    revokeSession: revokeWalletAuthSession,
  },
} = {}) {
  const router = Router()
  const origins = allowedOrigins(env)

  router.post('/challenge', async (req, res) => {
    setNoStore(res)
    if (!validOrigin(req, origins)) {
      return res.status(403).json({
        success: false,
        error: 'origin-not-allowed',
        message: 'Open the configured TRON Token Studio frontend to sign in.',
      })
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
      return res.status(400).json({
        success: false,
        error: 'unsupported-network',
        message: 'Choose TRON Mainnet, Nile testnet, or Shasta testnet from the application you are signing into.',
      })
    }

    const current = now()
    const nonce = nonceFactory()
    if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) {
      return res.status(503).json({ success: false, error: 'challenge-unavailable' })
    }
    const expiresAt = current + CHALLENGE_TTL_MS
    const message = buildChallengeMessage({
      address,
      network,
      origin: req.get('origin'),
      nonce,
      issuedAt: current,
      expiresAt,
    })

    let persisted
    try {
      persisted = await store.createChallenge({
        nonceHash: digest(nonce),
        messageHash: digest(message),
        address,
        network,
        origin: req.get('origin'),
        issuedAt: current,
        expiresAt,
      })
    } catch {
      persisted = null
    }
    if (persisted?.reason === 'rate-limited') {
      res.setHeader('Retry-After', '300')
      return res.status(429).json({
        success: false,
        error: 'challenge-rate-limited',
        message: 'Too many sign-in challenges were requested for this wallet recently. Wait five minutes and retry.',
      })
    }
    if (persisted?.success !== true) {
      return res.status(503).json({
        success: false,
        error: 'identity-storage-unavailable',
        message: 'Wallet sign-in is temporarily unavailable because secure challenge storage could not be confirmed.',
      })
    }

    return res.json({
      success: true,
      address,
      network,
      nonce,
      message,
      expiresAt,
      scope: 'wallet-identity-only',
      canSubmitSponsoredTransfer: false,
      submissionEnabled: false,
    })
  })

  router.post('/verify', async (req, res) => {
    setNoStore(res)
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
      || !NETWORKS.has(network) || !NONCE_PATTERN.test(nonce)
      || !SIGNATURE_PATTERN.test(signature)) {
      return res.status(400).json({ success: false, error: 'invalid-login-payload' })
    }

    // Consumption happens before signature verification, so invalid attempts also
    // burn the nonce and concurrent requests cannot reuse it across instances.
    let consumed
    try {
      consumed = await store.consumeChallenge({ nonceHash: digest(nonce) })
    } catch {
      consumed = null
    }
    if (consumed?.success !== true) {
      return res.status(503).json({
        success: false,
        error: 'identity-storage-unavailable',
        message: 'Wallet sign-in is temporarily unavailable because challenge storage could not be confirmed.',
      })
    }
    const challenge = consumed.challenge
    const current = now()
    if (!challenge || challenge.expiresAt <= current
      || challenge.address !== address || challenge.network !== network
      || challenge.origin !== req.get('origin')) {
      return res.status(401).json({ success: false, error: 'challenge-expired-or-mismatched' })
    }

    const expectedMessage = buildChallengeMessage({
      address: challenge.address,
      network: challenge.network,
      origin: challenge.origin,
      nonce,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
    })
    // Verify the server-reconstructed message against its stored digest.
    // The browser never supplies the text that the server chooses to verify.
    if (!constantTimeHexEqual(digest(expectedMessage), challenge.messageHash)) {
      return res.status(401).json({ success: false, error: 'challenge-message-mismatch' })
    }

    let recovered
    try {
      recovered = await verifyMessage(expectedMessage, signature)
    } catch {
      return res.status(401).json({ success: false, error: 'signature-verification-failed' })
    }
    if (recovered !== address) {
      return res.status(401).json({ success: false, error: 'signature-address-mismatch' })
    }

    const sessionToken = randomBytes(32).toString('base64url')
    const expiresAt = current + SESSION_TTL_MS
    let persisted
    try {
      persisted = await store.createSession({
        tokenHash: digest(sessionToken),
        address,
        network,
        origin: challenge.origin,
        expiresAt,
      })
    } catch {
      persisted = null
    }
    if (persisted?.success !== true) {
      return res.status(503).json({
        success: false,
        error: 'identity-storage-unavailable',
        message: 'The wallet signature was valid, but a secure session could not be saved. Retry sign-in.',
      })
    }

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
      note: 'Wallet ownership was verified and a wallet account/session was saved. This session does not authorize sponsor spending or enable transfers.',
    })
  })

  router.get('/session', async (req, res) => {
    setNoStore(res)
    if (!validOrigin(req, origins)) {
      return res.status(403).json({ success: false, authenticated: false, error: 'origin-not-allowed' })
    }
    const token = bearerToken(req)
    if (!token) {
      return res.status(401).json({ success: false, authenticated: false, error: 'session-invalid-or-expired' })
    }

    let lookup
    try {
      lookup = await store.getSession({
        tokenHash: digest(token),
        origin: req.get('origin'),
        nowMs: now(),
      })
    } catch {
      lookup = null
    }
    if (lookup?.success !== true) {
      return res.status(503).json({
        success: false,
        authenticated: false,
        error: 'identity-storage-unavailable',
      })
    }
    const session = lookup.session
    if (!session || session.origin !== req.get('origin') || session.expiresAt <= now()) {
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

  router.post('/logout', async (req, res) => {
    setNoStore(res)
    if (!validOrigin(req, origins)) {
      return res.status(403).json({ success: false, error: 'origin-not-allowed' })
    }
    const token = bearerToken(req)
    if (!token) return res.json({ success: true, loggedOut: true, canSubmitSponsoredTransfer: false })

    let revoked
    try {
      revoked = await store.revokeSession({ tokenHash: digest(token) })
    } catch {
      revoked = null
    }
    if (revoked?.success !== true) {
      return res.status(503).json({
        success: false,
        loggedOut: false,
        error: 'identity-storage-unavailable',
      })
    }
    return res.json({ success: true, loggedOut: true, canSubmitSponsoredTransfer: false })
  })

  return router
}

export default createTronWalletAuthRouter()


const OWNER_SESSION_TTL_MS = 15 * 60 * 1000
const OWNER_LOGIN_WINDOW_MS = 15 * 60 * 1000
const OWNER_LOGIN_MAX_ATTEMPTS = 5

function parseOwnerPasswordHash(encoded) {
  if (typeof encoded !== 'string') return null
  const parts = encoded.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return null
  const salt = Buffer.from(parts[1], 'base64url')
  const key = Buffer.from(parts[2], 'base64url')
  if (salt.length < 16 || salt.length > 64 || key.length !== 64) return null
  return { salt, key }
}

async function verifyOwnerPassword(password, encodedHash) {
  const parsed = parseOwnerPasswordHash(encodedHash)
  if (!parsed || typeof password !== 'string' || password.length < 1 || password.length > 1024) return false
  const actual = await scrypt(password, parsed.salt, parsed.key.length, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
  })
  return timingSafeEqual(Buffer.from(actual), parsed.key)
}

/**
 * Password-protected single-owner entry point. It only accepts the one address
 * configured by the operator and never creates public accounts. The password
 * hash, not the plaintext password, belongs in the server environment.
 */
export function createOwnerAuthRouter({
  env = process.env,
  now = () => Date.now(),
  verifyPassword = verifyOwnerPassword,
  store = {
    createSession: persistWalletAuthSession,
    getSession: getWalletAuthSession,
    revokeSession: revokeWalletAuthSession,
  },
} = {}) {
  const router = Router()
  const origins = allowedOrigins(env)
  const attempts = new Map()

  // Sanitized, read-only owner-console diagnostics. This public pre-login
  // endpoint reports only booleans and missing variable NAMES; it never returns
  // addresses, hashes, database URLs, or any secret. Treasury signer and payout
  // readiness stays behind the owner-authenticated withdrawal readiness route.
  router.get('/config', (_req, res) => {
    setNoStore(res)
    const ownerAddress = typeof env.OWNER_WALLET_ADDRESS === 'string' ? env.OWNER_WALLET_ADDRESS.trim() : ''
    const ownerAddressConfigured = ADDRESS_PATTERN.test(ownerAddress) && isValidTronAddress(ownerAddress)
    const passwordHashConfigured = Boolean(parseOwnerPasswordHash(env.OWNER_PASSWORD_HASH))
    const databaseConfigured = typeof env.DATABASE_URL === 'string' && env.DATABASE_URL.trim().length > 0
    const allowedOriginConfigured = origins.size > 0
    const hostedUiOriginAllowed = origins.has('https://trc20-usdt-token-cloner.onrender.com')
    const packagedUiOriginAllowed = origins.has('https://localhost')
    const requiredEnvironment = [
      ...(!ownerAddressConfigured ? ['OWNER_WALLET_ADDRESS (valid TRON Mainnet address)'] : []),
      ...(!passwordHashConfigured ? ['OWNER_PASSWORD_HASH (valid scrypt hash)'] : []),
      ...(!databaseConfigured ? ['DATABASE_URL'] : []),
      ...(!hostedUiOriginAllowed ? ['FRONTEND_ORIGIN must allow https://trc20-usdt-token-cloner.onrender.com'] : []),
      ...(!packagedUiOriginAllowed ? ['PACKAGED_APP_ORIGINS must allow https://localhost for the Capacitor Android app'] : []),
    ]
    return res.json({
      success: true,
      ownerConsole: {
        configured: ownerAddressConfigured && passwordHashConfigured && databaseConfigured && hostedUiOriginAllowed && packagedUiOriginAllowed,
        ownerAddressConfigured,
        passwordHashConfigured,
        databaseConfigured,
        allowedOriginConfigured,
        hostedUiOriginAllowed,
        packagedUiOriginAllowed,
        registrationEnabled: false,
        requiredEnvironment,
      },
      note: 'Pre-login owner-console configuration only. It does not report treasury signer configuration, verify on-chain funds, authorize a transfer, or enable payouts. Use the authenticated owner treasury panel for those checks.',
    })
  })

  router.post('/login', async (req, res) => {
    setNoStore(res)
    if (!validOrigin(req, origins)) return res.status(403).json({ success: false, error: 'origin-not-allowed' })
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).some((key) => !['address', 'password'].includes(key))) {
      return res.status(400).json({ success: false, error: 'unexpected-fields' })
    }
    const current = now()
    const ip = String(req.ip || req.socket?.remoteAddress || 'unknown')
    let state = attempts.get(ip)
    if (!state || current - state.startedAt >= OWNER_LOGIN_WINDOW_MS) {
      state = { startedAt: current, count: 0, blockedUntil: 0 }
      attempts.set(ip, state)
    }
    if (state.blockedUntil > current || state.count >= OWNER_LOGIN_MAX_ATTEMPTS) {
      const until = state.blockedUntil || state.startedAt + OWNER_LOGIN_WINDOW_MS
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((until - current) / 1000))))
      return res.status(429).json({ success: false, error: 'login-rate-limited', message: 'Too many sign-in attempts. Wait before trying again.' })
    }

    const ownerAddress = typeof env.OWNER_WALLET_ADDRESS === 'string' ? env.OWNER_WALLET_ADDRESS.trim() : ''
    const passwordHash = parseOwnerPasswordHash(env.OWNER_PASSWORD_HASH)
    if (!ADDRESS_PATTERN.test(ownerAddress) || !isValidTronAddress(ownerAddress) || !passwordHash) {
      return res.status(503).json({
        success: false,
        error: 'owner-auth-not-configured',
        message: 'Owner authentication is not configured. Set OWNER_WALLET_ADDRESS and a scrypt OWNER_PASSWORD_HASH on the backend.',
      })
    }

    const suppliedAddress = typeof body.address === 'string' ? body.address.trim() : ''
    const suppliedPassword = typeof body.password === 'string' ? body.password : ''
    const left = Buffer.from(suppliedAddress, 'utf8')
    const right = Buffer.from(ownerAddress, 'utf8')
    const addressMatches = left.length === right.length && timingSafeEqual(left, right)
    let passwordMatches = false
    try { passwordMatches = await verifyPassword(suppliedPassword, env.OWNER_PASSWORD_HASH) } catch { passwordMatches = false }
    if (!addressMatches || !passwordMatches) {
      state.count += 1
      if (state.count >= OWNER_LOGIN_MAX_ATTEMPTS) state.blockedUntil = current + OWNER_LOGIN_WINDOW_MS
      return res.status(401).json({ success: false, error: 'invalid-owner-credentials', message: 'The owner address or password is incorrect.' })
    }

    const sessionToken = randomBytes(32).toString('base64url')
    const expiresAt = current + OWNER_SESSION_TTL_MS
    let saved
    try {
      saved = await store.createSession({
        tokenHash: digest(sessionToken),
        address: ownerAddress,
        network: 'mainnet',
        origin: req.get('origin'),
        expiresAt,
      })
    } catch {
      saved = null
    }
    if (saved?.success !== true) {
      return res.status(503).json({ success: false, error: 'owner-session-storage-unavailable', message: 'A secure owner session could not be saved. Check backend database readiness and retry.' })
    }
    attempts.delete(ip)
    return res.json({
      success: true,
      authenticated: true,
      address: ownerAddress,
      network: 'mainnet',
      expiresAt,
      sessionToken,
      scope: 'single-owner-console',
      note: 'This session authenticates the configured owner only. It does not create assets or authorize an unfunded transfer.',
    })
  })

  router.get('/session', async (req, res) => {
    setNoStore(res)
    if (!validOrigin(req, origins)) return res.status(403).json({ success: false, authenticated: false, error: 'origin-not-allowed' })
    const token = bearerToken(req)
    if (!token) return res.status(401).json({ success: false, authenticated: false, error: 'session-invalid-or-expired' })
    let lookup
    try { lookup = await store.getSession({ tokenHash: digest(token), origin: req.get('origin'), nowMs: now() }) } catch { lookup = null }
    if (lookup?.success !== true) return res.status(503).json({ success: false, authenticated: false, error: 'owner-session-storage-unavailable' })
    const session = lookup.session
    const ownerAddress = typeof env.OWNER_WALLET_ADDRESS === 'string' ? env.OWNER_WALLET_ADDRESS.trim() : ''
    if (!session || session.origin !== req.get('origin') || session.expiresAt <= now()
      || session.network !== 'mainnet' || session.address !== ownerAddress) {
      return res.status(401).json({ success: false, authenticated: false, error: 'session-invalid-or-expired' })
    }
    return res.json({
      success: true, authenticated: true, address: session.address,
      network: 'mainnet', expiresAt: session.expiresAt, scope: 'single-owner-console',
    })
  })

  router.post('/logout', async (req, res) => {
    setNoStore(res)
    if (!validOrigin(req, origins)) return res.status(403).json({ success: false, error: 'origin-not-allowed' })
    const token = bearerToken(req)
    if (!token) return res.json({ success: true, loggedOut: true })
    let revoked
    try { revoked = await store.revokeSession({ tokenHash: digest(token) }) } catch { revoked = null }
    if (revoked?.success !== true) return res.status(503).json({ success: false, loggedOut: false, error: 'owner-session-storage-unavailable' })
    return res.json({ success: true, loggedOut: true })
  })

  return router
}
