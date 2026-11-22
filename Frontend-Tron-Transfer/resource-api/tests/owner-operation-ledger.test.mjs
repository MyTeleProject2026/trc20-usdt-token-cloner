import test from 'node:test'
import assert from 'node:assert/strict'
import { createOwnerOperationLedger } from '../owner-operation-ledger.mjs'

const owner = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
function fakeDb() {
  const rows = new Map()
  const keys = new Map()
  return { rows, async query(sql, p) {
    if (sql.includes('INSERT INTO public.tron_transfer_owner_operations')) {
      const key = p[1] + ':' + p[2]
      if (keys.has(key)) return { rows: [] }
      const row = { operation_id:p[0], owner_address:p[1], idempotency_key:p[2], intent_hash:p[3], operation_type:p[4], transaction_id:null, state:'authorized', created_at:new Date().toISOString() }
      rows.set(p[0], row); keys.set(key,p[0]); return { rows:[row] }
    }
    if (sql.includes('WHERE owner_address=$1 AND idempotency_key=$2')) {
      const id = keys.get(p[0] + ':' + p[1]); return { rows:id ? [rows.get(id)] : [] }
    }
    if (sql.startsWith('SELECT state FROM')) {
      const row=rows.get(p[0]); return { rows:row && row.owner_address===p[1] ? [{state:row.state}] : [] }
    }
    if (sql.startsWith('UPDATE public.tron_transfer_owner_operations')) {
      const row=rows.get(p[0]); if (!row || row.owner_address!==p[1] || row.state!==p[7]) return {rows:[]}
      Object.assign(row,{state:p[2],transaction_id:p[3]||row.transaction_id,block_number:p[4]||row.block_number,failure_code:p[5]})
      return {rows:[row]}
    }
    if (sql.includes('WHERE operation_id=$1 AND owner_address=$2')) {
      const row=rows.get(p[0]); return {rows:row && row.owner_address===p[1] ? [row] : []}
    }
    throw new Error('unexpected-query')
  }}
}

test('Owner operation ledger records exact intent and safely replays idempotent requests', async () => {
  const db=fakeDb(), ledger=createOwnerOperationLedger({database:db})
  const input={ownerAddress:owner,idempotencyKey:'operation-request-0001',operationType:'external_credit',intent:{to:'T111111111111111111111111111111111',amount:'1000000'}}
  const first=await ledger.prepare(input)
  const replay=await ledger.prepare(input)
  assert.equal(first.replay,false); assert.equal(replay.replay,true); assert.equal(first.operation_id,replay.operation_id)
  await assert.rejects(ledger.prepare({...input,intent:{to:'T222222222222222222222222222222222',amount:'1000000'}}),/OWNER_LEDGER_IDEMPOTENCY_CONFLICT/)
})

test('Owner operation ledger enforces safe state transitions and transaction IDs', async () => {
  const ledger=createOwnerOperationLedger({database:fakeDb()})
  const row=await ledger.prepare({ownerAddress:owner,idempotencyKey:'operation-request-0002',operationType:'pause',intent:{paused:true}})
  await assert.rejects(ledger.transition({operationId:row.operation_id,ownerAddress:owner,nextState:'broadcast'}),/OWNER_LEDGER_TRANSITION_NOT_ALLOWED/)
  await ledger.transition({operationId:row.operation_id,ownerAddress:owner,nextState:'preflight_passed',preflight:{energy:true,bandwidth:true}})
  await ledger.transition({operationId:row.operation_id,ownerAddress:owner,nextState:'signed'})
  await ledger.transition({operationId:row.operation_id,ownerAddress:owner,nextState:'broadcast',transactionId:'a'.repeat(64)})
  await ledger.transition({operationId:row.operation_id,ownerAddress:owner,nextState:'confirmed',blockNumber:123})
  assert.equal((await ledger.get(row.operation_id,owner)).state,'confirmed')
  await assert.rejects(ledger.transition({operationId:row.operation_id,ownerAddress:owner,nextState:'failed'}),/OWNER_LEDGER_TRANSITION_NOT_ALLOWED/)
})

test('Owner operation ledger rejects invalid owner, idempotency and operation type', async () => {
  const ledger=createOwnerOperationLedger({database:fakeDb()})
  await assert.rejects(ledger.prepare({ownerAddress:'bad',idempotencyKey:'operation-request-0003',operationType:'pause',intent:{}}),/OWNER_LEDGER_ADDRESS_INVALID/)
  await assert.rejects(ledger.prepare({ownerAddress:owner,idempotencyKey:'short',operationType:'pause',intent:{}}),/OWNER_LEDGER_IDEMPOTENCY_KEY_INVALID/)
  await assert.rejects(ledger.prepare({ownerAddress:owner,idempotencyKey:'operation-request-0004',operationType:'arbitrary',intent:{}}),/OWNER_LEDGER_OPERATION_NOT_ALLOWED/)
})
