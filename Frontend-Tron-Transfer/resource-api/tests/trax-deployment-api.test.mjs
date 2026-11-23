import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createTRAXDeploymentApi } from '../trax-deployment-api.mjs'

const owner = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
function req(method='GET', body={}) { return { method, headers: {}, async *[Symbol.asyncIterator]() { if (method==='POST') yield Buffer.from(JSON.stringify(body)) } } }
function res() { return { writeHead() {}, end() {} } }
function make(overrides={}) {
  const replies=[]
  const api=createTRAXDeploymentApi({
    env:{ TRON_OWNER_ADDRESS:owner, ...overrides.env },
    database:overrides.database || { async query(sql) { if (sql.includes('to_regclass')) return {rows:[{deployments_table:'tron_transfer_deployments'}]}; return {rows:[]} } },
    send:(_res,status,payload)=>replies.push({status,payload}),
    authenticateManagedSession:async()=>overrides.session || {address:owner,sessionId:1},
    artifactLoader:overrides.artifactLoader || (async()=>({contractName:'Restricted1TRAX',compiler:'solc 0.8.25',sourceSha256:'1'.repeat(64),creationBytecodeSha256:'2'.repeat(64),runtimeBytecodeSha256:'3'.repeat(64),artifactSha256:'4'.repeat(64),abi:[],bytecode:'6000',deployedBytecode:'6001'})),
    tronWebFactory:()=>{ throw new Error('must-not-construct-without-prepare') },
  })
  return {api,replies}
}
test('deployment readiness requires an authenticated configured Owner', async()=>{
 const {api,replies}=make({session:{address:'TSPz5ULCfd4zbMUCfF337KWyia8F1F5kYR'}})
 await api.handle(req(),res(),new URL('https://api.test/api/owner/deployment/readiness'),null)
 assert.equal(replies[0].status,401)
})
test('deployment readiness reports artifact and ledger gates without signing or broadcasting', async()=>{
 const env={TRAX_DEPLOYMENT_LEDGER_DURABLE:'true',TRAX_DEPLOYMENT_LEDGER_BACKUP_VERIFIED:'true',TRAX_DEPLOYMENT_LEDGER_RESTORE_TESTED:'true',TRAX_SOURCE_SHA256:'1'.repeat(64),TRAX_CREATION_BYTECODE_SHA256:'2'.repeat(64),TRAX_RUNTIME_BYTECODE_SHA256:'3'.repeat(64),TRAX_DEPLOYMENT_ARTIFACT_SHA256:'4'.repeat(64)}
 const {api,replies}=make({env})
 await api.handle(req(),res(),new URL('https://api.test/api/owner/deployment/readiness'),null)
 assert.equal(replies[0].status,200)
 assert.equal(replies[0].payload.readyForPreparation,true)
 assert.equal(replies[0].payload.executionEnabled,false)
})
test('deployment confirmation is locked even when readiness checks pass', async()=>{
 const {api,replies}=make()
 await api.handle(req('POST'),res(),new URL('https://api.test/api/owner/deployment/confirm'),null)
 assert.equal(replies[0].status,423)
 assert.equal(replies[0].payload.error,'TRAX_DEPLOYMENT_CONFIRMATION_NOT_IMPLEMENTED')
})


test('deployment confirmation persists signed payload and broadcast-unknown state before network broadcast', async()=>{
 const state={value:'prepared'}
 const events=[]
 const artifact={contractName:'Restricted1TRAX',compiler:'solc 0.8.25',artifactSha256:'4'.repeat(64),creationBytecodeSha256:'2'.repeat(64),runtimeBytecodeSha256:'3'.repeat(64),sourceSha256:'1'.repeat(64),abi:[],bytecode:'6000',deployedBytecode:'6001'}
 const rawDataHex='bb'.repeat(32), txID=createHash('sha256').update(Buffer.from(rawDataHex,'hex')).digest('hex')
 const unsigned={txID,raw_data_hex:rawDataHex,raw_data:{expiration:Date.now()+120000,contract:[{type:'CreateSmartContract',parameter:{value:{owner_address:'41'+'11'.repeat(20),new_contract:{bytecode:'6000'}}}}]}}
 const signed={...unsigned,signature:['c'.repeat(130)]}
 const db={async query(sql,params=[]){
  if(sql.includes('to_regclass')) return {rows:[{deployments_table:'tron_transfer_deployments'}]}
  if(sql.includes("SET state='confirming'")) { state.value='confirming'; return {rows:[{operation_id:'123e4567-e89b-42d3-a456-426614174000',owner_address:owner,intent:{feeLimitSun:'1000000'},intent_sha256:'d'.repeat(64),artifact_sha256:'4'.repeat(64),creation_bytecode_sha256:'2'.repeat(64),runtime_bytecode_sha256:'3'.repeat(64),transaction_id:unsigned.txID,unsigned_transaction:unsigned,state:'confirming'}]} }
  if(sql.includes("SET signed_transaction")) { events.push('persist-signed'); state.value='signed'; return {rows:[{operation_id:'123e4567-e89b-42d3-a456-426614174000'}]} }
  if(sql.includes("SET state='broadcast-unknown'")) { events.push('persist-broadcast-unknown'); state.value='broadcast-unknown'; return {rows:[{operation_id:'123e4567-e89b-42d3-a456-426614174000'}]} }
  if(sql.includes("SET state='broadcast'")) { state.value='broadcast'; return {rows:[]} }
  return {rows:[]}
 }}
 const fakeTron={fullNode:{headers:{}},address:{fromPrivateKey:()=>owner,toHex:()=> '41'+'11'.repeat(20)},trx:{sign:async()=>signed,sendRawTransaction:async()=>{events.push('broadcast');assert.equal(state.value,'broadcast-unknown');return {result:true}}}}
 const {api,replies}=make({
  env:{TRAX_DEPLOYMENT_EXECUTION_ENABLED:'true',TRAX_DEPLOYMENT_MAINNET_ACK:'CONFIRM_ARTIFACT_PINNED_TRAX_DEPLOYMENT',TRAX_DEPLOYMENT_LEDGER_DURABLE:'true',TRAX_DEPLOYMENT_LEDGER_BACKUP_VERIFIED:'true',TRAX_DEPLOYMENT_LEDGER_RESTORE_TESTED:'true',TRON_OWNER_PRIVATE_KEY:'1'.repeat(64)},
  database:db,artifactLoader:async()=>artifact,tronWebFactory:()=>fakeTron,
  assertIntegrity:()=>true,predictAddress:()=> 'T'+'A'.repeat(33),estimateEnergy:async()=>({energyUsed:1}),readResources:async()=>({}),
  calculateBudget:()=>({}),assertBudget:()=>true,
  session:{address:owner,sessionId:1},
  signDeployment:async()=>signed,
  broadcastDeployment:async()=>{events.push('broadcast');assert.equal(state.value,'broadcast-unknown');return {result:true}},
 })
 await api.handle(req('POST',{operationId:'123e4567-e89b-42d3-a456-426614174000',intentSha256:'d'.repeat(64),confirmationPhrase:'CONFIRM TRӾ MAINNET DEPLOYMENT'}),res(),new URL('https://api.test/api/owner/deployment/confirm'),null)
 assert.deepEqual(events,['persist-signed','persist-broadcast-unknown','broadcast'])
 assert.equal(state.value,'broadcast')
 assert.equal(replies[0].status,202)
})

