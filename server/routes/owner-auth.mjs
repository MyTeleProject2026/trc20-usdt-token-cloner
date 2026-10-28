import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { Router } from 'express'
import { isValidTronAddress } from '../tron-address.mjs'
import {
  persistWalletAuthSession,
  getWalletAuthSession,
  revokeWalletAuthSession,
} from '../database.mjs'

const scrypt = promisify(scryptCallback)
const SESSION_TTL_DEFAULT_MS = 8 * 60 * 60 * 1000
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const HASH_PATTERN = /^([0-9a-f]{32}):([0-9a-f]{128})$/i
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const FAILURE_WINDOW_MS = 15 * 60 * 1000
const MAX_FAILURES_PER_WINDOW = 8

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function normalizeAllowedOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = new URL(value.trim())
    const packaged = parsed.protocol === 'tronstudio:' && parsed.host.toLowerCase() === 'app'
    const https = parsed.protocol === 'https:'
    const local = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase())
    if (!(packaged || https || local) || parsed.username || parsed.password || parsed.search || parsed.hash
      || (parsed.pathname !== '' && parsed.pathname !== '/')) return null
    return packaged ? 'tronstudio://app' : parsed.origin
  } catch {
    return null
  }
}

function configuredOrigins(env) {
  return new Set([
    env.FRONTEND_ORIGIN,
    env.PACKAGED_APP_ORIGINS,
    env.OKX_UI_ORIGIN,
  ].filter((value) => typeof value === 'string' && value.trim())
    .flatMap((value) => value.split(','))
    .map(normalizeAllowedOrigin)
    .filter(Boolean))
}

function requestOrigin(req) {
  const value = typeof req.get === 'function' ? req.get('origin') : req.headers?.origin
  return typeof value === 'string' ? value : ''
}

function bearerToken(req) {
  const value = typeof req.get === 'function' ? req.get('authorization') : req.headers?.authorization
  const match = typeof value === 'string' ? /^Bearer ([A-Za-z0-9_-]{43})$/.exec(value) : null
  return match ? match[1] : ''
}

function setNoStore(res) {
  res.setHeader?.('Cache-Control', 'no-store, private')
  res.setHeader?.('Pragma', 'no-cache')
  res.setHeader?.('Vary', 'Origin, Authorization')
}

function configuredOwnerAddress(env) {
  const value = typeof env.OWNER_LOGIN_ADDRESS === 'string' && env.OWNER_LOGIN_ADDRESS.trim()
    ? env.OWNER_LOGIN_ADDRESS.trim()
    : typeof env.TREASURY_OWNER_ADDRESS === 'string' ? env.TREASURY_OWNER_ADDRESS.trim() : ''
  return ADDRESS_PATTERN.test(value) ? value : ''
}

function readPasswordHash(value) {
  if (typeof value !== 'string') return null
  const match = HASH_PATTERN.exec(value.trim())
  return match ? { salt: Buffer.from(match[1], 'hex'), expected: Buffer.from(match[2], 'hex') } : null
}

async function passwordMatches(password, parsed) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024 || !parsed) return false
  const actual = await scrypt(password, parsed.salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  })
  return actual.length === parsed.expected.length && timingSafeEqual(actual, parsed.expected)
}

function sessionTtlMs(env) {
  const configured = Number(env.OWNER_SESSION_TTL_SECONDS)
  if (!Number.isInteger(configured)) return SESSION_TTL_DEFAULT_MS
  return Math.min(24 * 60 * 60, Math.max(15 * 60, configured)) * 1000
}

/**
 * Single-owner password login for the private Token Studio console.
 * There is intentionally no registration or password-reset endpoint. The owner
 * address and scrypt password hash are configured out-of-band in the backend.
 * Sessions reuse the existing hashed-token PostgreSQL store and are Mainnet-
 * scoped so owner-only treasury reads can recognize this authenticated identity.
 * This login does not sign transactions or grant custody of any private key.
 */
