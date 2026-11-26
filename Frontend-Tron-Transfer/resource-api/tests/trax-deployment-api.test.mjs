import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createTRAXDeploymentApi } from '../trax-deployment-api.mjs'

const owner = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const testDatabaseUrl = 'postgres://ep-test.ap-southeast-1.aws.neon.tech/tron-transfer?sslmode=require'
const testDatabaseIdentity = createHash('sha256').update(JSON.stringify({
 hostname: 'ep-test.ap-southeast-1.aws.neon.tech', port: '5432', database: 'tron-transfer', username: '',
})).digest('hex')
function req(method='GET', body={}) { return { method, headers: {}, async *[Symbol.asyncIterator]() { if (method==='POST') yield Buffer.from(JSON.stringify(body)) } } }
function res() { return { writeHead() {}, end() {} } }
function make(overrides={}) {
  const replies=[]
  const api=createTRAXDeploymentApi({
    env:{ TRON_OWNER_ADDRESS:owner, DATABASE_URL:testDatabaseUrl, OWNER_ADMIN_EXPECTED_DATABASE_IDENTITY_SHA256:testDatabaseIdentity, ...overrides.env },
    database:overrides.database || { async query(sql) { if (sql.includes('to_regclass')) return {rows:[{deployments_table:'tron_transfer_deployments'}]}; return {rows:[]} } },
    send:(_res,status,payload)=>replies.push({status,payload}),
    authenticateManagedSession:async(req,options)=>overrides.authenticateManagedSession ? overrides.authenticateManagedSession(req,options) : (overrides.session || {address:owner,sessionId:1}),
    artifactLoader:overrides.artifactLoader || (async()=>({contractName:'Restricted1TRAX',compiler:'solc 0.8.25',sourceSha256:'1'.repeat(64),creationBytecodeSha256:'2'.repeat(64),runtimeBytecodeSha256:'3'.repeat(64),artifactSha256:'4'.repeat(64),abi:[],bytecode:'6000',deployedBytecode:'6001'})),
    tronWebFactory:overrides.tronWebFactory || (()=>{ throw new Error('must-not-construct-without-prepare') }),
    recoverDeployment:overrides.recoverDeployment,
    buildTransaction:overrides.buildTransaction,
    estimateEnergy:overrides.estimateEnergy,
    readResources:overrides.readResources,
    getBalance:overrides.getBalance,
    calculateBudget:overrides.calculateBudget,
    assertBudget:overrides.assertBudget,
    assertIntegrity:overrides.assertIntegrity,
    verifySigner:overrides.verifySigner || (()=>true),
    verifyPermission:overrides.verifyPermission || (async()=>true),
    predictAddress:overrides.predictAddress,
    broadcastDeployment:overrides.broadcastDeployment,
  })
  return {api,replies}
}
test('deployment readiness requires an authenticated configured Owner', async()=>{
 const {api,replies}=make({session:{address:'TSPz5ULCfd4zbMUCfF337KWyia8F1F5kYR'}})
 await api.handle(req(),res(),new URL('https://api.test/api/owner/deployment/readiness'),null)
 assert.equal(replies[0].status,401)
})
test('read-only resource preflight authenticates the Owner session without requiring CSRF on GET', async()=>{
 let requireCsrf = null
 const {api,replies}=make({env:{
  TRAX_DEPLOYMENT_LEDGER_DURABLE:'true',TRAX_DEPLOYMENT_LEDGER_BACKUP_VERIFIED:'true',TRAX_DEPLOYMENT_LEDGER_RESTORE_TESTED:'true',
  TRAX_SOURCE_SHA256:'1'.repeat(64),TRAX_CREATION_BYTECODE_SHA256:'2'.repeat(64),TRAX_RUNTIME_BYTECODE_SHA256:'3'.repeat(64),TRAX_DEPLOYMENT_ARTIFACT_SHA256:'4'.repeat(64),
 },authenticateManagedSession:async(_req,options)=>{requireCsrf=options.requireCsrf;return {address:owner,sessionId:1}}})
 await api.handle(req(),res(),new URL('https://api.test/api/owner/deployment/preflight'),null)
 assert.equal(requireCsrf,false)
 assert.equal(replies[0].status,400)
 assert.equal(replies[0].payload.error,'TRAX_DEPLOYMENT_FEE_LIMIT_INVALID')
})

