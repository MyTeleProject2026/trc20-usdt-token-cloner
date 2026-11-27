import { createHash, timingSafeEqual, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import pg from 'pg'
import { walletAuthDatabaseConnectionString } from './sponsor-api.mjs'
import { normalizePostgresTlsMode } from './scripts/sponsor-ledger-database-identity.mjs'
import { createManagedWalletIdentityReport } from './managed-wallet-identities.mjs'
import {
  hashWalletPassword, verifyWalletPassword, validateWalletPassword,
  createWalletSessionSecrets, hashWalletSessionToken,
} from './managed-wallet-auth-crypto.mjs'

const { Pool } = pg
const SESSION_MS = 8 * 60 * 60 * 1000
const COOKIE = 'tron_sponsor_session'
const CSRF_COOKIE = 'tron_sponsor_csrf'

function digest(value) { return createHash('sha256').update(value).digest('hex') }
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const x = Buffer.from(a); const y = Buffer.from(b)
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
}
function cookieValue(req, name) {
  const header = String(req.headers.cookie || '')
  const item = header.split(';').map(x => x.trim()).find(x => x.startsWith(name + '='))
  return item ? decodeURIComponent(item.slice(name.length + 1)) : ''
}
async function body(req) {
  const chunks = []; let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 8192) throw Object.assign(new Error('request-too-large'), { status: 413 })
    chunks.push(chunk)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed
  } catch { throw Object.assign(new Error('invalid-json'), { status: 400 }) }
}
function setSessionCookies(res, token, csrf) {
  res.setHeader('set-cookie', [
    COOKIE + '=' + encodeURIComponent(token) + '; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=28800',
    CSRF_COOKIE + '=' + encodeURIComponent(csrf) + '; Path=/; Secure; SameSite=None; Max-Age=28800',
  ])
}
function clearSessionCookies(res) {
  res.setHeader('set-cookie', [
    COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0',
    CSRF_COOKIE + '=; Path=/; Secure; SameSite=None; Max-Age=0',
  ])
}

function createLoginRateLimiter({ limit = 10, windowMs = 15 * 60_000, maxBuckets = 5000 } = {}) {
  const buckets = new Map()
  return req => {
    const forwarded = typeof req.headers?.['cf-connecting-ip'] === 'string' ? req.headers['cf-connecting-ip'].trim() : ''
    const remote = typeof req.socket?.remoteAddress === 'string' ? req.socket.remoteAddress : ''
    const ip = isIP(forwarded) ? forwarded : (isIP(remote) ? remote : 'unknown')
    const now = Date.now()
    let bucket = buckets.get(ip)
    if (!bucket || now - bucket.startedAt >= windowMs) {
      if (buckets.size >= maxBuckets) {
        for (const [key, value] of buckets) if (now - value.startedAt >= windowMs) buckets.delete(key)
        if (buckets.size >= maxBuckets && !buckets.has(ip)) return false
      }
      bucket = { startedAt: now, count: 0 }
      buckets.set(ip, bucket)
    }
    if (bucket.count >= limit) return false
    bucket.count += 1
    return true
  }
}

