import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { TronWeb, Trx } from 'tronweb'
import pg from 'pg'
import { sponsorDatabaseConnectionString } from './sponsor-api.mjs'
import { normalizePostgresTlsMode } from './scripts/sponsor-ledger-database-identity.mjs'
import { getMainnetAccountResourceSnapshot, estimateMainnetContractCallEnergy, waitForSolidifiedReceipt } from '../src/trax-mainnet.mjs'
import { calculateDeploymentResourceBudget, assertZeroTrxBurnBudget, assertTransactionIntegrity, verifyTransactionSigner, assertTransactionPermission } from '../src/tron-mainnet-preflight.mjs'

const { Pool } = pg
const COOKIE = 'tron_pending_owner_session'
const CSRF = 'tron_pending_owner_csrf'
const ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const TXID = /^[0-9a-f]{64}$/i
const PREPARE = 'PREPARE TRӾ OWNERSHIP ACCEPTANCE'
const CONFIRM = 'CONFIRM TRӾ OWNERSHIP ACCEPTANCE'
const ABI = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'pendingOwner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'acceptOwnership', stateMutability: 'nonpayable', inputs: [], outputs: [] },
]
const hash = value => createHash('sha256').update(String(value), 'utf8').digest('hex')
function fail(code, status=400) { throw Object.assign(new Error(code), { code, status }) }
function eqHex(a,b) {
  if (!/^[0-9a-f]{64}$/.test(String(a||'')) || !/^[0-9a-f]{64}$/.test(String(b||''))) return false
  return timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'))
}
function sameAddress(t,a,b) { try { return t.address.toHex(String(a)).toLowerCase()===t.address.toHex(String(b)).toLowerCase() } catch { return false } }
function cookie(req,name) {
  const p=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))
  try { return p?decodeURIComponent(p.slice(name.length+1)):'' } catch { return '' }
}
function cookies(res,token,csrf) {
  res.setHeader('set-cookie',[
    COOKIE+'='+encodeURIComponent(token)+'; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=1800',
    CSRF+'='+encodeURIComponent(csrf)+'; Path=/; Secure; SameSite=None; Max-Age=1800',
  ])
}
function clearCookies(res) { res.setHeader('set-cookie',[COOKIE+'=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0',CSRF+'=; Path=/; Secure; SameSite=None; Max-Age=0']) }
async function body(req,max=131072) {
  const chunks=[];let size=0
  for await(const chunk of req){size+=chunk.length;if(size>max)fail('PENDING_OWNER_REQUEST_TOO_LARGE',413);chunks.push(chunk)}
  try{const v=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');if(!v||typeof v!=='object'||Array.isArray(v))throw Error();return v}catch{fail('PENDING_OWNER_INVALID_JSON')}
}
function challengeMessage({address,contract,origin,nonce,issued,expires}) {
  return ['TRON TRANSFER · TRӾ pending-owner authentication','Purpose: prove control of the exact proposed pending-owner address for one TRӾ ownership acceptance workflow.','Network: TRON Mainnet','Contract: '+contract,'Pending owner: '+address,'Origin: '+origin,'Nonce: '+nonce,'Issued At: '+new Date(issued).toISOString(),'Expires At: '+new Date(expires).toISOString(),'No transaction is authorized by this message.'].join('\n')
}

export function createPendingOwnerAcceptanceApi({
  env=process.env,send,database,fetchImpl=fetch,tronWebFactory=options=>new TronWeb(options),
  verifyMessage=(message,signature)=>Trx.verifyMessageV2(message,signature),
  estimateEnergy=estimateMainnetContractCallEnergy,readResources=getMainnetAccountResourceSnapshot,
  calculateBudget=calculateDeploymentResourceBudget,assertBudget=assertZeroTrxBurnBudget,
  checkIntegrity=assertTransactionIntegrity,checkSigner=verifyTransactionSigner,
  checkPermission=assertTransactionPermission,waitForReceipt=waitForSolidifiedReceipt,
}={}) {
  if(typeof send!=='function')throw new TypeError('Pending-owner response adapter required')
  let pool=database||null
  function db() {
    if(pool)return pool
    const connection=sponsorDatabaseConnectionString(env);if(!connection)return null
    pool=new Pool({connectionString:normalizePostgresTlsMode(connection),connectionTimeoutMillis:2500,query_timeout:2500,statement_timeout:2000,idleTimeoutMillis:30000,max:3})
    pool.on('error',e=>process.stderr.write('Pending-owner database error: '+String(e?.code||'unknown')+'\n'))
    return pool
  }
  const origins=new Set(['https://tron-transfer.onrender.com','http://localhost:5173','http://127.0.0.1:5173'])
  const contract=()=>String(env.TRAX_CONTRACT_ADDRESS||'').trim()
  function tron() {
    const host=env.TATUM_API_KEY&&String(env.TATUM_TRON_NETWORK||'mainnet').toLowerCase()==='mainnet'?'https://tron-mainnet.gateway.tatum.io':'https://api.trongrid.io'
    const t=tronWebFactory({fullHost:host})
    t.fullNode.headers=host.includes('tatum')?{'x-api-key':String(env.TATUM_API_KEY).trim()}:(env.TRONGRID_API_KEY?{'TRON-PRO-API-KEY':String(env.TRONGRID_API_KEY).trim()}: {})
    return t
  }
  async function chain(t) {
    const address=contract();if(!t.isAddress(address))fail('TRAX_CONTRACT_ADDRESS_NOT_CONFIGURED',503)
    const token=await t.contract(ABI).at(address)
    const [owner,pendingOwner]=await Promise.all([token.owner().call(),token.pendingOwner().call()])
    return {contractAddress:address,owner:String(owner),pendingOwner:String(pendingOwner)}
  }
  async function auth(req,dbx,csrf=false) {
    const token=cookie(req,COOKIE);if(!token)return null
    const r=await dbx.query('SELECT session_id,csrf_hash,contract_address,pending_owner_address,origin FROM public.tron_transfer_pending_owner_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()',[hash(token)])
    const s=r.rows?.[0];if(!s||s.origin!==String(req.headers.origin||''))return null
    if(csrf&&(!eqHex(hash(String(req.headers['x-csrf-token']||'')),s.csrf_hash)||!origins.has(s.origin)))return null
    await dbx.query('UPDATE public.tron_transfer_pending_owner_sessions SET last_seen_at=now() WHERE session_id=$1',[s.session_id])
    return {sessionId:s.session_id,address:s.pending_owner_address,contractAddress:s.contract_address,origin:s.origin,csrfHash:s.csrf_hash}
  }
  async function preflight(t,address,tx,feeLimitSun) {
    const data=String(tx?.raw_data?.contract?.[0]?.parameter?.value?.data||'').replace(/^0x/i,'')
    const [estimate,resources]=await Promise.all([estimateEnergy(t,contract(),data,address),readResources(t,address)])
    const budget=calculateBudget({energyRequired:estimate.energyUsed,resourceSnapshot:resources,rawDataHex:tx.raw_data_hex,feeLimitSun,safetyMarginBps:12500,transactionLabel:'TRӾ pending-owner acceptance'})
    assertBudget(budget)
    return {estimate,resources,budget,checkedAt:new Date().toISOString()}
  }
  async function rpc(t,path,payload) {
    const host=String(t.fullNode?.host||'').replace(/\/+$/,'')
    const r=await fetchImpl(host+path,{method:'POST',headers:{'content-type':'application/json',accept:'application/json',...(t.fullNode?.headers||{})},body:JSON.stringify(payload),signal:AbortSignal.timeout(8000),redirect:'error'})
    const data=await r.json().catch(()=>({}))
    if(!r.ok||data?.Error||data?.error)fail('PENDING_OWNER_MAINNET_RPC_FAILED',503)
    return data
  }
  async function handle(req,res,url,origin) {
    const p=url.pathname
    const statePath=p==='/api/pending-owner/state',challengePath=p==='/api/pending-owner/challenge',verifyPath=p==='/api/pending-owner/verify'
    const sessionPath=p==='/api/pending-owner/session',preparePath=p==='/api/pending-owner/prepare',confirmPath=p==='/api/pending-owner/confirm',logoutPath=p==='/api/pending-owner/logout'
    const status=p.match(/^\/api\/pending-owner\/operations\/([0-9a-f-]{36})$/i)
    if(![statePath,challengePath,verifyPath,sessionPath,preparePath,confirmPath,logoutPath].some(Boolean)&&!status)return false
    const databaseApi=db();if(!databaseApi)return send(res,503,{error:'PENDING_OWNER_DATABASE_UNAVAILABLE'},origin)
    let claimedOperationId = null
    try {
      if(statePath&&req.method==='GET'){
        const t=tron(),s=await chain(t),zero='T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'
        return send(res,200,{success:true,network:'TRON Mainnet',contractAddress:s.contractAddress,owner:s.owner,pendingOwner:s.pendingOwner,pendingOwnerAvailable:t.isAddress(s.pendingOwner)&&!sameAddress(t,s.pendingOwner,zero)},origin)
      }
      if(challengePath&&req.method==='POST'){
        const o=String(req.headers.origin||'');if(!origins.has(o))return send(res,403,{error:'PENDING_OWNER_ORIGIN_NOT_ALLOWED'},origin)
        const input=await body(req,8192),address=String(input.address||'').trim()
        if(Object.keys(input).some(k=>k!=='address')||!ADDRESS.test(address))return send(res,400,{error:'PENDING_OWNER_ADDRESS_INVALID'},origin)
        const t=tron(),s=await chain(t)
        if(!sameAddress(t,s.pendingOwner,address)||sameAddress(t,s.owner,address))return send(res,403,{error:'ADDRESS_IS_NOT_CURRENT_PENDING_OWNER'},origin)
        const rate=await databaseApi.query("SELECT count(*)::int AS count FROM public.tron_transfer_pending_owner_challenges WHERE pending_owner_address=$1 AND created_at>now()-interval '15 minutes'",[address])
        if(Number(rate.rows?.[0]?.count||0)>=5)return send(res,429,{error:'PENDING_OWNER_CHALLENGE_RATE_LIMITED'},origin)
        const nonce=randomBytes(32).toString('hex'),issued=Date.now(),expires=issued+300000
        const message=challengeMessage({address,contract:s.contractAddress,origin:o,nonce,issued,expires})
        await databaseApi.query('INSERT INTO public.tron_transfer_pending_owner_challenges (challenge_id,contract_address,pending_owner_address,origin,nonce_hash,message_hash,issued_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7/1000.0),to_timestamp($8/1000.0))',[randomUUID(),s.contractAddress,address,o,hash(nonce),hash(message),issued,expires])
        return send(res,200,{success:true,address,contractAddress:s.contractAddress,nonce,message,expiresAt:expires},origin)
      }
      if(verifyPath&&req.method==='POST'){
        const o=String(req.headers.origin||'');if(!origins.has(o))return send(res,403,{error:'PENDING_OWNER_ORIGIN_NOT_ALLOWED'},origin)
        const input=await body(req,8192),address=String(input.address||''),nonce=String(input.nonce||''),signature=String(input.signature||'')
        if(Object.keys(input).some(k=>!['address','nonce','signature'].includes(k))||!ADDRESS.test(address)||!/^[0-9a-f]{64}$/.test(nonce)||!/^0x[0-9a-f]{130}$/i.test(signature))return send(res,400,{error:'PENDING_OWNER_SIGNATURE_INPUT_INVALID'},origin)
        const consumed=await databaseApi.query('UPDATE public.tron_transfer_pending_owner_challenges SET consumed_at=now() WHERE nonce_hash=$1 AND consumed_at IS NULL AND expires_at>now() AND origin=$2 AND pending_owner_address=$3 RETURNING *',[hash(nonce),o,address])
        const c=consumed.rows?.[0];if(!c)return send(res,401,{error:'PENDING_OWNER_CHALLENGE_EXPIRED_OR_USED'},origin)
        const message=challengeMessage({address,contract:c.contract_address,origin:o,nonce,issued:new Date(c.issued_at).getTime(),expires:new Date(c.expires_at).getTime()})
        if(!eqHex(hash(message),c.message_hash))return send(res,401,{error:'PENDING_OWNER_CHALLENGE_MESSAGE_MISMATCH'},origin)
        let recovered='';try{recovered=await verifyMessage(message,signature)}catch{}
        if(recovered!==address)return send(res,401,{error:'PENDING_OWNER_SIGNATURE_INVALID'},origin)
        const t=tron(),s=await chain(t)
        if(!sameAddress(t,s.pendingOwner,address)||s.contractAddress!==c.contract_address)return send(res,409,{error:'PENDING_OWNER_PROPOSAL_CHANGED'},origin)
        const token=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url'),id=randomUUID()
        await databaseApi.query("INSERT INTO public.tron_transfer_pending_owner_sessions (session_id,token_hash,csrf_hash,contract_address,pending_owner_address,origin,expires_at) VALUES ($1,$2,$3,$4,$5,$6,now()+interval '30 minutes')",[id,hash(token),hash(csrf),s.contractAddress,address,o])
        cookies(res,token,csrf)
        return send(res,200,{success:true,authenticated:true,address,contractAddress:s.contractAddress,csrfToken:csrf,expiresInSeconds:1800},origin)
      }
      if(sessionPath&&req.method==='GET'){
        const s=await auth(req,databaseApi);if(!s)return send(res,401,{error:'PENDING_OWNER_SESSION_REQUIRED'},origin)
        const old=cookie(req,CSRF),csrf=old&&eqHex(hash(old),s.csrfHash)?old:randomBytes(32).toString('base64url')
        if(csrf!==old)await databaseApi.query('UPDATE public.tron_transfer_pending_owner_sessions SET csrf_hash=$2 WHERE session_id=$1',[s.sessionId,hash(csrf)])
        res.setHeader('set-cookie',CSRF+'='+encodeURIComponent(csrf)+'; Path=/; Secure; SameSite=None; Max-Age=1800')
        return send(res,200,{success:true,authenticated:true,address:s.address,contractAddress:s.contractAddress,csrfToken:csrf},origin)
      }
      if(preparePath&&req.method==='POST'){
        const s=await auth(req,databaseApi,true);if(!s)return send(res,401,{error:'PENDING_OWNER_SESSION_REQUIRED'},origin)
        const input=await body(req,8192),key=String(input.idempotencyKey||''),fee=String(input.feeLimitSun||env.TRAX_ACCEPT_OWNERSHIP_FEE_LIMIT_SUN||'150000000')
        if(input.confirmationPhrase!==PREPARE||!/^[A-Za-z0-9._:-]{16,160}$/.test(key)||!/^[1-9][0-9]{0,11}$/.test(fee))return send(res,400,{error:'PENDING_OWNER_PREPARATION_INPUT_INVALID'},origin)
        if(BigInt(fee)>BigInt(env.TRAX_ACCEPT_OWNERSHIP_MAX_FEE_LIMIT_SUN||'150000000'))return send(res,400,{error:'PENDING_OWNER_FEE_LIMIT_ABOVE_POLICY'},origin)
        const prior=await databaseApi.query('SELECT operation_id,state,transaction_id,intent,intent_sha256 FROM public.tron_transfer_pending_owner_acceptances WHERE pending_owner_address=$1 AND idempotency_key=$2',[s.address,key])
        if(prior.rows?.[0]){const old=prior.rows[0];if(old.intent?.feeLimitSun!==fee||old.intent?.pendingOwner!==s.address||old.intent?.contractAddress!==s.contractAddress)return send(res,409,{error:'PENDING_OWNER_IDEMPOTENCY_CONFLICT'},origin);return send(res,200,{success:true,replay:true,operation:old},origin)}
        const t=tron(),chainNow=await chain(t)
        if(!sameAddress(t,chainNow.pendingOwner,s.address)||chainNow.contractAddress!==s.contractAddress)return send(res,409,{error:'PENDING_OWNER_PROPOSAL_CHANGED'},origin)
        const selector=String(t.sha3('acceptOwnership()')).replace(/^0x/i,'').slice(0,8).toLowerCase()
        const built=await t.transactionBuilder.triggerSmartContract(s.contractAddress,'acceptOwnership()',{feeLimit:Number(fee),callValue:0,from:s.address,funcABIV2:ABI[2],parametersV2:[]},[],t.address.toHex(s.address))
        const unsigned=built?.transaction||built
        if(!built?.result?.result||!TXID.test(String(unsigned?.txID||''))||!unsigned?.raw_data_hex)fail('PENDING_OWNER_UNSIGNED_TRANSACTION_INVALID',503)
        checkIntegrity(t,unsigned,'Unsigned TRӾ ownership acceptance')
        const value=unsigned.raw_data.contract?.[0]?.parameter?.value||{}
        if(unsigned.raw_data.contract?.length!==1||unsigned.raw_data.contract[0]?.type!=='TriggerSmartContract'||!sameAddress(t,t.address.fromHex(value.owner_address),s.address)||!sameAddress(t,t.address.fromHex(value.contract_address),s.contractAddress)||!String(value.data||'').toLowerCase().startsWith(selector)||Number(value.call_value||0)!==0||Number(unsigned.raw_data.fee_limit)!==Number(fee))fail('PENDING_OWNER_UNSIGNED_INTENT_MISMATCH',409)
        const pre=await preflight(t,s.address,unsigned,fee)
        const intent={network:'TRON Mainnet',contractAddress:s.contractAddress,pendingOwner:s.address,method:'acceptOwnership()',feeLimitSun:fee,transactionId:unsigned.txID}
        const intentHash=hash(JSON.stringify(intent)),operationId=randomUUID()
        const inserted=await databaseApi.query("INSERT INTO public.tron_transfer_pending_owner_acceptances (operation_id,session_id,contract_address,pending_owner_address,idempotency_key,intent,intent_sha256,transaction_id,unsigned_transaction,preflight,state) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,$10::jsonb,'prepared') ON CONFLICT (pending_owner_address,idempotency_key) DO NOTHING RETURNING operation_id,state,transaction_id,intent_sha256,created_at",[operationId,s.sessionId,s.contractAddress,s.address,key,JSON.stringify(intent),intentHash,unsigned.txID,JSON.stringify(unsigned),JSON.stringify(pre)])
        if(!inserted.rows?.[0])return send(res,409,{error:'PENDING_OWNER_IDEMPOTENCY_CONFLICT'},origin)
        return send(res,201,{success:true,operation:inserted.rows[0],intent,intentSha256:intentHash,unsignedTransaction:unsigned,preflight:pre,confirmationPhrase:CONFIRM},origin)
      }
      if(confirmPath&&req.method==='POST'){
        const s=await auth(req,databaseApi,true);if(!s)return send(res,401,{error:'PENDING_OWNER_SESSION_REQUIRED'},origin)
        const input=await body(req),id=String(input.operationId||''),intentHash=String(input.intentSha256||''),signed=input.signedTransaction
        if(input.confirmationPhrase!==CONFIRM||!/^[0-9a-f-]{36}$/i.test(id)||!/^[0-9a-f]{64}$/.test(intentHash))return send(res,400,{error:'PENDING_OWNER_CONFIRMATION_INVALID'},origin)
        const claim=await databaseApi.query("UPDATE public.tron_transfer_pending_owner_acceptances SET state='confirming',updated_at=now() WHERE operation_id=$1 AND pending_owner_address=$2 AND session_id=$3 AND intent_sha256=$4 AND state='prepared' RETURNING *",[id,s.address,s.sessionId,intentHash])
        const row=claim.rows?.[0];if(!row)return send(res,409,{error:'PENDING_OWNER_OPERATION_NOT_CONFIRMABLE'},origin)
        claimedOperationId = id
        const t=tron(),chainNow=await chain(t)
        if(!sameAddress(t,chainNow.pendingOwner,s.address)||chainNow.contractAddress!==s.contractAddress)fail('PENDING_OWNER_PROPOSAL_CHANGED',409)
        checkIntegrity(t,row.unsigned_transaction,'Persisted pending-owner unsigned transaction')
        checkIntegrity(t,signed,'Signed pending-owner transaction')
        if(String(signed?.txID||'').toLowerCase()!==row.transaction_id.toLowerCase()||String(signed?.raw_data_hex||'').toLowerCase()!==String(row.unsigned_transaction.raw_data_hex).toLowerCase())fail('PENDING_OWNER_SIGNED_TRANSACTION_MISMATCH',409)
        await checkSigner(t,signed,s.address);await checkPermission(t,signed,s.address)
        const timestamp=Number(signed.raw_data?.timestamp),expiration=Number(signed.raw_data?.expiration),now=Date.now()
        if(!Number.isSafeInteger(timestamp)||!Number.isSafeInteger(expiration)||timestamp<=0||timestamp>now+30000||expiration<=now+5000||expiration<=timestamp||expiration>now+10*60_000||Number(signed.raw_data?.fee_limit)!==Number(row.intent.feeLimitSun))fail('PENDING_OWNER_SIGNED_TRANSACTION_TIME_OR_FEE_INVALID',409)
        const method=String(t.sha3('acceptOwnership()')).replace(/^0x/i,'').slice(0,8).toLowerCase()
        const v=signed.raw_data.contract?.[0]?.parameter?.value||{}
        if(signed.raw_data.contract?.length!==1||signed.raw_data.contract[0]?.type!=='TriggerSmartContract'||!sameAddress(t,t.address.fromHex(v.owner_address),s.address)||!sameAddress(t,t.address.fromHex(v.contract_address),s.contractAddress)||!String(v.data||'').toLowerCase().startsWith(method)||Number(v.call_value||0)!==0)fail('PENDING_OWNER_SIGNED_METHOD_MISMATCH',409)
        const fresh=await preflight(t,s.address,signed,String(row.intent.feeLimitSun))
        const saved=await databaseApi.query("UPDATE public.tron_transfer_pending_owner_acceptances SET signed_transaction=$2::jsonb,state='signed',signed_at=now(),updated_at=now() WHERE operation_id=$1 AND state='confirming' RETURNING operation_id",[id,JSON.stringify(signed)])
        if(!saved.rows?.[0])fail('PENDING_OWNER_SIGNED_TRANSACTION_NOT_PERSISTED',503)
        const unknown=await databaseApi.query("UPDATE public.tron_transfer_pending_owner_acceptances SET state='broadcast-unknown',preflight=preflight || $2::jsonb,updated_at=now() WHERE operation_id=$1 AND state='signed' RETURNING operation_id",[id,JSON.stringify({finalPreflight:fresh})])
        if(!unknown.rows?.[0])fail('PENDING_OWNER_BROADCAST_INTENT_NOT_PERSISTED',503)
        let broadcast
        try{broadcast=await t.trx.sendRawTransaction(signed)}catch(e){await databaseApi.query("UPDATE public.tron_transfer_pending_owner_acceptances SET failure_code=$2,updated_at=now() WHERE operation_id=$1 AND state='broadcast-unknown'",[id,String(e?.code||'BROADCAST_RESPONSE_UNKNOWN').slice(0,120)]).catch(()=>{});return send(res,202,{success:true,operation:{operationId:id,state:'broadcast-unknown',transactionId:row.transaction_id},recovery:{automaticRebroadcast:false}},origin)}
        if(broadcast?.txid&&String(broadcast.txid).toLowerCase()!==String(row.transaction_id).toLowerCase()){await databaseApi.query("UPDATE public.tron_transfer_pending_owner_acceptances SET failure_code='BROADCAST_TXID_MISMATCH',updated_at=now() WHERE operation_id=$1 AND state='broadcast-unknown'",[id]).catch(()=>{});return send(res,202,{success:true,operation:{operationId:id,state:'broadcast-unknown',transactionId:row.transaction_id},recovery:{automaticRebroadcast:false}},origin)}
        if(broadcast?.result!==true){await databaseApi.query("UPDATE public.tron_transfer_pending_owner_acceptances SET failure_code=$2,updated_at=now() WHERE operation_id=$1 AND state='broadcast-unknown'",[id,String(broadcast?.code||broadcast?.message||'NODE_REJECTED_BROADCAST').slice(0,120)]).catch(()=>{});return send(res,202,{success:true,operation:{operationId:id,state:'broadcast-unknown',transactionId:row.transaction_id},recovery:{automaticRebroadcast:false}},origin)}
        await databaseApi.query("UPDATE public.tron_transfer_pending_owner_acceptances SET state='broadcast',broadcast_at=now(),updated_at=now() WHERE operation_id=$1 AND state='broadcast-unknown'",[id])
        return send(res,202,{success:true,operation:{operationId:id,state:'broadcast',transactionId:row.transaction_id},recovery:{automaticRebroadcast:false}},origin)
      }
      if(status&&req.method==='GET'){
        const s=await auth(req,databaseApi);if(!s)return send(res,401,{error:'PENDING_OWNER_SESSION_REQUIRED'},origin)
        const r=await databaseApi.query('SELECT operation_id,contract_address,pending_owner_address,idempotency_key,intent,intent_sha256,transaction_id,preflight,receipt,state,failure_code,created_at,updated_at,confirmed_at,unsigned_transaction FROM public.tron_transfer_pending_owner_acceptances WHERE operation_id=$1 AND pending_owner_address=$2 AND contract_address=$3',[status[1],s.address,s.contractAddress])
        let row=r.rows?.[0];if(!row)return send(res,404,{error:'PENDING_OWNER_OPERATION_NOT_FOUND'},origin)
        if(row.state==='confirming'&&Date.now()-new Date(row.updated_at).getTime()>5*60_000){
          const stale=await databaseApi.query("UPDATE public.tron_transfer_pending_owner_acceptances SET state='failed',failure_code='PENDING_OWNER_CONFIRMATION_INTERRUPTED_BEFORE_SIGN_PERSISTENCE',updated_at=now() WHERE operation_id=$1 AND state='confirming' RETURNING state,failure_code,updated_at",[row.operation_id])
          if(stale.rows?.[0])row={...row,...stale.rows[0]}
        }
        const {unsigned_transaction:_unsigned,...safe}=row
        if(['signed','broadcast-unknown','broadcast'].includes(row.state)){
          try{
            const t=tron(),tx=await rpc(t,'/walletsolidity/gettransactionbyid',{value:row.transaction_id}),receipt=await waitForReceipt(t,row.transaction_id,{timeoutMs:20000,intervalMs:2000})
            if(String(tx.txID||tx.txid||'').toLowerCase()!==row.transaction_id.toLowerCase()||String(tx.raw_data_hex||'').toLowerCase()!==String(row.unsigned_transaction.raw_data_hex).toLowerCase())fail('PENDING_OWNER_SOLIDIFIED_TRANSACTION_MISMATCH',409)
            checkIntegrity(t,tx,'Solidified pending-owner transaction');await checkSigner(t,tx,s.address)
            const c=tx.raw_data.contract?.[0],v=c?.parameter?.value||{},selector=String(t.sha3('acceptOwnership()')).replace(/^0x/i,'').slice(0,8).toLowerCase()
            if(tx.raw_data.contract.length!==1||c.type!=='TriggerSmartContract'||!sameAddress(t,t.address.fromHex(v.owner_address),s.address)||!sameAddress(t,t.address.fromHex(v.contract_address),s.contractAddress)||!String(v.data||'').toLowerCase().startsWith(selector)||Number(v.call_value||0)!==0||receipt?.id?.toLowerCase()!==row.transaction_id.toLowerCase()||receipt?.receipt?.result!=='SUCCESS')fail('PENDING_OWNER_SOLIDIFIED_RECEIPT_INVALID',409)
            const chainNow=await chain(t)
            const zero='T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'
            if(!sameAddress(t,chainNow.owner,s.address)||!sameAddress(t,chainNow.pendingOwner,zero))return send(res,202,{success:true,operation:safe,recovery:{available:true,solidified:false,automaticRebroadcast:false}},origin)
            const confirmed=await databaseApi.query("UPDATE public.tron_transfer_pending_owner_acceptances SET state='confirmed',receipt=$2::jsonb,confirmed_at=now(),updated_at=now(),failure_code=NULL WHERE operation_id=$1 AND state IN ('signed','broadcast-unknown','broadcast') RETURNING operation_id,state,transaction_id,confirmed_at",[row.operation_id,JSON.stringify({receipt,transaction:tx,owner:chainNow.owner,pendingOwner:chainNow.pendingOwner,verifiedAt:new Date().toISOString()})])
            if(!confirmed.rows?.[0])fail('PENDING_OWNER_CONFIRMATION_NOT_DURABLY_PERSISTED',503)
            return send(res,200,{success:true,operation:{...safe,...confirmed.rows[0]},recovery:{available:false,solidified:true,ownerVerified:true,pendingOwnerCleared:true,automaticRebroadcast:false}},origin)
          }catch(e){return send(res,202,{success:true,operation:safe,recovery:{available:true,solidified:false,automaticRebroadcast:false},message:String(e?.message||'Solidified acceptance not yet available').slice(0,200)},origin)}
        }
        return send(res,200,{success:true,operation:safe,recovery:{available:false,automaticRebroadcast:false}},origin)
      }
      if(logoutPath&&req.method==='POST'){
        const s=await auth(req,databaseApi,true);if(s)await databaseApi.query('UPDATE public.tron_transfer_pending_owner_sessions SET revoked_at=now() WHERE session_id=$1',[s.sessionId])
        clearCookies(res);return send(res,200,{success:true,loggedOut:true},origin)
      }
      return send(res,405,{error:'METHOD_NOT_ALLOWED'},origin)
    }catch(e){
      if(claimedOperationId){
        await databaseApi.query("UPDATE public.tron_transfer_pending_owner_acceptances SET state='failed',failure_code=$2,updated_at=now() WHERE operation_id=$1 AND state='confirming'",[claimedOperationId,String(e?.code||e?.message||'PENDING_OWNER_CONFIRMATION_FAILED').slice(0,120)]).catch(()=>{})
      }
      return send(res,Number.isInteger(e?.status)?e.status:503,{error:e?.code||'PENDING_OWNER_API_FAILED',message:String(e?.message||'Pending-owner request failed').slice(0,220)},origin)
    }
  }
  return Object.freeze({handle,authenticateRequest:async(req,options={})=>{const databaseApi=db();if(!databaseApi)return null;try{return await auth(req,databaseApi,options.requireCsrf===true)}catch{return null}}})
}