test('deployment readiness reports artifact and ledger gates without signing or broadcasting', async()=>{
 const env={TRAX_DEPLOYMENT_LEDGER_DURABLE:'true',TRAX_DEPLOYMENT_LEDGER_BACKUP_VERIFIED:'true',TRAX_DEPLOYMENT_LEDGER_RESTORE_TESTED:'true',TRAX_SOURCE_SHA256:'1'.repeat(64),TRAX_CREATION_BYTECODE_SHA256:'2'.repeat(64),TRAX_RUNTIME_BYTECODE_SHA256:'3'.repeat(64),TRAX_DEPLOYMENT_ARTIFACT_SHA256:'4'.repeat(64)}
 const {api,replies}=make({env})
 await api.handle(req(),res(),new URL('https://api.test/api/owner/deployment/readiness'),null)
 assert.equal(replies[0].status,200)
 assert.equal(replies[0].payload.readyForPreparation,true)
 assert.equal(replies[0].payload.signerCustody,'encrypted-local-owner-vault')
 assert.equal(replies[0].payload.executionEnabled,false)
})
test('deployment readiness and confirmation block a mismatched database identity', async()=>{
 const {api,replies}=make({env:{OWNER_ADMIN_EXPECTED_DATABASE_IDENTITY_SHA256:'f'.repeat(64)}})
 await api.handle(req(),res(),new URL('https://api.test/api/owner/deployment/readiness'),null)
 assert.equal(replies[0].payload.gates.databaseTargetIdentity,false)
 assert.equal(replies[0].payload.readyForPreparation,false)
 assert.equal(replies[0].payload.blocker,'TRAX_DEPLOYMENT_DATABASE_TARGET_IDENTITY_NOT_VERIFIED')
 await api.handle(req('POST',{operationId:'123e4567-e89b-42d3-a456-426614174000',intentSha256:'d'.repeat(64),confirmationPhrase:'CONFIRM TRӾ MAINNET DEPLOYMENT'}),res(),new URL('https://api.test/api/owner/deployment/confirm'),null)
 assert.equal(replies[1].status,423)
 assert.equal(replies[1].payload.error,'TRAX_DEPLOYMENT_EXECUTION_GATES_LOCKED')
 await api.handle(req(),res(),new URL('https://api.test/api/owner/deployment/123e4567-e89b-42d3-a456-426614174000'),null)
 assert.equal(replies[2].status,503)
 assert.equal(replies[2].payload.error,'TRAX_DEPLOYMENT_DATABASE_TARGET_IDENTITY_NOT_VERIFIED')
})

test('read-only deployment preflight returns current Mainnet resources without persisting or signing', async()=>{
 const events=[]
 const db={async query(sql){if(sql.includes('to_regclass'))return {rows:[{deployments_table:'tron_transfer_deployments'}]};events.push('database-write');return {rows:[]}}}
 const fakeTron={address:{toHex:()=> '41'+'11'.repeat(20)}}
 const {api,replies}=make({env:{
  TRAX_DEPLOYMENT_LEDGER_DURABLE:'true',TRAX_DEPLOYMENT_LEDGER_BACKUP_VERIFIED:'true',TRAX_DEPLOYMENT_LEDGER_RESTORE_TESTED:'true',
  TRAX_SOURCE_SHA256:'1'.repeat(64),TRAX_CREATION_BYTECODE_SHA256:'2'.repeat(64),TRAX_RUNTIME_BYTECODE_SHA256:'3'.repeat(64),TRAX_DEPLOYMENT_ARTIFACT_SHA256:'4'.repeat(64),
 },database:db,tronWebFactory:()=>fakeTron,buildTransaction:async()=>({txID:'a'.repeat(64),raw_data_hex:'ab'.repeat(32),raw_data:{contract:[{type:'CreateSmartContract',parameter:{value:{owner_address:'41'+'11'.repeat(20),new_contract:{bytecode:'6000',abi:{entrys:[]}}}}}]}}),
 assertIntegrity:()=>true,estimateEnergy:async()=>({energyUsed:1000}),readResources:async()=>({energyAvailable:'2000',freeBandwidthAvailable:'500',stakedBandwidthAvailable:'100',energyFeeSun:'420',bandwidthFeeSun:'1000',maxFeeLimitSun:'150000000'}),
 getBalance:async()=> '0',calculateBudget:()=>({requiredTrxSun:'0',energyWithSafetyMargin:'1250',availableEnergy:'2000',estimatedBandwidthBytes:'130',availableBandwidth:'500',energyBurnSun:'0',bandwidthBurnSun:'0'}),assertBudget:()=>true,
 })
 const url=new URL('https://api.test/api/owner/deployment/preflight?feeLimitSun=150000000')
 await api.handle(req(),res(),url,null)
 assert.equal(replies[0].status,200)
 assert.equal(replies[0].payload.zeroTrxBurnReady,true)
 assert.equal(replies[0].payload.ownerBalanceSun,'0')
 assert.equal(replies[0].payload.readOnly,true)
 assert.equal(replies[0].payload.transactionPersisted,false)
 assert.equal(replies[0].payload.signatureRequested,false)
 assert.equal(replies[0].payload.broadcastAttempted,false)
 assert.deepEqual(events,[])
})