test('deployment broadcast ambiguity is retained without automatic rebroadcast', async()=>{
 const state={value:'prepared'}, events=[]
 const artifact={contractName:'Restricted1TRAX',compiler:'solc 0.8.25',artifactSha256:'4'.repeat(64),creationBytecodeSha256:'2'.repeat(64),runtimeBytecodeSha256:'3'.repeat(64),sourceSha256:'1'.repeat(64),abi:[],bytecode:'6000',deployedBytecode:'6001'}
 const unsigned={txID:'a'.repeat(64),raw_data_hex:'bb'.repeat(32),raw_data:{expiration:Date.now()+120000,contract:[{type:'CreateSmartContract',parameter:{value:{owner_address:'41'+'11'.repeat(20),new_contract:{bytecode:'6000'}}}}]}}
 const signed={...unsigned,signature:['c'.repeat(130)]}
 const db={async query(sql){
  if(sql.includes('to_regclass')) return {rows:[{deployments_table:'tron_transfer_deployments'}]}
  if(sql.includes("SET state='confirming'")) {state.value='confirming';return {rows:[{operation_id:'123e4567-e89b-42d3-a456-426614174000',owner_address:owner,intent:{feeLimitSun:'1000000'},intent_sha256:'d'.repeat(64),artifact_sha256:'4'.repeat(64),creation_bytecode_sha256:'2'.repeat(64),runtime_bytecode_sha256:'3'.repeat(64),transaction_id:unsigned.txID,unsigned_transaction:unsigned,state:'confirming'}]}}
  if(sql.includes('SET signed_transaction')) {state.value='signed';events.push('signed');return {rows:[{}]}}
  if(sql.includes("SET state='broadcast-unknown'")) {state.value='broadcast-unknown';events.push('unknown');return {rows:[{}]}}
  return {rows:[]}
 }}
 const fakeTron={fullNode:{headers:{}},address:{fromPrivateKey:()=>owner},trx:{sign:async()=>signed}}
 const {api,replies}=make({
  env:{TRAX_DEPLOYMENT_EXECUTION_ENABLED:'true',TRAX_DEPLOYMENT_MAINNET_ACK:'CONFIRM_ARTIFACT_PINNED_TRAX_DEPLOYMENT',TRAX_DEPLOYMENT_LEDGER_DURABLE:'true',TRAX_DEPLOYMENT_LEDGER_BACKUP_VERIFIED:'true',TRAX_DEPLOYMENT_LEDGER_RESTORE_TESTED:'true',TRON_OWNER_PRIVATE_KEY:'1'.repeat(64)},
  database:db,artifactLoader:async()=>artifact,tronWebFactory:()=>fakeTron,
  assertIntegrity:()=>true,predictAddress:()=> 'T'+'A'.repeat(33),estimateEnergy:async()=>({energyUsed:1}),readResources:async()=>({}),calculateBudget:()=>({}),assertBudget:()=>true,
  session:{address:owner,sessionId:1},signDeployment:async()=>signed,
  broadcastDeployment:async()=>{events.push('broadcast-attempt');throw new Error('socket reset')},
 })
 await api.handle(req('POST',{operationId:'123e4567-e89b-42d3-a456-426614174000',intentSha256:'d'.repeat(64),confirmationPhrase:'CONFIRM TRӾ MAINNET DEPLOYMENT'}),res(),new URL('https://api.test/api/owner/deployment/confirm'),null)
 assert.deepEqual(events,['signed','unknown','broadcast-attempt'])
 assert.equal(state.value,'broadcast-unknown')
 assert.equal(replies[0].status,202)
 assert.equal(replies[0].payload.recovery.automaticRebroadcast,false)
})
