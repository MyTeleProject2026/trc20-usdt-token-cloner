import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createOwnerWalletAuthApi } from '../owner-wallet-auth-api.mjs'
import { createManagedWalletIdentityReport } from '../managed-wallet-identities.mjs'
import { hashWalletPassword, createWalletSessionSecrets } from '../managed-wallet-auth-crypto.mjs'

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

test('Owner session accepts its role-specific CSRF header alongside an independent Sponsor CSRF header', async () => {
  const secrets = createWalletSessionSecrets()
  const database = {
    async query(sql) {
      if (sql.includes('SELECT s.session_id')) {
        return { rows: [{ session_id: 7, csrf_hash: secrets.csrfHash, wallet_address: address }] }
      }
      return { rowCount: 1, rows: [] }
    },
  }
  const api = createOwnerWalletAuthApi({ env: {}, database, send() {} })
  const headers = {
    cookie: 'tron_owner_session=' + secrets.sessionToken + '; tron_sponsor_session=' + 'b'.repeat(64),
    origin: 'https://tron-transfer.onrender.com',
    'x-owner-csrf-token': secrets.csrfToken,
    'x-csrf-token': 'independent-sponsor-csrf-token',
  }
  const accepted = await api.authenticateRequest({ headers }, { requireCsrf: true })
  assert.equal(accepted.address, address)
  const rejected = await api.authenticateRequest({
    headers: { ...headers, 'x-owner-csrf-token': undefined },
  }, { requireCsrf: true })
  assert.equal(rejected, null)
})

test('Owner and Sponsor identity checks are address-only and never read backend wallet private keys', () => {
  const ownerAddress = address
  const sponsorAddress = 'TSPz5ULCfd4zbMUCfF337KWyia8F1F5kYR'
  const report = createManagedWalletIdentityReport({
    env: {
      TRON_OWNER_ADDRESS: ownerAddress,
      TRON_OWNER_PRIVATE_KEY: '4'.repeat(64),
      SPONSOR_MAINNET_ADDRESS: sponsorAddress,
      SPONSOR_MAINNET_PRIVATE_KEY: '3'.repeat(64),
    },
  })
  assert.equal(report.owner.address, ownerAddress)
  assert.equal(report.owner.signerCustody, 'encrypted-local-owner-vault')
  assert.equal(report.owner.ready, true)
  assert.equal(report.sponsor.address, sponsorAddress)
  assert.equal(report.sponsor.signerCustody, 'encrypted-local-sponsor-vault')
  assert.equal(report.sponsor.ready, true)
  assert.equal(report.sponsor.addressValid, true)
  assert.equal(report.identitiesDistinct, true)
  assert.equal(report.ready, true)
})

test('Owner and Sponsor enrollment identity validation does not require either backend private key', () => {
  const report = createManagedWalletIdentityReport({
    env: {
      TRON_OWNER_ADDRESS: address,
      SPONSOR_MAINNET_ADDRESS: 'TSPz5ULCfd4zbMUCfF337KWyia8F1F5kYR',
    },
  })
  assert.equal(report.owner.ready, true)
  assert.equal(report.sponsor.ready, true)
  assert.equal(report.ready, true)
})

test('Owner identity validation rejects malformed or Sponsor-equal configured addresses', () => {
  const sponsorAddress = 'TSPz5ULCfd4zbMUCfF337KWyia8F1F5kYR'
  const malformed = createManagedWalletIdentityReport({
    env: { TRON_OWNER_ADDRESS: 'not-a-tron-address', SPONSOR_MAINNET_ADDRESS: sponsorAddress },
  })
  const same = createManagedWalletIdentityReport({
    env: { TRON_OWNER_ADDRESS: sponsorAddress, SPONSOR_MAINNET_ADDRESS: sponsorAddress },
  })
  assert.equal(malformed.owner.ready, false)
  assert.equal(malformed.identitiesDistinct, false)
  assert.equal(malformed.ready, false)
  assert.equal(same.identitiesDistinct, false)
  assert.equal(same.ready, false)
})