test('read-only deployment preflight reports resource shortfall without requesting a signature', async()=>{
 const {api,replies}=make({env:{
  TRAX_DEPLOYMENT_LEDGER_DURABLE:'true',TRAX_DEPLOYMENT_LEDGER_BACKUP_VERIFIED:'true',TRAX_DEPLOYMENT_LEDGER_RESTORE_TESTED:'true',
  TRAX_SOURCE_SHA256:'1'.repeat(64),TRAX_CREATION_BYTECODE_SHA256:'2'.repeat(64),TRAX_RUNTIME_BYTECODE_SHA256:'3'.repeat(64),TRAX_DEPLOYMENT_ARTIFACT_SHA256:'4'.repeat(64),
 },tronWebFactory:()=>({address:{toHex:()=> '41'+'11'.repeat(20)}}),buildTransaction:async()=>({txID:'a'.repeat(64),raw_data_hex:'ab'.repeat(32),raw_data:{contract:[{type:'CreateSmartContract',parameter:{value:{owner_address:'41'+'11'.repeat(20),new_contract:{bytecode:'6000',abi:{entrys:[]}}}}}]}}),
 assertIntegrity:()=>true,estimateEnergy:async()=>({energyUsed:1000}),readResources:async()=>({energyAvailable:'100',freeBandwidthAvailable:'20',stakedBandwidthAvailable:'10',energyFeeSun:'420',bandwidthFeeSun:'1000',maxFeeLimitSun:'150000000'}),
 getBalance:async()=> '5000000',calculateBudget:()=>({requiredTrxSun:'12000000',energyWithSafetyMargin:'1250',availableEnergy:'100',estimatedBandwidthBytes:'130',availableBandwidth:'20',energyBurnSun:'11000000',bandwidthBurnSun:'1000000'}),assertBudget:()=>{throw new Error('must not assert an insufficient budget')},
 })
 await api.handle(req(),res(),new URL('https://api.test/api/owner/deployment/preflight?feeLimitSun=150000000'),null)
 assert.equal(replies[0].status,200)
 assert.equal(replies[0].payload.zeroTrxBurnReady,false)
 assert.equal(replies[0].payload.blocker,'ZERO_TRX_BURN_BUDGET_EXCEEDED')
 assert.equal(replies[0].payload.budget.requiredTrxSun,'12000000')
 assert.equal(replies[0].payload.transactionPersisted,false)
 assert.equal(replies[0].payload.broadcastAttempted,false)
})

test('deployment confirmation is locked even when readiness checks pass', async()=>{
 const {api,replies}=make()
 await api.handle(req('POST',{operationId:'123e4567-e89b-42d3-a456-426614174000',intentSha256:'d'.repeat(64),confirmationPhrase:'CONFIRM TRӾ MAINNET DEPLOYMENT'}),res(),new URL('https://api.test/api/owner/deployment/confirm'),null)
 assert.equal(replies[0].status,423)
 assert.equal(replies[0].payload.error,'TRAX_DEPLOYMENT_EXECUTION_GATES_LOCKED')
})


test('deployment confirmation accepts full-size local Owner Wallet transaction payloads before applying execution gates', async()=>{
 const {api,replies}=make()
 await api.handle(req('POST',{
  operationId:'123e4567-e89b-42d3-a456-426614174000',
  intentSha256:'d'.repeat(64),
  confirmationPhrase:'CONFIRM TRӾ MAINNET DEPLOYMENT',
  signedTransaction:{signature:['a'.repeat(130)]},
  padding:'x'.repeat(9000),
 }),res(),new URL('https://api.test/api/owner/deployment/confirm'),null)
 assert.equal(replies[0].status,423)
 assert.equal(replies[0].payload.error,'TRAX_DEPLOYMENT_EXECUTION_GATES_LOCKED')
})

