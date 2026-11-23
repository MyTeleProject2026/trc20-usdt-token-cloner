import test from 'node:test'
import assert from 'node:assert/strict'
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