export function createOwnerAuthRouter({
  env = process.env,
  now = () => Date.now(),
  tokenFactory = () => randomBytes(32).toString('base64url'),
  store = {
    createSession: persistWalletAuthSession,
    getSession: getWalletAuthSession,
    revokeSession: revokeWalletAuthSession,
  },
  isValidAddress = isValidTronAddress,
  verifyPassword = passwordMatches,
} = {}) {
  const router = Router()
  const origins = configuredOrigins(env)
  const attempts = new Map()

  function enforceOrigin(req, res) {
    setNoStore(res)
    const origin = requestOrigin(req)
    if (!origin || origin !== normalizeAllowedOrigin(origin) || !origins.has(origin)) {
      res.status(403).json({ success: false, error: 'origin-not-allowed' })
      return ''
    }
    return origin
  }

  function rateLimitKey(req) {
    const ip = typeof req.ip === 'string' && req.ip ? req.ip : String(req.socket?.remoteAddress || 'unknown')
    return ip + ':' + configuredOwnerAddress(env)
  }

  function rateLimitState(key, timestamp) {
    const existing = attempts.get(key)
    if (!existing || existing.expiresAt <= timestamp) {
      attempts.set(key, { count: 0, expiresAt: timestamp + FAILURE_WINDOW_MS })
      return attempts.get(key)
    }
    return existing
  }

  router.get('/config', (_req, res) => {
    setNoStore(res)
    const ownerAddress = configuredOwnerAddress(env)
    const passwordHashConfigured = Boolean(readPasswordHash(env.OWNER_LOGIN_PASSWORD_HASH))
    const databaseConfigured = Boolean(env.DATABASE_URL)
    return res.json({
      success: true,
      configured: Boolean(ownerAddress && passwordHashConfigured && databaseConfigured),
      ownerAddress: ownerAddress || null,
      requiredEnvironment: [
        ...(!ownerAddress ? ['OWNER_LOGIN_ADDRESS or TREASURY_OWNER_ADDRESS'] : []),
        ...(!passwordHashConfigured ? ['OWNER_LOGIN_PASSWORD_HASH'] : []),
        ...(!databaseConfigured ? ['DATABASE_URL'] : []),
      ],
      sessionDurationSeconds: Math.floor(sessionTtlMs(env) / 1000),
      registrationEnabled: false,
    })
  })

  router.post('/login', async (req, res) => {
    const origin = enforceOrigin(req, res)
    if (!origin) return
    const address = typeof req.body?.address === 'string' ? req.body.address.trim() : ''
    const password = typeof req.body?.password === 'string' ? req.body.password : ''
    const ownerAddress = configuredOwnerAddress(env)
    const parsedHash = readPasswordHash(env.OWNER_LOGIN_PASSWORD_HASH)
    if (!ownerAddress || !isValidAddress(ownerAddress) || !parsedHash || !env.DATABASE_URL) {
      return res.status(503).json({
        success: false,
        error: 'owner-login-not-configured',
        message: 'Owner login is not configured. Ask the service owner to configure the backend environment and database.',
        requiredEnvironment: [
          ...(!ownerAddress ? ['OWNER_LOGIN_ADDRESS or TREASURY_OWNER_ADDRESS'] : []),
          ...(!parsedHash ? ['OWNER_LOGIN_PASSWORD_HASH'] : []),
          ...(!env.DATABASE_URL ? ['DATABASE_URL'] : []),
        ],
      })
    }

    const key = rateLimitKey(req)
    const timestamp = now()
    const bucket = rateLimitState(key, timestamp)
    if (bucket.count >= MAX_FAILURES_PER_WINDOW) {
      return res.status(429).json({
        success: false,
        error: 'login-rate-limited',
        message: 'Too many failed owner login attempts. Wait 15 minutes before retrying.',
      })
    }

    let validPassword = false
    try {
      if (address === ownerAddress && isValidAddress(address)) {
        validPassword = await verifyPassword(password, parsedHash)
      } else {
        // Run the same password KDF for a well-formed password to reduce
        // address-enumeration timing differences.
        await verifyPassword(password, parsedHash)
      }
    } catch {
      return res.status(503).json({ success: false, error: 'owner-password-verification-unavailable' })
    }
    if (address !== ownerAddress || !isValidAddress(address) || !validPassword) {
      bucket.count += 1
      return res.status(401).json({ success: false, error: 'invalid-owner-credentials', message: 'Owner address or password is incorrect.' })
    }

    attempts.delete(key)
    const sessionToken = tokenFactory()
    if (typeof sessionToken !== 'string' || !SESSION_TOKEN_PATTERN.test(sessionToken)) {
      return res.status(503).json({ success: false, error: 'owner-session-generation-failed' })
    }
    const expiresAt = now() + sessionTtlMs(env)
    let created
    try {
      created = await store.createSession({
        tokenHash: digest(sessionToken),
        address: ownerAddress,
        network: 'mainnet',
        origin,
        expiresAt,
      })
    } catch {
      created = null
    }
    if (created?.success !== true) {
      return res.status(503).json({
        success: false,
        error: 'owner-session-storage-unavailable',
        message: 'The owner login could not create a secure session. Check the backend database service.',
      })
    }
    return res.status(200).json({
      success: true,
      authenticated: true,
      scope: 'owner-console',
      address: ownerAddress,
      network: 'mainnet',
      expiresAt,
      sessionToken,
      registrationEnabled: false,
      canSignTransactions: false,
    })
  })

  router.get('/session', async (req, res) => {
    const origin = enforceOrigin(req, res)
    if (!origin) return
    const ownerAddress = configuredOwnerAddress(env)
    if (!ownerAddress || !isValidAddress(ownerAddress)) {
      return res.status(503).json({ success: false, error: 'owner-login-not-configured' })
    }
    const token = bearerToken(req)
    if (!token) return res.status(401).json({ success: false, authenticated: false, error: 'owner-session-required' })
    let lookup
    try { lookup = await store.getSession({ tokenHash: digest(token), origin, nowMs: now() }) } catch { lookup = null }
    if (lookup?.success !== true) return res.status(503).json({ success: false, error: 'owner-session-storage-unavailable' })
    const session = lookup.session
    if (!session || session.address !== ownerAddress || session.network !== 'mainnet' || session.origin !== origin) {
      return res.status(401).json({ success: false, authenticated: false, error: 'owner-session-invalid-or-expired' })
    }
    return res.json({
      success: true,
      authenticated: true,
      scope: 'owner-console',
      address: ownerAddress,
      network: 'mainnet',
      expiresAt: session.expiresAt,
      canSignTransactions: false,
    })
  })

  router.post('/logout', async (req, res) => {
    const origin = enforceOrigin(req, res)
    if (!origin) return
    const token = bearerToken(req)
    if (!token) return res.status(401).json({ success: false, error: 'owner-session-required' })
    let revoked
    try { revoked = await store.revokeSession({ tokenHash: digest(token) }) } catch { revoked = null }
    if (revoked?.success !== true) {
      return res.status(503).json({ success: false, error: 'owner-session-revocation-unavailable' })
    }
    return res.json({ success: true, loggedOut: true })
  })

  return router
}

export { configuredOwnerAddress, passwordMatches, readPasswordHash }