test('deployment confirmation refuses to claim an operation without a local Owner Wallet signature', async()=>{
 const {api,replies}=make({env:{
  TRAX_DEPLOYMENT_EXECUTION_ENABLED:'true',
  TRAX_DEPLOYMENT_MAINNET_ACK:'CONFIRM_ARTIFACT_PINNED_TRAX_DEPLOYMENT',
  TRAX_DEPLOYMENT_LEDGER_DURABLE:'true',
  TRAX_DEPLOYMENT_LEDGER_BACKUP_VERIFIED:'true',
  TRAX_DEPLOYMENT_LEDGER_RESTORE_TESTED:'true',
 }})
 await api.handle(req('POST',{
  operationId:'123e4567-e89b-42d3-a456-426614174000',
  intentSha256:'d'.repeat(64),
  confirmationPhrase:'CONFIRM TRӾ MAINNET DEPLOYMENT',
 }),res(),new URL('https://api.test/api/owner/deployment/confirm'),null)
 assert.equal(replies[0].status,409)
 assert.equal(replies[0].payload.error,'TRAX_DEPLOYMENT_OWNER_SIGNATURE_REQUIRED')
})

test('deployment confirmation persists verified local signature without broadcasting', async()=>{
 const state={value:'prepared'}
 const events=[]
 const artifact={contractName:'Restricted1TRAX',compiler:'solc 0.8.25',artifactSha256:'4'.repeat(64),creationBytecodeSha256:'2'.repeat(64),runtimeBytecodeSha256:'3'.repeat(64),sourceSha256:'1'.repeat(64),abi:[],bytecode:'6000',deployedBytecode:'6001'}
 const rawDataHex='bb'.repeat(32), txID=createHash('sha256').update(Buffer.from(rawDataHex,'hex')).digest('hex')
 const unsigned={txID,raw_data_hex:rawDataHex,raw_data:{expiration:Date.now()+120000,fee_limit:1000000,contract:[{type:'CreateSmartContract',parameter:{value:{owner_address:'41'+'11'.repeat(20),new_contract:{bytecode:'6000'}}}}]}}
 const signed={...unsigned,signature:['c'.repeat(130)]}
 const db={async query(sql,params=[]){
  if(sql.includes('to_regclass')) return {rows:[{deployments_table:'tron_transfer_deployments'}]}
  if(sql.includes("SET state='confirming'")) { state.value='confirming'; return {rows:[{operation_id:'123e4567-e89b-42d3-a456-426614174000',owner_address:owner,intent:{feeLimitSun:'1000000'},intent_sha256:'d'.repeat(64),artifact_sha256:'4'.repeat(64),creation_bytecode_sha256:'2'.repeat(64),runtime_bytecode_sha256:'3'.repeat(64),transaction_id:unsigned.txID,unsigned_transaction:unsigned,state:'confirming'}]} }
  if(sql.includes("SET signed_transaction")) { events.push('persist-signed'); state.value='signed'; return {rows:[{operation_id:'123e4567-e89b-42d3-a456-426614174000'}]} }
  if(sql.includes("SET state='broadcast-unknown'")) { events.push('persist-broadcast-unknown'); state.value='broadcast-unknown'; return {rows:[{operation_id:'123e4567-e89b-42d3-a456-426614174000'}]} }
  if(sql.includes("SET state='broadcast'")) { state.value='broadcast'; return {rows:[]} }
  return {rows:[]}
 }}
 const fakeTron={fullNode:{headers:{}},address:{toHex:()=> '41'+'11'.repeat(20)} ,trx:{sendRawTransaction:async()=>{events.push('broadcast');assert.equal(state.value,'broadcast-unknown');return {result:true}}}}
 const {api,replies}=make({
  env:{TRAX_DEPLOYMENT_EXECUTION_ENABLED:'true',TRAX_DEPLOYMENT_MAINNET_ACK:'CONFIRM_ARTIFACT_PINNED_TRAX_DEPLOYMENT',TRAX_DEPLOYMENT_LEDGER_DURABLE:'true',TRAX_DEPLOYMENT_LEDGER_BACKUP_VERIFIED:'true',TRAX_DEPLOYMENT_LEDGER_RESTORE_TESTED:'true'},
  database:db,artifactLoader:async()=>artifact,tronWebFactory:()=>fakeTron,
  assertIntegrity:()=>true,predictAddress:()=> 'T'+'A'.repeat(33),estimateEnergy:async()=>({energyUsed:1}),readResources:async()=>({}),
  calculateBudget:()=>({}),assertBudget:()=>true,
  session:{address:owner,sessionId:1},
  
  broadcastDeployment:async()=>{events.push('broadcast');assert.equal(state.value,'broadcast-unknown');return {result:true}},
 })
 await api.handle(req('POST',{operationId:'123e4567-e89b-42d3-a456-426614174000',intentSha256:'d'.repeat(64),confirmationPhrase:'CONFIRM TRӾ MAINNET DEPLOYMENT',signedTransaction:signed}),res(),new URL('https://api.test/api/owner/deployment/confirm'),null)
 assert.deepEqual(events,['persist-signed'])
 assert.equal(state.value,'signed')
 assert.equal(replies[0].status,200)
 assert.equal(replies[0].payload.broadcastApproval.required,true)
 assert.match(replies[0].payload.broadcastApproval.confirmationPhrase,/^BROADCAST TRӾ MAINNET /)
})

