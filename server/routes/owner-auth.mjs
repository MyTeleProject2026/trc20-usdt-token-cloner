import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { Router } from 'express'
import {
  createOwnerAuthAccount,
  getOwnerAuthAccount,
  persistOwnerAuthSession,
  getOwnerAuthSession,
  revokeOwnerAuthSession,
} from '../database.mjs'

const scrypt = promisify(scryptCallback)
const SESSION_TTL_MS = 8 * 60 * 60 * 1000
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const EMAIL_PATTERN = /^[^\s@]{1,128}@[^\s@]{1,190}$/
const PASSWORD_MIN_LENGTH = 12
const HASH_PREFIX = 'scrypt$32768$8$1$'
const DUMMY_PASSWORD_HASH = HASH_PREFIX + 'A'.repeat(22) + '$' + Buffer.alloc(64).toString('base64url')

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function noStore(res) {
  res.setHeader?.('Cache-Control', 'no-store, private')
  res.setHeader?.('Pragma', 'no-cache')
  res.setHeader?.('Vary', 'Authorization, Origin')
}

function normalizeAllowedOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = new URL(value.trim())
    const desktopOrigin = parsed.protocol === 'tronstudio:' && parsed.host.toLowerCase() === 'app'
    const secureWebOrigin = parsed.protocol === 'https:'
    const localWebOrigin = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase())
    if (!(desktopOrigin || secureWebOrigin || localWebOrigin)
      || parsed.username || parsed.password || parsed.search || parsed.hash
      || (parsed.pathname !== '' && parsed.pathname !== '/')) return null
    return desktopOrigin ? 'tronstudio://app' : parsed.origin
  } catch {
    return null
  }
}

function allowedOrigins(env) {
  const configured = [
    env.FRONTEND_ORIGIN,
    env.PACKAGED_APP_ORIGINS,
    env.OKX_UI_ORIGIN,
  ].filter((value) => typeof value === 'string' && value.trim())
    .flatMap((value) => value.split(','))
  if (env.NODE_ENV !== 'production') {
    configured.push('http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:5173')
  }
  return new Set(configured.map(normalizeAllowedOrigin).filter(Boolean))
}

function requestOrigin(req, env) {
  const origin = typeof req.get === 'function' ? req.get('origin') : req.headers?.origin
  if (typeof origin !== 'string' || normalizeAllowedOrigin(origin) !== origin || !allowedOrigins(env).has(origin)) return ''
  return origin
}

function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length < 1 || left.length !== right.length) return false
  const leftBytes = Buffer.from(left, 'utf8')
  const rightBytes = Buffer.from(right, 'utf8')
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString('base64url')
  const derived = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 })
  return HASH_PREFIX + salt + '$' + Buffer.from(derived).toString('base64url')
}

async function verifyPassword(password, encoded) {
  if (typeof encoded !== 'string') return false
  const parts = encoded.split('$')
  if (parts.length !== 6 || parts.slice(0, 4).join('$') + '$' !== HASH_PREFIX
    || !/^[A-Za-z0-9_-]{20,30}$/.test(parts[4])
    || !/^[A-Za-z0-9_-]{80,100}$/.test(parts[5])) return false
  try {
    const derived = await scrypt(password, parts[4], 64, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 })
    const expected = Buffer.from(parts[5], 'base64url')
    const actual = Buffer.from(derived)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

function bodyString(value, max = 512) {
  return typeof value === 'string' && value.length <= max ? value : ''
}

function getBearer(req) {
  const header = typeof req.get === 'function' ? req.get('authorization') : req.headers?.authorization
  const match = typeof header === 'string' ? /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header) : null
  return match?.[1] || ''
}

/**
 * Private single-owner login for the standalone wallet workspace.
 * The backend setup key is server-only. The first account is the only account
 * permitted; password hashes and opaque, origin-bound, expiring sessions are
 * persisted in PostgreSQL. App login never receives a wallet private key.
 */
