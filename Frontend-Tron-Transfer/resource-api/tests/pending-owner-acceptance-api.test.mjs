import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createPendingOwnerAcceptanceApi } from '../pending-owner-acceptance-api.mjs'
const owner='TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const pending='TQk5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwA'
const contract='TQk5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwB'
const hash=v=>createHash('sha256').update(String(v),'utf8').digest('hex')
function req(method='GET',body={},headers={}){return{method,headers,async *[Symbol.asyncIterator](){if(method==='POST')yield Buffer.from(JSON.stringify(body))}}}
function res(){return{headers:{},setHeader(k,v){this.headers[k]=v},writeHead(){},end(){}}}
function fakeTron(){return{fullNode:{host:'https://api.trongrid.io',headers:{}},isAddress:()=>true,address:{toHex:v=>String(v),fromHex:v=>String(v)},sha3:()=> '0x12345678',contract:()=>({at:async()=>({owner:()=>({call:async()=>owner}),pendingOwner:()=>({call:async()=>pending})})}),trx:{sendRawTransaction:async()=>({result:true})}}}
test('pending-owner challenge is bound to the live pendingOwner and verifies one signed message',async()=>{
 let stored
 const db={async query(sql,p=[]){
  if(sql.includes('SELECT count(*)'))return{rows:[{count:0}]}
  if(sql.includes('INSERT INTO public.tron_transfer_pending_owner_challenges')){stored={contract_address:contract,pending_owner_address:pending,origin:'https://tron-transfer.onrender.com',message_hash:p[5],issued_at:new Date(Number(p[6])).toISOString(),expires_at:new Date(Number(p[7])).toISOString()};return{rows:[]}}
  if(sql.includes('UPDATE public.tron_transfer_pending_owner_challenges'))return{rows:[stored]}
  return{rows:[]}
 }}
 const out=[],origin='https://tron-transfer.onrender.com'
 const api=createPendingOwnerAcceptanceApi({database:db,env:{TRAX_CONTRACT_ADDRESS:contract},send:(_r,status,payload)=>out.push({status,payload}),tronWebFactory:fakeTron,verifyMessage:async()=>pending})
 await api.handle(req('POST',{address:pending},{origin}),res(),new URL('https://api.test/api/pending-owner/challenge'),origin)
 assert.equal(out[0].status,200)
 const c=out[0].payload
 await api.handle(req('POST',{address:pending,nonce:c.nonce,signature:'0x'+'a'.repeat(130)},{origin}),res(),new URL('https://api.test/api/pending-owner/verify'),origin)
 assert.equal(out[1].status,200)
 assert.equal(out[1].payload.authenticated,true)
 assert.equal(out[1].payload.address,pending)
})

test('pending-owner acceptance persists signature and broadcast-unknown state before network broadcast',async()=>{
 const events=[],txid='a'.repeat(64),raw='bb'.repeat(32),origin='https://tron-transfer.onrender.com',csrf='csrf-token'
 const unsigned={txID:txid,raw_data_hex:raw,raw_data:{timestamp:Date.now(),expiration:Date.now()+120000,fee_limit:150000000,contract:[{type:'TriggerSmartContract',parameter:{value:{owner_address:pending,contract_address:contract,data:'12345678',call_value:0}}}]}}
 const signed={...unsigned,signature:['c'.repeat(130)]}
 const session={session_id:'session-id',csrf_hash:hash(csrf),contract_address:contract,pending_owner_address:pending,origin}
 const row={operation_id:'123e4567-e89b-42d3-a456-426614174000',session_id:'session-id',contract_address:contract,pending_owner_address:pending,intent:{feeLimitSun:'150000000'},intent_sha256:'d'.repeat(64),transaction_id:txid,unsigned_transaction:unsigned,state:'prepared'}
 let state='prepared'
 const db={async query(sql){
  if(sql.includes('SELECT session_id,csrf_hash'))return{rows:[session]}
  if(sql.includes('SET last_seen_at'))return{rows:[]}
  if(sql.includes("SET state='confirming'")){state='confirming';return{rows:[row]}}
  if(sql.includes('SET signed_transaction')){events.push('persist-signed');state='signed';return{rows:[{}]}}
  if(sql.includes("SET state='broadcast-unknown'")){events.push('persist-broadcast-unknown');state='broadcast-unknown';return{rows:[{}]}}
  if(sql.includes("SET state='broadcast',broadcast_at")){events.push('persist-broadcast');state='broadcast';return{rows:[]}}
  return{rows:[]}
 }}
 const t=fakeTron();t.trx.sendRawTransaction=async()=>{events.push('broadcast');assert.equal(state,'broadcast-unknown');return{result:true}}
 const out=[]
 const api=createPendingOwnerAcceptanceApi({database:db,env:{TRAX_CONTRACT_ADDRESS:contract},send:(_r,status,payload)=>out.push({status,payload}),tronWebFactory:()=>t,checkIntegrity:()=>true,checkSigner:()=>true,checkPermission:async()=>true,estimateEnergy:async()=>({energyUsed:'1'}),readResources:async()=>({}),calculateBudget:()=>({}),assertBudget:()=>true})
 await api.handle(req('POST',{operationId:row.operation_id,intentSha256:row.intent_sha256,signedTransaction:signed,confirmationPhrase:'CONFIRM TRӾ OWNERSHIP ACCEPTANCE'},{origin,cookie:'tron_pending_owner_session=token','x-csrf-token':csrf}),res(),new URL('https://api.test/api/pending-owner/confirm'),origin)
 assert.deepEqual(events,['persist-signed','persist-broadcast-unknown','broadcast','persist-broadcast'])
 assert.equal(state,'broadcast')
 assert.equal(out[0].status,202)
})