test('signing stage never attempts a broadcast, even when execution gates are enabled', async()=>{
 const state={value:'prepared'}, events=[]
 const artifact={contractName:'Restricted1TRAX',compiler:'solc 0.8.25',artifactSha256:'4'.repeat(64),creationBytecodeSha256:'2'.repeat(64),runtimeBytecodeSha256:'3'.repeat(64),sourceSha256:'1'.repeat(64),abi:[],bytecode:'6000',deployedBytecode:'6001'}
 const rawDataHex='bb'.repeat(32), txID=createHash('sha256').update(Buffer.from(rawDataHex,'hex')).digest('hex')
 const unsigned={txID,raw_data_hex:rawDataHex,raw_data:{expiration:Date.now()+120000,fee_limit:1000000,contract:[{type:'CreateSmartContract',parameter:{value:{owner_address:'41'+'11'.repeat(20),new_contract:{bytecode:'6000'}}}}]}}
 const signed={...unsigned,signature:['c'.repeat(130)]}
 const db={async query(sql){
  if(sql.includes('to_regclass')) return {rows:[{deployments_table:'tron_transfer_deployments'}]}
  if(sql.includes("SET state='confirming'")) {state.value='confirming';return {rows:[{operation_id:'123e4567-e89b-42d3-a456-426614174000',owner_address:owner,intent:{feeLimitSun:'1000000'},intent_sha256:'d'.repeat(64),artifact_sha256:'4'.repeat(64),creation_bytecode_sha256:'2'.repeat(64),runtime_bytecode_sha256:'3'.repeat(64),transaction_id:unsigned.txID,unsigned_transaction:unsigned,state:'confirming'}]}}
  if(sql.includes('SET signed_transaction')) {state.value='signed';events.push('signed');return {rows:[{}]}}
  if(sql.includes("SET state='broadcast-unknown'")) {state.value='broadcast-unknown';events.push('unknown');return {rows:[{}]}}
  return {rows:[]}
 }}
 const fakeTron={fullNode:{headers:{}},address:{toHex:()=> '41'+'11'.repeat(20)} ,trx:{}}
 const {api,replies}=make({
  env:{TRAX_DEPLOYMENT_EXECUTION_ENABLED:'true',TRAX_DEPLOYMENT_MAINNET_ACK:'CONFIRM_ARTIFACT_PINNED_TRAX_DEPLOYMENT',TRAX_DEPLOYMENT_LEDGER_DURABLE:'true',TRAX_DEPLOYMENT_LEDGER_BACKUP_VERIFIED:'true',TRAX_DEPLOYMENT_LEDGER_RESTORE_TESTED:'true'},
  database:db,artifactLoader:async()=>artifact,tronWebFactory:()=>fakeTron,
  assertIntegrity:()=>true,predictAddress:()=> 'T'+'A'.repeat(33),estimateEnergy:async()=>({energyUsed:1}),readResources:async()=>({}),calculateBudget:()=>({}),assertBudget:()=>true,
  session:{address:owner,sessionId:1},
  broadcastDeployment:async()=>{events.push('broadcast-attempt');throw new Error('socket reset')},
 })
 await api.handle(req('POST',{operationId:'123e4567-e89b-42d3-a456-426614174000',intentSha256:'d'.repeat(64),confirmationPhrase:'CONFIRM TRӾ MAINNET DEPLOYMENT',signedTransaction:signed}),res(),new URL('https://api.test/api/owner/deployment/confirm'),null)
 assert.deepEqual(events,['signed'])
 assert.equal(state.value,'signed')
 assert.equal(replies[0].status,200)
 assert.equal(replies[0].payload.broadcastApproval.required,true)
 assert.equal(events.includes('broadcast-attempt'),false)
})


