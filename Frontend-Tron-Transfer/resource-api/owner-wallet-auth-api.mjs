import { createHash, timingSafeEqual, randomBytes } from 'node:crypto'
import pg from 'pg'
import { sponsorDatabaseConnectionString } from './sponsor-api.mjs'
import { normalizePostgresTlsMode } from './scripts/sponsor-ledger-database-identity.mjs'
import { createManagedWalletIdentityReport } from './managed-wallet-identities.mjs'
import {
  hashWalletPassword, verifyWalletPassword, validateWalletPassword,
  createWalletSessionSecrets, hashWalletSessionToken,
} from './managed-wallet-auth-crypto.mjs'

const { Pool } = pg
const SESSION_MS = 8 * 60 * 60 * 1000
const COOKIE = 'tron_owner_session'
const CSRF_COOKIE = 'tron_owner_csrf'

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

export function createOwnerWalletAuthApi({ env = process.env, database, send, allowedOrigins = ['https://tron-transfer.onrender.com', 'http://localhost:5173', 'http://127.0.0.1:5173'], identityReport }) {
  let pool = database || null
  function getPool() {
    if (pool) return pool
    const connection = sponsorDatabaseConnectionString(env)
    if (!connection) return null
    pool = new Pool({ connectionString: normalizePostgresTlsMode(connection), connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, max: 3 })
    pool.on('error', error => process.stderr.write('Owner wallet auth database error: ' + String(error?.code || 'unknown') + '\\n'))
    return pool
  }
  const identity = () => identityReport || createManagedWalletIdentityReport({ env })
  async function audit(db, type, outcome, metadata = {}) {
    await db.query('INSERT INTO public.tron_transfer_wallet_auth_audit (wallet_role,event_type,outcome,metadata) VALUES ($1,$2,$3,$4::jsonb)', ['owner', type, outcome, JSON.stringify(metadata)])
  }
  async function issueSession(db, res) {
    const secret = createWalletSessionSecrets()
    await db.query('INSERT INTO public.tron_transfer_wallet_sessions (wallet_role,token_hash,csrf_hash,expires_at) VALUES ($1,$2,$3,now()+interval \'8 hours\')', ['owner', secret.tokenHash, secret.csrfHash])
    setSessionCookies(res, secret.sessionToken, secret.csrfToken)
    return { csrfToken: secret.csrfToken, expiresInSeconds: SESSION_MS / 1000 }
  }
  async function authenticate(req, db, requireCsrf = false) {
    const token = cookieValue(req, COOKIE)
    const tokenHash = hashWalletSessionToken(token)
    if (!tokenHash) return null
    const result = await db.query(`SELECT s.session_id,s.csrf_hash,a.wallet_address
      FROM public.tron_transfer_wallet_sessions s
      JOIN public.tron_transfer_wallet_accounts a USING(wallet_role)
      WHERE s.wallet_role='owner' AND s.token_hash=$1 AND s.revoked_at IS NULL
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
    // Internal in-process verifier for Owner transaction routes. Session tokens
    // remain in HttpOnly cookies; callers receive only the enrolled address and
    // session identifier after optional CSRF/Origin validation.
    async authenticateRequest(req, { requireCsrf = false } = {}) {
      const db = getPool()
      if (!db) return null
      return authenticate(req, db, requireCsrf)
    },
    async handle(req, res, url, origin) {
      if (url.pathname !== '/api/wallet-auth/owner' && !url.pathname.startsWith('/api/wallet-auth/owner/')) return false
      const db = getPool()
      if (!db) { send(res, 503, { success: false, error: 'WALLET_AUTH_DATABASE_UNAVAILABLE' }, origin); return true }
      try {
        if (url.pathname === '/api/wallet-auth/owner/status' && req.method === 'GET') {
          const result = await db.query("SELECT wallet_address FROM public.tron_transfer_wallet_accounts WHERE wallet_role='owner' AND enabled=true")
          send(res, 200, { success: true, enrolled: Boolean(result.rows[0]), network: 'TRON Mainnet' }, origin); return true
        }
        if (url.pathname === '/api/wallet-auth/owner/enroll' && req.method === 'POST') {
          const bootstrap = String(env.TRON_OWNER_ENROLLMENT_TOKEN || '')
          const presented = String(req.headers['x-owner-enrollment-token'] || '')
          if (bootstrap.length < 32 || !safeEqual(bootstrap, presented)) {
            await audit(db, 'enrollment_rejected', 'denied')
            send(res, 403, { success: false, error: 'OWNER_ENROLLMENT_NOT_AUTHORIZED' }, origin); return true
          }
          const report = identity()
          if (!report.owner.ready || !report.sponsor.ready || !report.identitiesDistinct) { send(res, 503, { success: false, error: 'OWNER_SPONSOR_IDENTITY_SEPARATION_REQUIRED' }, origin); return true }
          const input = await body(req)
          if (!validateWalletPassword(input.password)) { send(res, 400, { success: false, error: 'PASSWORD_POLICY_FAILED', minimumLength: 12 }, origin); return true }
          const verifier = await hashWalletPassword(input.password)
          const client = await db.connect()
          try {
            await client.query('BEGIN')
            const existing = await client.query("SELECT 1 FROM public.tron_transfer_wallet_accounts WHERE wallet_role='owner' FOR UPDATE")
            if (existing.rowCount) {
              await client.query('ROLLBACK')
              await audit(db, 'enrollment_rejected', 'denied', { reason: 'already-enrolled' })
              send(res, 409, { success: false, error: 'OWNER_ALREADY_ENROLLED' }, origin); return true
            }
            await client.query(`INSERT INTO public.tron_transfer_wallet_accounts
              (wallet_role,wallet_address,password_hash,password_salt,password_algorithm,password_params)
              VALUES ('owner',$1,$2,$3,'scrypt',$4::jsonb)`, [report.owner.address, verifier.passwordHash, verifier.passwordSalt, JSON.stringify(verifier.passwordParams)])
            await client.query('COMMIT')
          } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
          await audit(db, 'enrollment_succeeded', 'success')
          const session = await issueSession(db, res)
          send(res, 201, { success: true, enrolled: true, role: 'owner', address: report.owner.address, session }, origin); return true
        }
        if (url.pathname === '/api/wallet-auth/owner/login' && req.method === 'POST') {
          const input = await body(req)
          const result = await db.query("SELECT * FROM public.tron_transfer_wallet_accounts WHERE wallet_role='owner' AND enabled=true")
          const account = result.rows[0]
          if (!account || (account.locked_until && Date.parse(account.locked_until) > Date.now())) {
            send(res, 401, { success: false, error: 'INVALID_CREDENTIALS_OR_LOCKED' }, origin); return true
          }
          const valid = await verifyWalletPassword(input.password, {
            passwordHash: account.password_hash, passwordSalt: account.password_salt,
            passwordAlgorithm: account.password_algorithm, passwordParams: account.password_params,
          })
          if (!valid) {
            const failed = await db.query(`UPDATE public.tron_transfer_wallet_accounts
              SET failed_attempts=failed_attempts+1,
                locked_until=CASE WHEN failed_attempts+1>=5 THEN now()+interval '15 minutes' ELSE locked_until END,
                updated_at=now() WHERE wallet_role='owner' RETURNING failed_attempts`)
            await audit(db, 'login_failed', 'denied')
            if (failed.rows[0]?.failed_attempts >= 5) await audit(db, 'account_locked', 'denied')
            send(res, 401, { success: false, error: 'INVALID_CREDENTIALS_OR_LOCKED' }, origin); return true
          }
          await db.query("UPDATE public.tron_transfer_wallet_accounts SET failed_attempts=0,locked_until=NULL,last_authenticated_at=now(),updated_at=now() WHERE wallet_role='owner'")
          await db.query("UPDATE public.tron_transfer_wallet_sessions SET revoked_at=now() WHERE wallet_role='owner' AND revoked_at IS NULL")
          const session = await issueSession(db, res)
          await audit(db, 'login_succeeded', 'success')
          send(res, 200, { success: true, role: 'owner', address: account.wallet_address, session }, origin); return true
        }
        if (url.pathname === '/api/wallet-auth/owner/session' && req.method === 'GET') {
          const session = await authenticate(req, db)
          if (!session) { send(res, 401, { success: false, error: 'SESSION_REQUIRED' }, origin); return true }
          // Reuse the current readable CSRF proof when it still matches the session;
          // issue a new proof only when the browser cookie is missing or stale.
          const existingCsrf = cookieValue(req, CSRF_COOKIE)
          const csrfMatches = existingCsrf && safeEqual(digest(existingCsrf), session.csrfHash)
          const csrfToken = csrfMatches ? existingCsrf : randomBytes(32).toString('base64url')
          if (!csrfMatches) await db.query('UPDATE public.tron_transfer_wallet_sessions SET csrf_hash=$2 WHERE session_id=$1', [session.sessionId, digest(csrfToken)])
          res.setHeader('set-cookie', 'tron_owner_csrf=' + encodeURIComponent(csrfToken) + '; Path=/; Secure; SameSite=None; Max-Age=28800')
          send(res, 200, { success: true, role: 'owner', address: session.address, csrfToken }, origin); return true
        }
        if (url.pathname === '/api/wallet-auth/owner/logout' && req.method === 'POST') {
          const session = await authenticate(req, db, true)
          if (session) {
            await db.query('UPDATE public.tron_transfer_wallet_sessions SET revoked_at=now() WHERE session_id=$1', [session.sessionId])
            await audit(db, 'session_revoked', 'success')
          }
          clearSessionCookies(res)
          send(res, 200, { success: true, loggedOut: true }, origin); return true
        }
        send(res, 405, { success: false, error: 'METHOD_NOT_ALLOWED' }, origin); return true
      } catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : 503
        send(res, status, { success: false, error: status === 400 ? 'INVALID_REQUEST' : 'WALLET_AUTH_UNAVAILABLE' }, origin)
        return true
      }
    },
  }
}
