import { createHash, randomUUID } from 'node:crypto'

const STATES = new Set(['authorized','preflight_passed','signed','broadcast','confirmed','failed','rejected','unknown'])
const TRANSITIONS = Object.freeze({
  authorized: new Set(['preflight_passed','rejected','failed']),
  preflight_passed: new Set(['signed','rejected','failed']),
  signed: new Set(['broadcast','failed','unknown']),
  broadcast: new Set(['confirmed','failed','unknown']),
  unknown: new Set(['broadcast','confirmed','failed']),
  confirmed: new Set(),
  failed: new Set(),
  rejected: new Set(),
})
const OPERATION_TYPES = new Set([
  'deploy','owner_credit','external_credit','batch_credit','transfer',
  'pause','unpause','enable_minting','disable_minting','propose_owner','accept_owner',
])

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}
function hash(value) { return createHash('sha256').update(value).digest('hex') }
function fail(code) { throw Object.assign(new Error(code), { code }) }

/**
 * Durable, idempotent journal for authenticated Owner operations.
 * This module deliberately does not sign or broadcast. A transaction engine
 * must complete preflight and advance states using transition() before
 * connecting a signer; the database record is the recovery authority.
 */
export function createOwnerOperationLedger({ database }) {
  if (!database || typeof database.query !== 'function') fail('OWNER_LEDGER_DATABASE_REQUIRED')

  async function prepare({ ownerAddress, idempotencyKey, operationType, contractAddress = null, intent }) {
    if (typeof ownerAddress !== 'string' || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(ownerAddress)) fail('OWNER_LEDGER_ADDRESS_INVALID')
    if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) fail('OWNER_LEDGER_IDEMPOTENCY_KEY_INVALID')
    if (!OPERATION_TYPES.has(operationType)) fail('OWNER_LEDGER_OPERATION_NOT_ALLOWED')
    if (!intent || typeof intent !== 'object' || Array.isArray(intent)) fail('OWNER_LEDGER_INTENT_INVALID')
    const serialized = canonical(intent)
    if (serialized.length > 32768) fail('OWNER_LEDGER_INTENT_TOO_LARGE')
    const intentHash = hash(operationType + ':' + serialized)
    const operationId = randomUUID()
    const result = await database.query(`
      INSERT INTO public.tron_transfer_owner_operations
        (operation_id, owner_address, idempotency_key, intent_hash, operation_type, contract_address, intent, state)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'authorized')
      ON CONFLICT (owner_address,idempotency_key) DO NOTHING
      RETURNING operation_id,state,intent_hash,operation_type,transaction_id,created_at
    `, [operationId, ownerAddress, idempotencyKey, intentHash, operationType, contractAddress, serialized])
    if (result.rows?.[0]) return { ...result.rows[0], replay: false }
    const existing = await database.query(`
      SELECT operation_id,state,intent_hash,operation_type,transaction_id,created_at
      FROM public.tron_transfer_owner_operations
      WHERE owner_address=$1 AND idempotency_key=$2
    `, [ownerAddress, idempotencyKey])
    const row = existing.rows?.[0]
    if (!row) fail('OWNER_LEDGER_IDEMPOTENCY_LOOKUP_FAILED')
    if (row.intent_hash !== intentHash || row.operation_type !== operationType) fail('OWNER_LEDGER_IDEMPOTENCY_CONFLICT')
    return { ...row, replay: true }
  }

  async function transition({ operationId, ownerAddress, nextState, transactionId = null, blockNumber = null, failureCode = null, preflight = null }) {
    if (!STATES.has(nextState)) fail('OWNER_LEDGER_STATE_INVALID')
    if (transactionId !== null && !/^[0-9a-f]{64}$/i.test(String(transactionId))) fail('OWNER_LEDGER_TXID_INVALID')
    const current = await database.query(
      'SELECT state FROM public.tron_transfer_owner_operations WHERE operation_id=$1 AND owner_address=$2',
      [operationId, ownerAddress],
    )
    const state = current.rows?.[0]?.state
    if (!state) fail('OWNER_LEDGER_OPERATION_NOT_FOUND')
    if (!TRANSITIONS[state]?.has(nextState)) fail('OWNER_LEDGER_TRANSITION_NOT_ALLOWED')
    const result = await database.query(`
      UPDATE public.tron_transfer_owner_operations
      SET state=$3, transaction_id=COALESCE($4,transaction_id),
          block_number=COALESCE($5,block_number), failure_code=$6,
          preflight=CASE WHEN $7::jsonb IS NULL THEN preflight ELSE $7::jsonb END,
          updated_at=now(), confirmed_at=CASE WHEN $3='confirmed' THEN now() ELSE confirmed_at END
      WHERE operation_id=$1 AND owner_address=$2 AND state=$8
      RETURNING operation_id,state,transaction_id,block_number,updated_at,confirmed_at
    `, [operationId, ownerAddress, nextState, transactionId, blockNumber, failureCode, preflight === null ? null : JSON.stringify(preflight), state])
    if (!result.rows?.[0]) fail('OWNER_LEDGER_CONCURRENT_TRANSITION')
    return result.rows[0]
  }

  async function get(operationId, ownerAddress) {
    const result = await database.query(`
      SELECT operation_id,owner_address,idempotency_key,intent_hash,operation_type,
        contract_address,intent,state,transaction_id,block_number,failure_code,
        preflight,created_at,updated_at,confirmed_at
      FROM public.tron_transfer_owner_operations
      WHERE operation_id=$1 AND owner_address=$2
    `, [operationId, ownerAddress])
    return result.rows?.[0] || null
  }

  return Object.freeze({ prepare, transition, get })
}