test('broadcast endpoint requires exact transaction-specific approval and only broadcasts the persisted signed transaction', async()=>{
 const events=[]
 const artifact={contractName:'Restricted1TRAX',compiler:'solc 0.8.25',artifactSha256:'4'.repeat(64),creationBytecodeSha256:'2'.repeat(64),runtimeBytecodeSha256:'3'.repeat(64),sourceSha256:'1'.repeat(64),abi:[],bytecode:'6000',deployedBytecode:'6001'}
 const rawDataHex='bb'.repeat(32), txID=createHash('sha256').update(Buffer.from(rawDataHex,'hex')).digest('hex')
 const unsigned={txID,raw_data_hex:rawDataHex,raw_data:{expiration:Date.now()+120000,fee_limit:1000000,contract:[{type:'CreateSmartContract',parameter:{value:{owner_address:'41'+'11'.repeat(20),new_contract:{bytecode:'6000'}}}}]}}
 const signed={...unsigned,signature:['c'.repeat(130)]}
 const row={operation_id:'123e4567-e89b-42d3-a456-426614174000',owner_address:owner,intent:{feeLimitSun:'1000000'},intent_sha256:'d'.repeat(64),artifact_sha256:'4'.repeat(64),creation_bytecode_sha256:'2'.repeat(64),runtime_bytecode_sha256:'3'.repeat(64),transaction_id:txID,unsigned_transaction:unsigned,signed_transaction:signed,state:'signed'}
 const db={async query(sql){if(sql.includes('to_regclass'))return {rows:[{deployments_table:'tron_transfer_deployments'}]};if(sql.includes('SELECT operation_id,owner_address,intent,intent_sha256'))return {rows:[row]};if(sql.includes("SET state='broadcast-unknown'")){events.push('persist-broadcast-intent');return {rows:[{operation_id:row.operation_id}]}}if(sql.includes("SET state='broadcast'")){events.push('persist-broadcast');return {rows:[]}}return {rows:[]}}}
 const {api,replies}=make({
  env:{TRAX_DEPLOYMENT_EXECUTION_ENABLED:'true',TRAX_DEPLOYMENT_MAINNET_ACK:'CONFIRM_ARTIFACT_PINNED_TRAX_DEPLOYMENT',TRAX_DEPLOYMENT_LEDGER_DURABLE:'true',TRAX_DEPLOYMENT_LEDGER_BACKUP_VERIFIED:'true',TRAX_DEPLOYMENT_LEDGER_RESTORE_TESTED:'true'},
  database:db,artifactLoader:async()=>artifact,tronWebFactory:()=>({address:{toHex:()=> '41'+'11'.repeat(20)}}),
  assertIntegrity:()=>true,predictAddress:()=> 'T'+'A'.repeat(33),estimateEnergy:async()=>({energyUsed:1}),readResources:async()=>({}),calculateBudget:()=>({}),assertBudget:()=>true,
  verifySigner:async()=>events.push('verify-signer'),verifyPermission:async()=>events.push('verify-permission'),
  broadcastDeployment:async(_client,tx)=>{assert.equal(tx.txID,txID);events.push('broadcast');return {result:true,txid:txID}},
 })
 const url=new URL('https://api.test/api/owner/deployment/broadcast')
 await api.handle(req('POST',{operationId:row.operation_id,intentSha256:row.intent_sha256,transactionId:txID,confirmationPhrase:'BROADCAST TRӾ MAINNET WRONG000000'}),res(),url,null)
 assert.equal(replies[0].status,400)
 assert.equal(events.length,0)
 await api.handle(req('POST',{operationId:row.operation_id,intentSha256:row.intent_sha256,transactionId:txID,confirmationPhrase:'BROADCAST TRӾ MAINNET '+txID.slice(0,12).toUpperCase()}),res(),url,null)
 assert.equal(replies[1].status,202)
 assert.equal(replies[1].payload.deployment.state,'broadcast')
 assert.deepEqual(events,['verify-signer','verify-permission','persist-broadcast-intent','broadcast','persist-broadcast'])
})