test('Owner session verifier rejects the other workspace cookie and enforces its own database role', async () => {
  const queries=[]
  const database={async query(sql){queries.push(sql);return {rows:[]}}}
  const api=createOwnerWalletAuthApi({env:{},database,send(){}})
  const foreignToken='a'.repeat(64)
  const otherCookie=await api.authenticateRequest({headers:{cookie:'tron_sponsor_session='+foreignToken}})
  assert.equal(otherCookie,null)
  const ownCookie=await api.authenticateRequest({headers:{cookie:'tron_owner_session='+foreignToken}})
  assert.equal(ownCookie,null)
  assert.equal(queries.length,1)
  assert.match(queries[0],/wallet_role='owner'/)
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
      if (sql.includes('UPDATE public.tron_transfer_wallet_accounts')) { state.account.password_hash=params[0]; state.account.password_salt=params[1]; state.account.password_params=JSON.parse(params[2]); return { rowCount: 1, rows: [{wallet_address:address}] } }
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


test('Owner password change rotates the current session and revokes all old sessions', async () => {
  const oldPassword='current owner password phrase 123'
  const verifier=await hashWalletPassword(oldPassword)
  const current=createWalletSessionSecrets()
  const state={account:{wallet_address:address,password_hash:verifier.passwordHash,password_salt:verifier.passwordSalt,password_algorithm:verifier.passwordAlgorithm,password_params:verifier.passwordParams,enabled:true},sessions:[{session_id:41,token_hash:current.tokenHash,csrf_hash:current.csrfHash,revoked_at:null},{session_id:40,revoked_at:null}],audits:[]}
  const db={
    async connect(){return this},release(){},
    async query(sql,params=[]){
      if(/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql.trim())) return {rowCount:0,rows:[]}
      if(sql.includes('INSERT INTO public.tron_transfer_wallet_auth_audit')){state.audits.push(params);return {rowCount:1,rows:[]}}
      if(sql.includes('SELECT s.session_id')) return {rows:[{session_id:41,csrf_hash:current.csrfHash,wallet_address:address}]}
      if(sql.includes('UPDATE public.tron_transfer_wallet_sessions SET last_seen_at')) return {rowCount:1,rows:[]}
      if(sql.includes('SELECT * FROM public.tron_transfer_wallet_accounts')) return {rows:[state.account]}
      if(sql.includes('UPDATE public.tron_transfer_wallet_accounts')){state.account.password_hash=params[0];state.account.password_salt=params[1];state.account.password_params=JSON.parse(params[2]);return {rowCount:1,rows:[]}}
      if(sql.includes('UPDATE public.tron_transfer_wallet_sessions SET revoked_at=now()')){state.sessions.forEach(item=>{item.revoked_at=new Date()});return {rowCount:2,rows:[]}}
      if(sql.includes('INSERT INTO public.tron_transfer_wallet_sessions')){state.sessions.push({session_id:42,token_hash:params[1],csrf_hash:params[2],revoked_at:null});return {rowCount:1,rows:[]}}
      throw new Error('unexpected-password-change-query: '+sql.slice(0,100))
    }
  }
  const api=createOwnerWalletAuthApi({env:{},database:db,send:(res,status,payload)=>{res.writeHead(status);res.end(JSON.stringify(payload))}})
  const res=response()
  await api.handle(request('POST',{
    cookie:'tron_owner_session='+current.sessionToken+'; tron_owner_csrf='+current.csrfToken,
    origin:'https://tron-transfer.onrender.com',
    'x-csrf-token':current.csrfToken,
  },{currentPassword:oldPassword,newPassword:'replacement owner password phrase 456'}),res,new URL('https://api.test/api/wallet-auth/owner/password/change'),'https://tron-transfer.onrender.com')
  assert.equal(res.status,200)
  assert.equal(JSON.parse(res.body).passwordChanged,true)
  assert.ok(state.sessions.filter(item=>item.session_id!==42).every(item=>item.revoked_at))
  assert.equal(state.sessions.find(item=>item.session_id===42).revoked_at,null)
  assert.ok(state.audits.some(item=>item[1]==='password_changed'))
})