test('pending-owner confirmation failure before signed persistence closes the claimed operation',async()=>{
 const origin='https://tron-transfer.onrender.com',csrf='csrf-token',txid='b'.repeat(64),raw='cc'.repeat(32)
 const unsigned={txID:txid,raw_data_hex:raw,raw_data:{timestamp:Date.now(),expiration:Date.now()+120000,fee_limit:150000000,contract:[{type:'TriggerSmartContract',parameter:{value:{owner_address:pending,contract_address:contract,data:'12345678',call_value:0}}}]}}
 const row={operation_id:'123e4567-e89b-42d3-a456-426614174000',session_id:'session-id',contract_address:contract,pending_owner_address:pending,intent:{feeLimitSun:'150000000'},intent_sha256:'e'.repeat(64),transaction_id:txid,unsigned_transaction:unsigned,state:'prepared'}
 const session={session_id:'session-id',csrf_hash:hash(csrf),contract_address:contract,pending_owner_address:pending,origin}
 let state='prepared',failureCode=null
 const db={async query(sql,params=[]){
  if(sql.includes('SELECT session_id,csrf_hash'))return{rows:[session]}
  if(sql.includes('SET last_seen_at'))return{rows:[]}
  if(sql.includes("SET state='confirming'")){state='confirming';return{rows:[row]}}
  if(sql.includes("SET state='failed',failure_code=$2")){state='failed';failureCode=params[1];return{rows:[{}]}}
  return{rows:[]}
 }}
 const out=[]
 const api=createPendingOwnerAcceptanceApi({
  database:db,env:{TRAX_CONTRACT_ADDRESS:contract},
  send:(_r,status,payload)=>out.push({status,payload}),
  tronWebFactory:fakeTron,
  checkIntegrity:()=>{throw Object.assign(new Error('test-signature-integrity-failure'),{code:'TEST_SIGNATURE_INTEGRITY_FAILED',status:409})},
  checkSigner:()=>true,checkPermission:async()=>true,
  estimateEnergy:async()=>({energyUsed:'1'}),readResources:async()=>({}),
  calculateBudget:()=>({}),assertBudget:()=>true,
 })
 await api.handle(req('POST',{operationId:row.operation_id,intentSha256:row.intent_sha256,signedTransaction:{...unsigned,signature:['d'.repeat(130)]},confirmationPhrase:'CONFIRM TRӾ OWNERSHIP ACCEPTANCE'},{origin,cookie:'tron_pending_owner_session=token','x-csrf-token':csrf}),res(),new URL('https://api.test/api/pending-owner/confirm'),origin)
 assert.equal(out[0].status,409)
 assert.equal(state,'failed')
 assert.equal(failureCode,'TEST_SIGNATURE_INTEGRITY_FAILED')
})


test('pending-owner status closes an abandoned confirming claim after five minutes',async()=>{
 const origin='https://tron-transfer.onrender.com',csrf='csrf-token'
 const session={session_id:'session-id',csrf_hash:hash(csrf),contract_address:contract,pending_owner_address:pending,origin}
 const row={operation_id:'123e4567-e89b-42d3-a456-426614174000',contract_address:contract,pending_owner_address:pending,idempotency_key:'pending-owner-key-123456',intent:{feeLimitSun:'150000000'},intent_sha256:'f'.repeat(64),transaction_id:'c'.repeat(64),preflight:{},receipt:null,state:'confirming',failure_code:null,created_at:new Date(Date.now()-600000).toISOString(),updated_at:new Date(Date.now()-600000).toISOString(),confirmed_at:null,unsigned_transaction:{raw_data_hex:'dd'}}
 let state='confirming'
 const db={async query(sql){
  if(sql.includes('SELECT session_id,csrf_hash'))return{rows:[session]}
  if(sql.includes('SET last_seen_at'))return{rows:[]}
  if(sql.includes('SELECT operation_id,contract_address,pending_owner_address'))return{rows:[{...row,state,updated_at:row.updated_at}]}
  if(sql.includes("SET state='failed',failure_code='PENDING_OWNER_CONFIRMATION_INTERRUPTED_BEFORE_SIGN_PERSISTENCE'")){state='failed';return{rows:[{state,failure_code:'PENDING_OWNER_CONFIRMATION_INTERRUPTED_BEFORE_SIGN_PERSISTENCE',updated_at:new Date().toISOString()}]}}
  return{rows:[]}
 }}
 const out=[]
 const api=createPendingOwnerAcceptanceApi({database:db,env:{TRAX_CONTRACT_ADDRESS:contract},send:(_r,status,payload)=>out.push({status,payload})})
 await api.handle(req('GET',{}, {origin,cookie:'tron_pending_owner_session=token'}),res(),new URL('https://api.test/api/pending-owner/operations/'+row.operation_id),origin)
 assert.equal(out[0].status,200)
 assert.equal(out[0].payload.operation.state,'failed')
 assert.equal(out[0].payload.operation.failure_code,'PENDING_OWNER_CONFIRMATION_INTERRUPTED_BEFORE_SIGN_PERSISTENCE')
 assert.equal(state,'failed')
})
