import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createOwnerWalletAuthApi } from '../owner-wallet-auth-api.mjs'
import { hashWalletPassword } from '../managed-wallet-auth-crypto.mjs'

const address = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const bootstrap = 'owner-enrollment-test-token-with-more-than-32-characters'

function fakeDatabase() {
  const state = { account: null, sessions: [], audit: [] }
  return {
    state,
    async connect() { return this },
    release() {},
    async query(sql, params = []) {
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql.trim())) return { rowCount: 0, rows: [] }
      if (sql.includes('INSERT INTO public.tron_transfer_wallet_auth_audit')) { state.audit.push(params); return { rowCount: 1, rows: [] } }
      if (sql.includes('SELECT wallet_address FROM public.tron_transfer_wallet_accounts')) return { rows: state.account ? [{ wallet_address: state.account.wallet_address }] : [] }
      if (sql.includes('SELECT 1 FROM public.tron_transfer_wallet_accounts')) return { rowCount: state.account ? 1 : 0, rows: state.account ? [{}] : [] }
      if (sql.includes('INSERT INTO public.tron_transfer_wallet_accounts')) {
        state.account = { wallet_address: params[0], password_hash: params[1], password_salt: params[2], password_algorithm: 'scrypt', password_params: JSON.parse(params[3]), enabled: true, failed_attempts: 0 }
        return { rowCount: 1, rows: [] }
      }
      if (sql.includes('INSERT INTO public.tron_transfer_wallet_sessions')) { state.sessions.push({ token_hash: params[1], csrf_hash: params[2], revoked_at: null }); return { rowCount: 1, rows: [] } }
      if (sql.includes('SELECT * FROM public.tron_transfer_wallet_accounts')) return { rows: state.account ? [state.account] : [] }
      if (sql.includes('UPDATE public.tron_transfer_wallet_sessions SET revoked_at=now()')) { state.sessions.forEach(x => { x.revoked_at = new Date() }); return { rowCount: 1, rows: [] } }
      if (sql.includes('UPDATE public.tron_transfer_wallet_accounts SET failed_attempts=0')) { if (state.account) state.account.failed_attempts = 0; return { rowCount: 1, rows: [] } }
      if (sql.includes('UPDATE public.tron_transfer_wallet_sessions SET last_seen_at')) return { rowCount: 1, rows: [] }
      if (sql.includes('UPDATE public.tron_transfer_wallet_sessions SET revoked_at=now() WHERE session_id')) return { rowCount: 1, rows: [] }
      if (sql.includes('SELECT s.session_id')) return { rows: [] }
      throw new Error('unexpected-test-query: ' + sql.slice(0, 100))
    },
  }
}

function request(method, headers = {}, payload = {}) {
  return { method, headers, async *[Symbol.asyncIterator]() { if (method === 'POST') yield Buffer.from(JSON.stringify(payload)) } }
}
function response() {
  return { headers: {}, status: 0, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v }, writeHead(status) { this.status = status }, end(value) { this.body = value || '' } }
}
const identityReport = { owner: { ready: true, address }, sponsor: { ready: true, address: 'TSPz5ULCfd4zbMUCfF337KWyia8F1F5kYR' }, identitiesDistinct: true }

test('Owner auth exposes an internal cookie-session verifier for future contract routes', async () => {
  const api = createOwnerWalletAuthApi({ env: {}, database: fakeDatabase(), send() {} })
  assert.equal(typeof api.authenticateRequest, 'function')
  assert.equal(await api.authenticateRequest({ headers: {} }), null)
})

test('Owner wallet auth ignores paths outside its exact route namespace', async () => {
  const api = createOwnerWalletAuthApi({ env: {}, database: fakeDatabase(), send() {} })
  assert.equal(await api.handle(request('GET'), response(), new URL('https://api.test/api/wallet-auth/ownerish/status'), null), false)
})

test('Owner enrollment requires backend bootstrap token and only succeeds once', async () => {
  const db = fakeDatabase()
  const api = createOwnerWalletAuthApi({ env: { TRON_OWNER_ENROLLMENT_TOKEN: bootstrap }, database: db, send: (res, status, payload) => { res.writeHead(status); res.end(JSON.stringify(payload)) }, identityReport })
  const denied = response()
  await api.handle(request('POST', {}, { password: 'a sufficiently long owner password 123' }), denied, new URL('https://api.test/api/wallet-auth/owner/enroll'), 'https://tron-transfer.onrender.com')
  assert.equal(denied.status, 403)
  assert.equal(db.state.account, null)

  const enrolled = response()
  await api.handle(request('POST', { 'x-owner-enrollment-token': bootstrap }, { password: 'a sufficiently long owner password 123' }), enrolled, new URL('https://api.test/api/wallet-auth/owner/enroll'), 'https://tron-transfer.onrender.com')
  assert.equal(enrolled.status, 201)
  assert.equal(db.state.account.wallet_address, address)
  assert.match(enrolled.headers['set-cookie'][0], /Path=\/; HttpOnly; Secure; SameSite=None/)
  assert.equal(db.state.sessions.length, 1)

  const repeated = response()
  await api.handle(request('POST', { 'x-owner-enrollment-token': bootstrap }, { password: 'another sufficiently long password 123' }), repeated, new URL('https://api.test/api/wallet-auth/owner/enroll'), 'https://tron-transfer.onrender.com')
  assert.equal(repeated.status, 409)
  assert.equal(db.state.sessions.length, 1)
})