test('deployment recovery verifies only the original txID and persists solidified confirmation', async()=>{
 const events=[]
 const artifact={contractName:'Restricted1TRAX',compiler:'solc 0.8.25',artifactSha256:'4'.repeat(64),creationBytecodeSha256:'2'.repeat(64),runtimeBytecodeSha256:'3'.repeat(64),sourceSha256:'1'.repeat(64),abi:[],bytecode:'6000',deployedBytecode:'6001'}
 const row={operation_id:'123e4567-e89b-42d3-a456-426614174000',owner_address:owner,artifact_sha256:'4'.repeat(64),transaction_id:'a'.repeat(64),state:'broadcast-unknown'}
 const db={async query(sql){
  if(sql.includes('to_regclass')) return {rows:[{deployments_table:'tron_transfer_deployments'}]}
  if(sql.includes('SELECT operation_id,owner_address,idempotency_key,intent,intent_sha256')) return {rows:[row]}
  if(sql.includes("SET state='confirmed'")) {events.push('persist-confirmed');return {rows:[{...row,state:'confirmed',contract_address:'T'+'B'.repeat(33)}]}}
  return {rows:[]}
 }}
 const fakeTron={fullNode:{headers:{}}}
 const {api,replies}=make({
  database:db,artifactLoader:async()=>artifact,tronWebFactory:()=>fakeTron,
  recoverDeployment:async(client,input)=>{events.push('verify-solidified');assert.equal(input.txID,row.transaction_id);assert.equal(input.ownerAddress,owner);return {address:'T'+'B'.repeat(33),txID:row.transaction_id,verified:true,receipt:{receipt:{result:'SUCCESS'}}}},
 })
 await api.handle(req('GET'),res(),new URL('https://api.test/api/owner/deployment/123e4567-e89b-42d3-a456-426614174000'),null)
 assert.deepEqual(events,['verify-solidified','persist-confirmed'])
 assert.equal(replies[0].status,200)
 assert.equal(replies[0].payload.recovery.solidified,true)
 assert.equal(replies[0].payload.recovery.automaticRebroadcast,false)
})


test('deployment confirmation verifies recovered signature and live permission before persistence or broadcast', async()=>{
 const events=[]
 const rawDataHex='bb'.repeat(32), txID=createHash('sha256').update(Buffer.from(rawDataHex,'hex')).digest('hex')
 const unsigned={txID,raw_data_hex:rawDataHex,raw_data:{expiration:Date.now()+120000,fee_limit:1000000,contract:[{type:'CreateSmartContract',parameter:{value:{owner_address:'41'+'11'.repeat(20),new_contract:{bytecode:'6000'}}}}]}}
 const signed={...unsigned,signature:['c'.repeat(130)]}
 const db={async query(sql){
  if(sql.includes('to_regclass')) return {rows:[{deployments_table:'tron_transfer_deployments'}]}
  if(sql.includes("SET state='confirming'")) return {rows:[{operation_id:'123e4567-e89b-42d3-a456-426614174000',owner_address:owner,intent:{feeLimitSun:'1000000'},intent_sha256:'d'.repeat(64),artifact_sha256:'4'.repeat(64),creation_bytecode_sha256:'2'.repeat(64),runtime_bytecode_sha256:'3'.repeat(64),transaction_id:unsigned.txID,unsigned_transaction:unsigned,state:'confirming'}]}
  if(sql.includes('SET signed_transaction')) {events.push('persist-signed');return {rows:[{}]}}
  if(sql.includes("SET state='broadcast-unknown'")) {events.push('persist-broadcast-unknown');return {rows:[{}]}}
  return {rows:[]}
 }}
 const fakeTron={fullNode:{headers:{}},address:{toHex:()=> '41'+'11'.repeat(20)} ,trx:{}}
 const {api,replies}=make({
  env:{TRAX_DEPLOYMENT_EXECUTION_ENABLED:'true',TRAX_DEPLOYMENT_MAINNET_ACK:'CONFIRM_ARTIFACT_PINNED_TRAX_DEPLOYMENT',TRAX_DEPLOYMENT_LEDGER_DURABLE:'true',TRAX_DEPLOYMENT_LEDGER_BACKUP_VERIFIED:'true',TRAX_DEPLOYMENT_LEDGER_RESTORE_TESTED:'true'},
  database:db,artifactLoader:async()=>({contractName:'Restricted1TRAX',compiler:'solc 0.8.25',artifactSha256:'4'.repeat(64),creationBytecodeSha256:'2'.repeat(64),runtimeBytecodeSha256:'3'.repeat(64),sourceSha256:'1'.repeat(64),abi:[],bytecode:'6000',deployedBytecode:'6001'}),
  tronWebFactory:()=>fakeTron,assertIntegrity:()=>true,predictAddress:()=> 'T'+'A'.repeat(33),
  estimateEnergy:async()=>({energyUsed:1}),readResources:async()=>({}),calculateBudget:()=>({}),assertBudget:()=>true,
  session:{address:owner,sessionId:1},
  verifySigner:async()=>{events.push('verify-signature')},
  verifyPermission:async()=>{events.push('verify-permission')},
  broadcastDeployment:async()=>{events.push('broadcast');return {result:true}},
 })
 await api.handle(req('POST',{operationId:'123e4567-e89b-42d3-a456-426614174000',intentSha256:'d'.repeat(64),confirmationPhrase:'CONFIRM TRӾ MAINNET DEPLOYMENT',signedTransaction:signed}),res(),new URL('https://api.test/api/owner/deployment/confirm'),null)
 assert.deepEqual(events,['verify-signature','verify-permission','persist-signed'])
 assert.equal(replies[0].status,200)
 assert.equal(replies[0].payload.deployment.state,'signed')
 assert.equal(events.includes('broadcast'),false)
})

