import test from 'node:test'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { createSponsorWalletAuthApi } from '../sponsor-wallet-auth-api.mjs'
import { hashWalletPassword, verifyWalletPassword } from '../managed-wallet-auth-crypto.mjs'

const address = 'TSPz5ULCfd4zbMUCfF337KWyia8F1F5kYR'
const bootstrap = 'sponsor-enrollment-test-token-with-more-than-32-characters'

function fakeDatabase() {
  const state = { account: null, sessions: [], audit: [], recoveryTokens: [] }
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
      if (sql.includes('INSERT INTO public.tron_transfer_wallet_sessions')) { const now = new Date().toISOString(); state.sessions.push({ session_id: state.sessions.length + 1, wallet_role: 'sponsor', token_hash: params[1], csrf_hash: params[2], revoked_at: null, created_at: now, last_seen_at: now, expires_at: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString() }); return { rowCount: 1, rows: [] } }
      if (sql.includes('SELECT * FROM public.tron_transfer_wallet_accounts')) return { rows: state.account ? [state.account] : [] }
      if (sql.includes('UPDATE public.tron_transfer_wallet_sessions SET revoked_at=now()') && sql.includes("wallet_role='sponsor'") && sql.includes('session_id<>$1')) { let count=0; state.sessions.forEach(x => { if (x.wallet_role==='sponsor' && x.session_id!==Number(params[0]) && !x.revoked_at) { x.revoked_at=new Date(); count++ } }); return { rowCount: count, rows: state.sessions.filter(x=>x.wallet_role==='sponsor'&&x.session_id!==Number(params[0])&&x.revoked_at).map(x=>({session_id:x.session_id})) } }
      if (sql.includes('UPDATE public.tron_transfer_wallet_sessions SET revoked_at=now() WHERE wallet_role=\'sponsor\'')) { let count=0; state.sessions.forEach(x => { if (x.wallet_role==='sponsor' && !x.revoked_at) { x.revoked_at = new Date(); count++ } }); return { rowCount: count, rows: [] } }
      if (sql.includes('UPDATE public.tron_transfer_wallet_accounts SET failed_attempts=0')) { if (state.account) state.account.failed_attempts = 0; return { rowCount: 1, rows: [] } }
      if (sql.includes('UPDATE public.tron_transfer_wallet_accounts') && sql.includes('password_hash=$1')) { if (state.account) Object.assign(state.account,{password_hash:params[0],password_salt:params[1],password_algorithm:'scrypt',password_params:JSON.parse(params[2]),failed_attempts:0,locked_until:null}); return { rowCount: state.account?1:0, rows: state.account?[{wallet_address:state.account.wallet_address}]:[] } }
      if (sql.includes('SELECT recovery_token_id FROM public.tron_transfer_wallet_recovery_tokens')) { const row=state.recoveryTokens.find(x=>x.wallet_role==='sponsor'&&x.token_hash===params[0]&&!x.consumed_at); return {rows:row?[{recovery_token_id:row.recovery_token_id}]:[]} }
      if (sql.includes('UPDATE public.tron_transfer_wallet_recovery_tokens SET consumed_at=now()')) { const row=state.recoveryTokens.find(x=>x.recovery_token_id===params[0]); if(row)row.consumed_at=new Date(); return {rowCount:row?1:0,rows:[]} }
      if (sql.includes('SELECT session_id,created_at,last_seen_at,expires_at')) { const current=Number(params[0]); return {rows:state.sessions.filter(x=>x.wallet_role==='sponsor'&&!x.revoked_at&&Date.parse(x.expires_at)>Date.now()).map(x=>({session_id:x.session_id,created_at:x.created_at,last_seen_at:x.last_seen_at,expires_at:x.expires_at,current:x.session_id===current}))} }
      if (sql.includes('UPDATE public.tron_transfer_wallet_sessions SET revoked_at=now()') && sql.includes('WHERE session_id=$1')) { const row=state.sessions.find(x=>x.session_id===Number(params[0])&&x.wallet_role==='sponsor'&&!x.revoked_at); if(row)row.revoked_at=new Date(); return {rowCount:row?1:0,rows:row?[{session_id:row.session_id}]:[]} }
      if (sql.includes('UPDATE public.tron_transfer_wallet_sessions SET last_seen_at')) { const row=state.sessions.find(x=>x.session_id===Number(params[0])); if(row)row.last_seen_at=new Date().toISOString(); return { rowCount: row?1:0, rows: [] } }
      if (sql.includes('SELECT s.session_id')) { const row=state.sessions.find(x=>x.token_hash===params[0]&&x.wallet_role==='sponsor'&&!x.revoked_at&&Date.parse(x.expires_at)>Date.now()); return { rows: row&&state.account?[{session_id:row.session_id,csrf_hash:row.csrf_hash,wallet_address:state.account.wallet_address}]:[] } }
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
const identityReport = { owner: { ready: true, address: 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp' }, sponsor: { ready: true, address }, identitiesDistinct: true }

test('Sponsor wallet auth ignores paths outside its exact route namespace', async () => {
  const api = createSponsorWalletAuthApi({ env: {}, database: fakeDatabase(), send() {} })
  assert.equal(await api.handle(request('GET'), response(), new URL('https://api.test/api/wallet-auth/sponsorish/status'), null), false)
})

test('Sponsor session verifier rejects the other workspace cookie and enforces its own database role', async () => {
  const queries=[]
  const database={async query(sql){queries.push(sql);return {rows:[]}}}
  const api=createSponsorWalletAuthApi({env:{},database,send(){}})
  const foreignToken='a'.repeat(64)
  const otherCookie=await api.authenticateRequest({headers:{cookie:'tron_owner_session='+foreignToken}})
  assert.equal(otherCookie,null)
  const ownCookie=await api.authenticateRequest({headers:{cookie:'tron_sponsor_session='+foreignToken}})
  assert.equal(ownCookie,null)
  assert.equal(queries.length,1)
  assert.match(queries[0],/wallet_role='sponsor'/)
})

test('Sponsor enrollment requires backend bootstrap token and only succeeds once', async () => {
  const db = fakeDatabase()
  const api = createSponsorWalletAuthApi({ env: { TRON_SPONSOR_ENROLLMENT_TOKEN: bootstrap }, database: db, send: (res, status, payload) => { res.writeHead(status); res.end(JSON.stringify(payload)) }, identityReport })
  const denied = response()
  await api.handle(request('POST', {}, { password: 'a sufficiently long sponsor password 123' }), denied, new URL('https://api.test/api/wallet-auth/sponsor/enroll'), 'https://tron-transfer.onrender.com')
  assert.equal(denied.status, 403)
  assert.equal(db.state.account, null)

  const enrolled = response()
  await api.handle(request('POST', { 'x-sponsor-enrollment-token': bootstrap }, { password: 'a sufficiently long sponsor password 123' }), enrolled, new URL('https://api.test/api/wallet-auth/sponsor/enroll'), 'https://tron-transfer.onrender.com')
  assert.equal(enrolled.status, 201)
  assert.equal(db.state.account.wallet_address, address)
  assert.match(enrolled.headers['set-cookie'][0], /Path=\/; HttpOnly; Secure; SameSite=None/)
  assert.equal(db.state.sessions.length, 1)

  const repeated = response()
  await api.handle(request('POST', { 'x-sponsor-enrollment-token': bootstrap }, { password: 'another sufficiently long password 123' }), repeated, new URL('https://api.test/api/wallet-auth/sponsor/enroll'), 'https://tron-transfer.onrender.com')
  assert.equal(repeated.status, 409)
  assert.equal(db.state.sessions.length, 1)
})

test('Sponsor password login creates a new session and returns no private key material', async () => {
  const db = fakeDatabase()
  const verifier = await hashWalletPassword('correct sponsor password phrase 123')
  db.state.account = { wallet_address: address, password_hash: verifier.passwordHash, password_salt: verifier.passwordSalt, password_algorithm: verifier.passwordAlgorithm, password_params: verifier.passwordParams, enabled: true, failed_attempts: 0 }
  const api = createSponsorWalletAuthApi({ env: {}, database: db, send: (res, status, payload) => { res.writeHead(status); res.end(JSON.stringify(payload)) } })
  const res = response()
  await api.handle(request('POST', {}, { password: 'correct sponsor password phrase 123' }), res, new URL('https://api.test/api/wallet-auth/sponsor/login'), 'https://tron-transfer.onrender.com')
  assert.equal(res.status, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.address, address)
  assert.equal(payload.role, 'sponsor')
  assert.equal('privateKey' in payload, false)
  assert.equal(db.state.sessions.length, 1)
})

test('Sponsor login is rate-limited per validated client IP after ten attempts in fifteen minutes', async () => {
 const db=fakeDatabase()
 const verifier=await hashWalletPassword('correct sponsor password phrase 123')
 db.state.account={wallet_address:address,password_hash:verifier.passwordHash,password_salt:verifier.passwordSalt,password_algorithm:verifier.passwordAlgorithm,password_params:verifier.passwordParams,enabled:true,failed_attempts:0}
 const api=createSponsorWalletAuthApi({env:{},database:db,send:(res,status,payload)=>{res.writeHead(status);res.end(JSON.stringify(payload))}})
 for(let attempt=0;attempt<10;attempt+=1){
  const res=response()
  await api.handle(request('POST',{'cf-connecting-ip':'203.0.113.11'},{password:'correct sponsor password phrase 123'}),res,new URL('https://api.test/api/wallet-auth/sponsor/login'),'https://tron-transfer.onrender.com')
  assert.equal(res.status,200)
 }
 const limited=response()
 await api.handle(request('POST',{'cf-connecting-ip':'203.0.113.11'},{password:'correct sponsor password phrase 123'}),limited,new URL('https://api.test/api/wallet-auth/sponsor/login'),'https://tron-transfer.onrender.com')
 assert.equal(limited.status,429)
 assert.equal(JSON.parse(limited.body).error,'LOGIN_RATE_LIMITED')
})

function authHeaders(loginResponse) {
  const cookies=loginResponse.headers['set-cookie']
  const session=cookies.find(value=>value.startsWith('tron_sponsor_session=')).split(';')[0]
  const csrfCookie=cookies.find(value=>value.startsWith('tron_sponsor_csrf=')).split(';')[0]
  const csrf=decodeURIComponent(csrfCookie.slice('tron_sponsor_csrf='.length))
  return {cookie:session+'; '+csrfCookie,origin:'https://tron-transfer.onrender.com','x-csrf-token':csrf}
}

test('Sponsor password change rotates sessions and session listing is role-scoped',async()=>{
 const db=fakeDatabase()
 const verifier=await hashWalletPassword('current sponsor password phrase 123')
 db.state.account={wallet_address:address,password_hash:verifier.passwordHash,password_salt:verifier.passwordSalt,password_algorithm:verifier.passwordAlgorithm,password_params:verifier.passwordParams,enabled:true,failed_attempts:0}
 const api=createSponsorWalletAuthApi({env:{},database:db,send:(res,status,payload)=>{res.writeHead(status);res.end(JSON.stringify(payload))}})
 const login=response()
 await api.handle(request('POST',{}, {password:'current sponsor password phrase 123'}),login,new URL('https://api.test/api/wallet-auth/sponsor/login'),'https://tron-transfer.onrender.com')
 const headers=authHeaders(login)
 const listed=response()
 await api.handle(request('GET',headers),listed,new URL('https://api.test/api/wallet-auth/sponsor/sessions'),'https://tron-transfer.onrender.com')
 assert.equal(listed.status,200)
 assert.equal(JSON.parse(listed.body).sessions.length,1)
 assert.equal(JSON.parse(listed.body).sessions[0].current,true)
 const changed=response()
 await api.handle(request('POST',headers,{currentPassword:'current sponsor password phrase 123',newPassword:'new sponsor password phrase 456'}),changed,new URL('https://api.test/api/wallet-auth/sponsor/password/change'),'https://tron-transfer.onrender.com')
 assert.equal(changed.status,200)
 assert.equal(db.state.sessions.filter(x=>!x.revoked_at).length,1)
 assert.equal(db.state.sessions.filter(x=>x.revoked_at).length,1)
 assert.equal(await verifyWalletPassword('new sponsor password phrase 456',{passwordHash:db.state.account.password_hash,passwordSalt:db.state.account.password_salt,passwordAlgorithm:db.state.account.password_algorithm,passwordParams:db.state.account.password_params}),true)
 const newHeaders=authHeaders(changed)
 const newSession=response()
 await api.handle(request('GET',newHeaders),newSession,new URL('https://api.test/api/wallet-auth/sponsor/session'),'https://tron-transfer.onrender.com')
 assert.equal(newSession.status,200)
 assert.equal(JSON.parse(newSession.body).address,address)
})

test('Sponsor one-time recovery consumes only Sponsor token and revokes Sponsor sessions',async()=>{
 const db=fakeDatabase()
 const verifier=await hashWalletPassword('old sponsor password phrase 123')
 db.state.account={wallet_address:address,password_hash:verifier.passwordHash,password_salt:verifier.passwordSalt,password_algorithm:verifier.passwordAlgorithm,password_params:verifier.passwordParams,enabled:true,failed_attempts:0}
 db.state.sessions.push({session_id:1,wallet_role:'sponsor',token_hash:'old-token-hash',csrf_hash:'old-csrf-hash',revoked_at:null,created_at:new Date().toISOString(),last_seen_at:new Date().toISOString(),expires_at:new Date(Date.now()+3600000).toISOString()})
 const token='one-time-sponsor-recovery-token-with-enough-entropy-123456789'
 db.state.recoveryTokens.push({recovery_token_id:1,wallet_role:'sponsor',token_hash:createHash('sha256').update(token).digest('hex'),consumed_at:null})
 const api=createSponsorWalletAuthApi({env:{},database:db,send:(res,status,payload)=>{res.writeHead(status);res.end(JSON.stringify(payload))}})
 const recovered=response()
 await api.handle(request('POST',{origin:'https://tron-transfer.onrender.com'},{recoveryToken:token,newPassword:'recovered sponsor password phrase 789'}),recovered,new URL('https://api.test/api/wallet-auth/sponsor/recover'),'https://tron-transfer.onrender.com')
 assert.equal(recovered.status,200)
 assert.equal(JSON.parse(recovered.body).passwordRecovered,true)
 assert.ok(db.state.recoveryTokens[0].consumed_at)
 assert.ok(db.state.sessions[0].revoked_at)
 assert.equal(await verifyWalletPassword('recovered sponsor password phrase 789',{passwordHash:db.state.account.password_hash,passwordSalt:db.state.account.password_salt,passwordAlgorithm:db.state.account.password_algorithm,passwordParams:db.state.account.password_params}),true)
})


test('Sponsor session revocation cannot revoke the current session and can revoke other sessions',async()=>{
 const db=fakeDatabase()
 const verifier=await hashWalletPassword('current sponsor password phrase 123')
 db.state.account={wallet_address:address,password_hash:verifier.passwordHash,password_salt:verifier.passwordSalt,password_algorithm:verifier.passwordAlgorithm,password_params:verifier.passwordParams,enabled:true,failed_attempts:0}
 const api=createSponsorWalletAuthApi({env:{},database:db,send:(res,status,payload)=>{res.writeHead(status);res.end(JSON.stringify(payload))}})
 const login=response()
 await api.handle(request('POST',{}, {password:'current sponsor password phrase 123'}),login,new URL('https://api.test/api/wallet-auth/sponsor/login'),'https://tron-transfer.onrender.com')
 const headers=authHeaders(login)
 db.state.sessions.push({session_id:99,wallet_role:'sponsor',token_hash:'other-token-hash',csrf_hash:'other-csrf-hash',revoked_at:null,created_at:new Date().toISOString(),last_seen_at:new Date().toISOString(),expires_at:new Date(Date.now()+3600000).toISOString()})
 const one=response()
 await api.handle(request('POST',headers,{}),one,new URL('https://api.test/api/wallet-auth/sponsor/sessions/99/revoke'),'https://tron-transfer.onrender.com')
 assert.equal(one.status,200)
 assert.ok(db.state.sessions.find(x=>x.session_id===99).revoked_at)
 assert.equal(db.state.sessions.find(x=>x.session_id===1).revoked_at,null)
 db.state.sessions.push({session_id:100,wallet_role:'sponsor',token_hash:'another-token-hash',csrf_hash:'another-csrf-hash',revoked_at:null,created_at:new Date().toISOString(),last_seen_at:new Date().toISOString(),expires_at:new Date(Date.now()+3600000).toISOString()})
 const others=response()
 await api.handle(request('POST',headers,{}),others,new URL('https://api.test/api/wallet-auth/sponsor/sessions/revoke-others'),'https://tron-transfer.onrender.com')
 assert.equal(others.status,200)
 assert.equal(JSON.parse(others.body).revokedCount,1)
 assert.equal(db.state.sessions.find(x=>x.session_id===1).revoked_at,null)
 assert.ok(db.state.sessions.find(x=>x.session_id===100).revoked_at)
})