export function createSponsorWalletAuthApi({ env = process.env, database, send, allowedOrigins = ['https://tron-transfer.onrender.com', 'http://localhost:5173', 'http://127.0.0.1:5173'], identityReport }) {
  let pool = database || null
  function getPool() {
    if (pool) return pool
    const connection = walletAuthDatabaseConnectionString(env)
    if (!connection) return null
    pool = new Pool({ connectionString: normalizePostgresTlsMode(connection), connectionTimeoutMillis: 8000, query_timeout: 8000, statement_timeout: 7000, idleTimeoutMillis: 30000, max: 3, application_name: 'tron-transfer-wallet-auth' })
    pool.on('error', error => process.stderr.write('Sponsor wallet auth database error: ' + String(error?.code || 'unknown') + '\\n'))
    return pool
  }
  const identity = () => identityReport || createManagedWalletIdentityReport({ env })
  const allowLoginAttempt = createLoginRateLimiter()
  const allowRecoveryAttempt = createLoginRateLimiter({ limit: 3 })
  async function audit(db, type, outcome, metadata = {}) {
    await db.query('INSERT INTO public.tron_transfer_wallet_auth_audit (wallet_role,event_type,outcome,metadata) VALUES ($1,$2,$3,$4::jsonb)', ['sponsor', type, outcome, JSON.stringify(metadata)])
  }
  async function issueSession(db, res, sessionGroupId) {
    if (!sessionGroupId) throw Object.assign(new Error('OWNER_ADMIN_SESSION_REQUIRED'), { status: 401 })
    const secret = createWalletSessionSecrets()
    await db.query('INSERT INTO public.tron_transfer_wallet_sessions (wallet_role,token_hash,csrf_hash,session_group_id,expires_at) VALUES ($1,$2,$3,$4,now()+interval \'8 hours\')', ['sponsor', secret.tokenHash, secret.csrfHash, sessionGroupId])
    setSessionCookies(res, secret.sessionToken, secret.csrfToken)
    return { csrfToken: secret.csrfToken, expiresInSeconds: SESSION_MS / 1000 }
  }
  async function authenticateOwnerSessionForSponsorEnrollment(req, db) {
    const ownerToken = cookieValue(req, 'tron_owner_session')
    const tokenHash = hashWalletSessionToken(ownerToken)
    if (!tokenHash) return null
    const result = await db.query(`SELECT s.session_id,s.session_group_id,a.wallet_address
      FROM public.tron_transfer_wallet_sessions s
      JOIN public.tron_transfer_wallet_accounts a USING(wallet_role)
      WHERE s.wallet_role='owner' AND s.token_hash=$1 AND s.revoked_at IS NULL
        AND s.expires_at>now() AND a.enabled=true`, [tokenHash])
    const session = result.rows?.[0]
    if (!session?.session_group_id) return null
    return { sessionId: session.session_id, sessionGroupId: session.session_group_id, address: session.wallet_address }
  }

  async function authenticate(req, db, requireCsrf = false) {
    const token = cookieValue(req, COOKIE)
    const tokenHash = hashWalletSessionToken(token)
    if (!tokenHash) return null
    const result = await db.query(`SELECT s.session_id,s.csrf_hash,a.wallet_address
      FROM public.tron_transfer_wallet_sessions s
      JOIN public.tron_transfer_wallet_accounts a USING(wallet_role)
      WHERE s.wallet_role='sponsor' AND s.token_hash=$1 AND s.revoked_at IS NULL
        AND s.expires_at>now() AND a.enabled=true`, [tokenHash])
    const session = result.rows[0]
    if (!session) return null
    if (requireCsrf) {
      const csrf = req.headers['x-csrf-token']
      if (!safeEqual(digest(String(csrf || '')), session.csrf_hash)
        || !allowedOrigins.includes(String(req.headers.origin || ''))) return null
    }
    await db.query('UPDATE public.tron_transfer_wallet_sessions SET last_seen_at=now() WHERE session_id=$1', [session.session_id])
    return { address: session.wallet_address, sessionId: session.session_id, csrfHash: session.csrf_hash }
  }

  return {
    // Persist only the public identity and session metadata for a successful
    // sign-only check. Never store the message, signature, nonce, or key material.
    async recordSignerAcceptance({ address, sessionId, verifiedAt }) {
      const db = getPool()
      if (!db || !address || sessionId == null) return false
      await audit(db, 'signer_acceptance_verified', 'success', {
        address: String(address),
        sessionId: String(sessionId),
        verifiedAt: String(verifiedAt || new Date().toISOString()),
      })
      return true
    },
    // Used only by the in-process Sponsor API. It never exposes the session
    // token or private key; mutating routes require same-origin CSRF proof.
    async authenticateRequest(req, { requireCsrf = false } = {}) {
      const db = getPool()
      if (!db) return null
      try { return await authenticate(req, db, requireCsrf) } catch { return null }
    },
    async handle(req, res, url, origin) {
      if (url.pathname !== '/api/wallet-auth/sponsor' && !url.pathname.startsWith('/api/wallet-auth/sponsor/')) return false
      const db = getPool()
      if (!db) { send(res, 503, { success: false, error: 'WALLET_AUTH_DATABASE_UNAVAILABLE' }, origin); return true }
      try {
        if (url.pathname === '/api/wallet-auth/sponsor/status' && req.method === 'GET') {
          const result = await db.query("SELECT wallet_address FROM public.tron_transfer_wallet_accounts WHERE wallet_role='sponsor' AND enabled=true")
          send(res, 200, { success: true, enrolled: Boolean(result.rows[0]), network: 'TRON Mainnet' }, origin); return true
        }
        if (url.pathname === '/api/wallet-auth/sponsor/enroll' && req.method === 'POST') {
          const input = await body(req)
          const bootstrap = String(env.TRON_SPONSOR_ENROLLMENT_TOKEN || '')
          const presented = String(req.headers['x-sponsor-enrollment-token'] || '')
          const initialPassword = String(env.TRON_SPONSOR_INITIAL_PASSWORD || '')
          const initialPasswordValid = initialPassword.length >= 12 && safeEqual(initialPassword, String(input.currentPassword || ''))
          const tokenValid = bootstrap.length >= 32 && safeEqual(bootstrap, presented)
          if (!initialPasswordValid && !tokenValid) {
            await audit(db, 'enrollment_rejected', 'denied')
            send(res, 403, { success: false, error: 'SPONSOR_ENROLLMENT_NOT_AUTHORIZED' }, origin); return true
          }
          const report = identity()
          if (!report.sponsor.ready || !report.owner.ready || !report.identitiesDistinct) { send(res, 503, { success: false, error: 'OWNER_SPONSOR_IDENTITY_SEPARATION_REQUIRED' }, origin); return true }
          const ownerSession = await authenticateOwnerSessionForSponsorEnrollment(req, db)
          if (!ownerSession || ownerSession.address !== report.owner.address) { send(res, 401, { success: false, error: 'OWNER_ADMIN_SESSION_REQUIRED' }, origin); return true }
          if (!validateWalletPassword(input.password)) { send(res, 400, { success: false, error: 'PASSWORD_POLICY_FAILED', minimumLength: 8 }, origin); return true }
          const verifier = await hashWalletPassword(input.password)
          const client = await db.connect()
          try {
            await client.query('BEGIN')
            const existing = await client.query("SELECT 1 FROM public.tron_transfer_wallet_accounts WHERE wallet_role='sponsor' FOR UPDATE")
            if (existing.rowCount) {
              await client.query('ROLLBACK')
              await audit(db, 'enrollment_rejected', 'denied', { reason: 'already-enrolled' })
              send(res, 409, { success: false, error: 'SPONSOR_ALREADY_ENROLLED' }, origin); return true
            }
            await client.query(`INSERT INTO public.tron_transfer_wallet_accounts
              (wallet_role,wallet_address,password_hash,password_salt,password_algorithm,password_params)
              VALUES ('sponsor',$1,$2,$3,'scrypt',$4::jsonb)`, [report.sponsor.address, verifier.passwordHash, verifier.passwordSalt, JSON.stringify(verifier.passwordParams)])
            await client.query('COMMIT')
          } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
          await audit(db, 'enrollment_succeeded', 'success')
          const session = await issueSession(db, res, ownerSession.sessionGroupId)
          send(res, 201, { success: true, enrolled: true, role: 'sponsor', address: report.sponsor.address, session }, origin); return true
        }
        if (url.pathname === '/api/wallet-auth/sponsor/login' && req.method === 'POST') {
          send(res, 403, { success: false, error: 'OWNER_ADMIN_LOGIN_REQUIRED' }, origin); return true
        }
        if (url.pathname === '/api/wallet-auth/sponsor/session' && req.method === 'GET') {
          const session = await authenticate(req, db)
          if (!session) { send(res, 401, { success: false, error: 'SESSION_REQUIRED' }, origin); return true }
          // Reuse the current readable CSRF proof when it still matches the session;
          // issue a new proof only when the browser cookie is missing or stale.
          const existingCsrf = cookieValue(req, CSRF_COOKIE)
          const csrfMatches = existingCsrf && safeEqual(digest(existingCsrf), session.csrfHash)
          const csrfToken = csrfMatches ? existingCsrf : randomBytes(32).toString('base64url')
          if (!csrfMatches) await db.query('UPDATE public.tron_transfer_wallet_sessions SET csrf_hash=$2 WHERE session_id=$1', [session.sessionId, digest(csrfToken)])
          res.setHeader('set-cookie', 'tron_sponsor_csrf=' + encodeURIComponent(csrfToken) + '; Path=/; Secure; SameSite=None; Max-Age=28800')
          send(res, 200, { success: true, role: 'sponsor', address: session.address, csrfToken }, origin); return true
        }
        if (url.pathname === '/api/wallet-auth/sponsor/logout' && req.method === 'POST') {
          const session = await authenticate(req, db, true)
          if (session) {
            await db.query('UPDATE public.tron_transfer_wallet_sessions SET revoked_at=now() WHERE session_id=$1', [session.sessionId])
            await audit(db, 'session_revoked', 'success')
          }
          clearSessionCookies(res)
          send(res, 200, { success: true, loggedOut: true }, origin); return true
        }
        if (url.pathname === '/api/wallet-auth/sponsor/sessions' && req.method === 'GET') {
          const session = await authenticate(req, db)
          if (!session) { send(res, 401, { success: false, error: 'SESSION_REQUIRED' }, origin); return true }
          const result = await db.query(`
            SELECT session_id,created_at,last_seen_at,expires_at,
              (session_id=$1) AS current
            FROM public.tron_transfer_wallet_sessions
            WHERE wallet_role='sponsor' AND revoked_at IS NULL AND expires_at>now()
            ORDER BY last_seen_at DESC LIMIT 50
          `, [session.sessionId])
          send(res, 200, { success: true, sessions: result.rows || [] }, origin); return true
        }
        const revokeSessionMatch = url.pathname.match(/^\/api\/wallet-auth\/sponsor\/sessions\/([0-9]+)\/revoke$/)
        if (revokeSessionMatch && req.method === 'POST') {
          const session = await authenticate(req, db, true)
          if (!session) { send(res, 401, { success: false, error: 'SESSION_REQUIRED' }, origin); return true }
          const targetId = Number(revokeSessionMatch[1])
          if (!Number.isSafeInteger(targetId) || targetId <= 0 || targetId === Number(session.sessionId)) {
            send(res, 400, { success: false, error: 'CANNOT_REVOKE_CURRENT_SESSION' }, origin); return true
          }
          const revoked = await db.query(`
            UPDATE public.tron_transfer_wallet_sessions SET revoked_at=now()
            WHERE session_id=$1 AND wallet_role='sponsor' AND revoked_at IS NULL
            RETURNING session_id
          `, [targetId])
          if (revoked.rowCount) await audit(db, 'session_revoked', 'success', { scope: 'single-session' })
          send(res, 200, { success: true, revoked: Boolean(revoked.rowCount) }, origin); return true
        }
        if (url.pathname === '/api/wallet-auth/sponsor/sessions/revoke-others' && req.method === 'POST') {
          const session = await authenticate(req, db, true)
          if (!session) { send(res, 401, { success: false, error: 'SESSION_REQUIRED' }, origin); return true }
          const revoked = await db.query(`
            UPDATE public.tron_transfer_wallet_sessions SET revoked_at=now()
            WHERE wallet_role='sponsor' AND session_id<>$1 AND revoked_at IS NULL
            RETURNING session_id
          `, [session.sessionId])
          for (const _row of (revoked.rows || [])) await audit(db, 'session_revoked', 'success', { scope: 'other-session' })
          send(res, 200, { success: true, revokedCount: revoked.rowCount || 0 }, origin); return true
        }
        if (url.pathname === '/api/wallet-auth/sponsor/password/change' && req.method === 'POST') {
          send(res, 403, { success: false, error: 'OWNER_ADMIN_PASSWORD_MANAGED' }, origin); return true
        }
        if (url.pathname === '/api/wallet-auth/sponsor/recover' && req.method === 'POST') {
          send(res, 403, { success: false, error: 'OWNER_ADMIN_PASSWORD_MANAGED' }, origin); return true
        }
        send(res, 405, { success: false, error: 'METHOD_NOT_ALLOWED' }, origin); return true
      } catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : 503
        const diagnosticCode = typeof error?.code === 'string' && /^[A-Z0-9_]{2,32}$/.test(error.code) ? error.code : (status === 400 ? 'INVALID_REQUEST' : 'DATABASE_QUERY_FAILED')
        if (status >= 500) process.stderr.write('Sponsor wallet auth request failed: ' + diagnosticCode + '\\n')
        send(res, status, { success: false, error: status === 400 ? 'INVALID_REQUEST' : 'WALLET_AUTH_UNAVAILABLE', diagnosticCode }, origin)
        return true
      }
    },
  }
}