export function createOwnerAuthRouter({
  env = process.env,
  getAccount = getOwnerAuthAccount,
  createAccount = createOwnerAuthAccount,
  saveSession = persistOwnerAuthSession,
  readSession = getOwnerAuthSession,
  deleteSession = revokeOwnerAuthSession,
  passwordHasher = hashPassword,
  passwordVerifier = verifyPassword,
  randomToken = () => randomBytes(32).toString('base64url'),
  now = () => Date.now(),
} = {}) {
  const router = Router()
  const failedLoginCounts = new Map()

  router.post('/setup', async (req, res) => {
    noStore(res)
    const origin = requestOrigin(req, env)
    if (!origin) return res.status(403).json({ success: false, error: 'origin-not-allowed' })

    const expectedKey = typeof env.OWNER_SETUP_KEY === 'string' ? env.OWNER_SETUP_KEY : ''
    const setupKey = bodyString(req.body?.setupKey, 512)
    if (expectedKey.length < 32 || !constantTimeEqual(expectedKey, setupKey)) {
      return res.status(403).json({
        success: false,
        error: 'owner-setup-not-authorized',
        message: 'Owner setup is disabled or the setup key is invalid. Configure a high-entropy OWNER_SETUP_KEY on the API service.',
      })
    }

    const email = bodyString(req.body?.email, 190).trim().toLowerCase()
    const password = bodyString(req.body?.password, 1024)
    if (!EMAIL_PATTERN.test(email) || password.length < PASSWORD_MIN_LENGTH) {
      return res.status(400).json({
        success: false,
        error: 'invalid-owner-credentials',
        message: 'Enter a valid email address and a password with at least 12 characters.',
      })
    }

    const current = await getAccount()
    if (!current?.success) return res.status(503).json({ success: false, error: 'owner-auth-storage-unavailable' })
    if (current.account) {
      return res.status(409).json({
        success: false,
        error: 'owner-account-already-initialized',
        message: 'The single owner account already exists. New public sign-ups are disabled.',
      })
    }

    let passwordHash
    try {
      passwordHash = await passwordHasher(password)
    } catch {
      return res.status(500).json({ success: false, error: 'owner-password-setup-failed' })
    }
    const created = await createAccount({ email, passwordHash })
    if (!created?.success) return res.status(503).json({ success: false, error: 'owner-auth-storage-unavailable' })
    if (!created.created) {
      return res.status(409).json({
        success: false,
        error: 'owner-account-already-initialized',
        message: 'Another setup request created the single owner account first. Sign in with that account.',
      })
    }

    return res.status(201).json({
      success: true,
      accountCreated: true,
      email,
      loginRequired: true,
      message: 'The single owner account was created. Sign in to open your private wallet workspace.',
    })
  })

  router.post('/login', async (req, res) => {
    noStore(res)
    const origin = requestOrigin(req, env)
    if (!origin) return res.status(403).json({ success: false, error: 'origin-not-allowed' })

    const email = bodyString(req.body?.email, 190).trim().toLowerCase()
    const password = bodyString(req.body?.password, 1024)
    if (!EMAIL_PATTERN.test(email) || !password) {
      return res.status(400).json({ success: false, error: 'invalid-login-request', message: 'Enter the owner email and password.' })
    }

    const rateKey = origin + ':' + email
    const previous = failedLoginCounts.get(rateKey)
    if (previous && previous.resetAt > now() && previous.count >= 6) {
      res.setHeader?.('Retry-After', String(Math.max(1, Math.ceil((previous.resetAt - now()) / 1000))))
      return res.status(429).json({ success: false, error: 'login-rate-limited', message: 'Too many sign-in attempts. Wait before trying again.' })
    }

    const found = await getAccount()
    if (!found?.success) return res.status(503).json({ success: false, error: 'owner-auth-storage-unavailable' })
    const account = found.account
    let passwordMatches = false
    try {
      passwordMatches = await passwordVerifier(password, account?.passwordHash || DUMMY_PASSWORD_HASH)
    } catch {
      passwordMatches = false
    }
    if (!account || account.email !== email || !passwordMatches) {
      const nextCount = previous && previous.resetAt > now() ? previous.count + 1 : 1
      failedLoginCounts.set(rateKey, {
        count: nextCount,
        resetAt: previous && previous.resetAt > now() ? previous.resetAt : now() + 15 * 60 * 1000,
      })
      return res.status(401).json({ success: false, error: 'invalid-owner-credentials', message: 'The owner email or password is incorrect.' })
    }
    failedLoginCounts.delete(rateKey)

    const token = randomToken()
    if (!TOKEN_PATTERN.test(token)) return res.status(500).json({ success: false, error: 'owner-session-create-failed' })
    const expiresAt = now() + SESSION_TTL_MS
    const saved = await saveSession({ tokenHash: digest(token), email: account.email, origin, expiresAt })
    if (!saved?.success) return res.status(503).json({ success: false, error: 'owner-auth-storage-unavailable' })

    return res.json({ success: true, authenticated: true, email: account.email, sessionToken: token, expiresAt })
  })

  router.get('/session', async (req, res) => {
    noStore(res)
    const origin = requestOrigin(req, env)
    const token = getBearer(req)
    if (!origin || !token) return res.status(401).json({ success: false, authenticated: false, error: 'owner-session-required' })
    const found = await readSession({ tokenHash: digest(token), origin, nowMs: now() })
    if (!found?.success) return res.status(503).json({ success: false, authenticated: false, error: 'owner-auth-storage-unavailable' })
    if (!found.session) return res.status(401).json({ success: false, authenticated: false, error: 'owner-session-invalid' })
    return res.json({ success: true, authenticated: true, email: found.session.email, origin, expiresAt: found.session.expiresAt })
  })

  router.post('/logout', async (req, res) => {
    noStore(res)
    const token = getBearer(req)
    if (!token) return res.json({ success: true, signedOut: true })
    const revoked = await deleteSession({ tokenHash: digest(token) })
    if (!revoked?.success) return res.status(503).json({ success: false, error: 'owner-auth-storage-unavailable' })
    return res.json({ success: true, signedOut: true })
  })

  return router
}

export default createOwnerAuthRouter