test('Owner password login creates a new session and returns no private key material', async () => {
  const db = fakeDatabase()
  const verifier = await hashWalletPassword('correct owner password phrase 123')
  db.state.account = { wallet_address: address, password_hash: verifier.passwordHash, password_salt: verifier.passwordSalt, password_algorithm: verifier.passwordAlgorithm, password_params: verifier.passwordParams, enabled: true, failed_attempts: 0 }
  const api = createOwnerWalletAuthApi({ env: {}, database: db, send: (res, status, payload) => { res.writeHead(status); res.end(JSON.stringify(payload)) } })
  const res = response()
  await api.handle(request('POST', {}, { password: 'correct owner password phrase 123' }), res, new URL('https://api.test/api/wallet-auth/owner/login'), 'https://tron-transfer.onrender.com')
  assert.equal(res.status, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.address, address)
  assert.equal(payload.role, 'owner')
  assert.equal('privateKey' in payload, false)
  assert.equal(db.state.sessions.length, 1)
})


test('Owner recovery token is one-time, expires server-side, and revokes every session', async () => {
  const recoveryToken = 'one-time-owner-recovery-token-value-which-is-long-enough'
  const tokenHash = createHash('sha256').update(recoveryToken).digest('hex')
  const verifier = await hashWalletPassword('old owner password phrase 123')
  const state = { consumed: false, sessions: [{ revoked: false }, { revoked: false }], account: {
    wallet_address: address, password_hash: verifier.passwordHash, password_salt: verifier.passwordSalt,
    password_algorithm: verifier.passwordAlgorithm, password_params: verifier.passwordParams, enabled: true,
  }, audits: [] }
  const db = {
    async connect() { return this }, release() {},
    async query(sql, params=[]) {
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql.trim())) return { rowCount: 0, rows: [] }
      if (sql.includes('INSERT INTO public.tron_transfer_wallet_auth_audit')) { state.audits.push(params); return { rowCount: 1, rows: [] } }
      if (sql.includes('SELECT recovery_token_id')) return { rows: state.consumed || params[0] !== tokenHash ? [] : [{ recovery_token_id: 7 }] }
      if (sql.includes('UPDATE public.tron_transfer_wallet_recovery_tokens')) { state.consumed = true; return { rowCount: 1, rows: [] } }
      if (sql.includes('UPDATE public.tron_transfer_wallet_accounts')) { state.account.password_hash=params[0]; state.account.password_salt=params[1]; state.account.password_params=JSON.parse(params[2]); return { rowCount: 1, rows: [] } }
      if (sql.includes('UPDATE public.tron_transfer_wallet_sessions')) { state.sessions.forEach(item=>{item.revoked=true}); return { rowCount: 2, rows: [] } }
      throw new Error('unexpected-recovery-query: '+sql.slice(0,100))
    },
  }
  const api=createOwnerWalletAuthApi({env:{},database:db,send:(res,status,payload)=>{res.writeHead(status);res.end(JSON.stringify(payload))}})
  const first=response()
  await api.handle(request('POST',{origin:'https://tron-transfer.onrender.com'},{recoveryToken,newPassword:'new owner password phrase 456'}),first,new URL('https://api.test/api/wallet-auth/owner/recover'),'https://tron-transfer.onrender.com')
  assert.equal(first.status,200)
  assert.equal(JSON.parse(first.body).passwordRecovered,true)
  assert.equal(state.consumed,true)
  assert.ok(state.sessions.every(item=>item.revoked))
  assert.ok(state.audits.some(item=>item[1]==='password_changed' && item[3].includes('one-time-recovery-token')))

  const second=response()
  await api.handle(request('POST',{origin:'https://tron-transfer.onrender.com'},{recoveryToken,newPassword:'another new owner password phrase 789'}),second,new URL('https://api.test/api/wallet-auth/owner/recover'),'https://tron-transfer.onrender.com')
  assert.equal(second.status,401)
})