test('deployment status exposes only the unsigned transaction while prepared and never exposes signed payloads', async()=>{
 const row={operation_id:'123e4567-e89b-42d3-a456-426614174000',owner_address:owner,state:'prepared',unsigned_transaction:{raw_data_hex:'aa'},signed_transaction:{signature:['bb']}}
 const db={async query(sql){if(sql.includes('to_regclass'))return {rows:[{deployments_table:'tron_transfer_deployments'}]};if(sql.includes('SELECT operation_id,owner_address,idempotency_key,intent,intent_sha256'))return {rows:[row]};return {rows:[]}}}
 const {api,replies}=make({database:db})
 await api.handle(req(),res(),new URL('https://api.test/api/owner/deployment/123e4567-e89b-42d3-a456-426614174000'),null)
 assert.equal(replies[0].status,200)
 assert.equal('signed_transaction' in replies[0].payload.deployment,false)
 assert.equal('unsigned_transaction' in replies[0].payload.deployment,false)
 assert.equal(replies[0].payload.unsignedTransaction.raw_data_hex,'aa')
 assert.equal(JSON.stringify(replies[0].payload).includes('signature'),false)
})

test('deployment signature failure blocks durable signing record and broadcast', async()=>{
 const events=[]
 const rawDataHex='bb'.repeat(32), txID=createHash('sha256').update(Buffer.from(rawDataHex,'hex')).digest('hex')
 const unsigned={txID,raw_data_hex:rawDataHex,raw_data:{expiration:Date.now()+120000,fee_limit:1000000,contract:[{type:'CreateSmartContract',parameter:{value:{owner_address:'41'+'11'.repeat(20),new_contract:{bytecode:'6000'}}}}]}}
 const signed={...unsigned,signature:['c'.repeat(130)]}
 const db={async query(sql){if(sql.includes('to_regclass'))return {rows:[{deployments_table:'tron_transfer_deployments'}]};if(sql.includes("SET state='confirming'"))return {rows:[{operation_id:'123e4567-e89b-42d3-a456-426614174000',owner_address:owner,intent:{feeLimitSun:'1000000'},intent_sha256:'d'.repeat(64),artifact_sha256:'4'.repeat(64),creation_bytecode_sha256:'2'.repeat(64),runtime_bytecode_sha256:'3'.repeat(64),transaction_id:unsigned.txID,unsigned_transaction:unsigned,state:'confirming'}]};return {rows:[]}}}
 const fakeTron={fullNode:{headers:{}},address:{toHex:()=> '41'+'11'.repeat(20)} ,trx:{}}
 const {api,replies}=make({
  env:{TRAX_DEPLOYMENT_EXECUTION_ENABLED:'true',TRAX_DEPLOYMENT_MAINNET_ACK:'CONFIRM_ARTIFACT_PINNED_TRAX_DEPLOYMENT',TRAX_DEPLOYMENT_LEDGER_DURABLE:'true',TRAX_DEPLOYMENT_LEDGER_BACKUP_VERIFIED:'true',TRAX_DEPLOYMENT_LEDGER_RESTORE_TESTED:'true'},
  database:db,tronWebFactory:()=>fakeTron,assertIntegrity:()=>true,predictAddress:()=> 'T'+'A'.repeat(33),
  estimateEnergy:async()=>({energyUsed:1}),readResources:async()=>({}),calculateBudget:()=>({}),assertBudget:()=>true,
  session:{address:owner,sessionId:1},
  verifySigner:async()=>{events.push('verify-signature');throw new Error('bad recovered signer')},
  verifyPermission:async()=>{events.push('verify-permission')},
  broadcastDeployment:async()=>{events.push('broadcast');return {result:true}},
 })
 await api.handle(req('POST',{operationId:'123e4567-e89b-42d3-a456-426614174000',intentSha256:'d'.repeat(64),confirmationPhrase:'CONFIRM TRӾ MAINNET DEPLOYMENT',signedTransaction:signed}),res(),new URL('https://api.test/api/owner/deployment/confirm'),null)
 assert.deepEqual(events,['verify-signature'])
 assert.equal(replies[0].status,503)
 assert.equal(events.includes('broadcast'),false)
})
