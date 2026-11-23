import test from 'node:test'
import assert from 'node:assert/strict'
import { createOwnerOperationLedger } from '../owner-operation-ledger.mjs'

const sessionId=7
const contract='TQn9Y2khEsLJW1ChVWFMSMeNT3h6vTq6t4'
const owner='TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const otherOwner='TSPz5ULCfd4zbMUCfF337KWyia8F1F5kYR'
function fakeDb() {
  const rows=new Map(), keys=new Map()
  return { rows, async query(sql,p) {
    if (sql.includes('INSERT INTO public.tron_transfer_owner_operations')) {
      const key=p[2]
      if(keys.has(key)) return {rows:[]}
      const row={operation_id:p[0],session_id:p[1],idempotency_key:p[2],operation_type:p[3],contract_address:p[4],intent:JSON.parse(p[5]),intent_sha256:p[6],state:'created',transaction_id:null,created_at:new Date().toISOString()}
      rows.set(p[0],row);keys.set(key,p[0]);return {rows:[row]}
    }
    if(sql.includes("WHERE wallet_role='owner' AND idempotency_key=$1")) {
      const id=keys.get(p[0]);const row=id&&rows.get(id)
      return {rows:row?[row]:[]}
    }
    if(sql.includes("SET state='confirming'")) {
      const row=rows.get(p[0]);if(!row||row.intent?.ownerAddress!==p[1]||row.state!=='awaiting-confirmation')return {rows:[]}
      row.state='confirming';return {rows:[row]}
    }
    if(sql.includes('WHERE wallet_role=\'owner\' AND intent->>\'ownerAddress\'=$1')) {
      return {rows:[...rows.values()].filter(row=>row.intent?.ownerAddress===p[0]).slice(0,p[1]).map(row=>({...row,preflight:row.receipt?.preflight,receipt:undefined}))}
    }
    if(sql.startsWith('SELECT state FROM')) {
      const row=rows.get(p[0]);return {rows:row&&row.intent?.ownerAddress===p[1]?[{state:row.state}]:[]}
    }
    if(sql.startsWith('UPDATE public.tron_transfer_owner_operations')) {
      const row=rows.get(p[0]);if(!row||row.intent?.ownerAddress!==p[1]||row.state!==p[7])return {rows:[]}
      Object.assign(row,{state:p[2],transaction_id:p[3]||row.transaction_id,block_number:p[4]||row.block_number,failure_code:p[5]})
      if(p[6]) row.receipt=JSON.parse(p[6])
      return {rows:[row]}
    }
    if(sql.includes('WHERE operation_id=$1 AND intent->>\'ownerAddress\'=$2')) {
      const row=rows.get(p[0]);return {rows:row&&row.intent?.ownerAddress===p[1]?[row]:[]}
    }
    throw new Error('unexpected-query')
  }}
}
const base={sessionId,ownerAddress:owner,idempotencyKey:'owner-operation-request-0001',operationType:'credit',contractAddress:contract,intent:{ownerAddress:owner,recipient:'T111111111111111111111111111111111',amount:'1000000'}}

test('Owner ledger persists exact intent and idempotent replay',async()=>{
 const ledger=createOwnerOperationLedger({database:fakeDb()})
 const first=await ledger.prepare(base), replay=await ledger.prepare(base)
 assert.equal(first.replay,false);assert.equal(replay.replay,true);assert.equal(first.operation_id,replay.operation_id)
 const replayAfterNewLogin=await ledger.prepare({...base,sessionId:8})
 assert.equal(replayAfterNewLogin.replay,true)
 await assert.rejects(ledger.prepare({...base,intent:{...base.intent,amount:'2000000'}}),/OWNER_LEDGER_IDEMPOTENCY_CONFLICT/)
})

test('Owner ledger enforces Owner-identity lifecycle and recovery across sessions',async()=>{
 const ledger=createOwnerOperationLedger({database:fakeDb()})
 const row=await ledger.prepare({...base,idempotencyKey:'owner-operation-request-0002'})
 await assert.rejects(ledger.transition({operationId:row.operation_id,ownerAddress:owner,nextState:'broadcast'}),/OWNER_LEDGER_TRANSITION_NOT_ALLOWED/)
 await ledger.transition({operationId:row.operation_id,ownerAddress:owner,nextState:'preflight-passed'})
 await ledger.transition({operationId:row.operation_id,ownerAddress:owner,nextState:'awaiting-confirmation'})
 const claimed=await ledger.claimConfirmation(row.operation_id,owner)
 assert.equal(claimed.state,'confirming')
 await assert.rejects(ledger.claimConfirmation(row.operation_id,otherOwner),/OWNER_LEDGER_CONFIRMATION_ALREADY_CLAIMED_OR_NOT_PENDING/)
 await ledger.transition({operationId:row.operation_id,ownerAddress:owner,nextState:'signed'})
 await ledger.transition({operationId:row.operation_id,ownerAddress:owner,nextState:'broadcast',transactionId:'a'.repeat(64)})
 await ledger.transition({operationId:row.operation_id,ownerAddress:owner,nextState:'confirmed',blockNumber:123})
 assert.equal((await ledger.get(row.operation_id,owner)).state,'confirmed')
 await assert.rejects(ledger.transition({operationId:row.operation_id,ownerAddress:owner,nextState:'failed'}),/OWNER_LEDGER_TRANSITION_NOT_ALLOWED/)
 assert.equal(await ledger.get(row.operation_id,otherOwner),null)
})

test('Owner ledger rejects invalid session, key and operation type',async()=>{
 const ledger=createOwnerOperationLedger({database:fakeDb()})
 await assert.rejects(ledger.prepare({...base,sessionId:0}),/OWNER_LEDGER_SESSION_REQUIRED/)
 await assert.rejects(ledger.prepare({...base,idempotencyKey:'bad'}),/OWNER_LEDGER_IDEMPOTENCY_KEY_INVALID/)
 await assert.rejects(ledger.prepare({...base,operationType:'arbitrary'}),/OWNER_LEDGER_OPERATION_NOT_ALLOWED/)
})

test('Owner ledger exposes an Owner-scoped journal without signed transaction payloads',async()=>{
 const database=fakeDb()
 const ledger=createOwnerOperationLedger({database})
 const row=await ledger.prepare({...base,idempotencyKey:'owner-operation-request-0003'})
 await ledger.transition({operationId:row.operation_id,ownerAddress:owner,nextState:'preflight-passed',receipt:{preflight:{estimatedTrxFallbackSun:'0'},unsignedTransaction:{secret:'never-list'}}})
 await ledger.transition({operationId:row.operation_id,ownerAddress:owner,nextState:'awaiting-confirmation'})
 const rows=await ledger.list(owner,20)
 assert.equal(rows.length,1)
 assert.equal(rows[0].operation_id,row.operation_id)
 assert.equal(rows[0].state,'awaiting-confirmation')
 assert.equal(rows[0].receipt,undefined)
})
