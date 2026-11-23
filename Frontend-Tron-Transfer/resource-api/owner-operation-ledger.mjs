import { createHash, randomUUID } from 'node:crypto'

const TRANSITIONS = Object.freeze({
  created: new Set(['preflight-passed','cancelled','failed']),
  'preflight-passed': new Set(['awaiting-confirmation','cancelled','failed']),
  'awaiting-confirmation': new Set(['confirming','cancelled']),
  confirming: new Set(['signed','failed']),
  signed: new Set(['broadcast-unknown','broadcast','failed']),
  'broadcast-unknown': new Set(['broadcast','confirmed','failed']),
  broadcast: new Set(['confirmed','failed','broadcast-unknown']),
  confirmed: new Set(), failed: new Set(), cancelled: new Set(),
})
const OPERATION_TYPES = new Set(['deploy','owner-issue','credit','batch-credit','transfer','pause','unpause','minting-enable','minting-disable','ownership-transfer','ownership-accept'])
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
  return JSON.stringify(value)
}
function fail(code) { throw Object.assign(new Error(code), { code }) }
function hash(value) { return createHash('sha256').update(value).digest('hex') }

/** Durable, session-scoped idempotency and recovery journal for Owner operations. */
export function createOwnerOperationLedger({ database }) {
  if (!database || typeof database.query !== 'function') fail('OWNER_LEDGER_DATABASE_REQUIRED')

  async function prepare({ sessionId, idempotencyKey, operationType, contractAddress, intent }) {
    if (!Number.isSafeInteger(Number(sessionId)) || Number(sessionId) <= 0) fail('OWNER_LEDGER_SESSION_REQUIRED')
    if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{16,160}$/.test(idempotencyKey)) fail('OWNER_LEDGER_IDEMPOTENCY_KEY_INVALID')
    if (!OPERATION_TYPES.has(operationType)) fail('OWNER_LEDGER_OPERATION_NOT_ALLOWED')
    if (typeof contractAddress !== 'string' || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(contractAddress)) fail('OWNER_LEDGER_CONTRACT_ADDRESS_INVALID')
    if (!intent || typeof intent !== 'object' || Array.isArray(intent)) fail('OWNER_LEDGER_INTENT_INVALID')
    const serialized = canonical(intent)
    if (serialized.length > 32768) fail('OWNER_LEDGER_INTENT_TOO_LARGE')
    const intentSha256 = hash(operationType + ':' + serialized)
    const operationId = randomUUID()
    const inserted = await database.query(`
      INSERT INTO public.tron_transfer_owner_operations
        (operation_id,wallet_role,session_id,idempotency_key,operation_type,contract_address,intent,intent_sha256,state)
      VALUES ($1,'owner',$2,$3,$4,$5,$6::jsonb,$7,'created')
      ON CONFLICT (wallet_role,idempotency_key) DO NOTHING
      RETURNING operation_id,state,intent_sha256,operation_type,transaction_id,created_at
    `, [operationId, Number(sessionId), idempotencyKey, operationType, contractAddress, serialized, intentSha256])
    if (inserted.rows?.[0]) return { ...inserted.rows[0], replay: false }
    const existing = await database.query(`
      SELECT operation_id,state,intent_sha256,operation_type,transaction_id,created_at
      FROM public.tron_transfer_owner_operations
      WHERE wallet_role='owner' AND idempotency_key=$1 AND session_id=$2
    `, [idempotencyKey, Number(sessionId)])
    const row = existing.rows?.[0]
    if (!row || row.intent_sha256 !== intentSha256 || row.operation_type !== operationType) fail('OWNER_LEDGER_IDEMPOTENCY_CONFLICT')
    return { ...row, replay: true }
  }

  async function transition({ operationId, sessionId, nextState, transactionId = null, blockNumber = null, failureCode = null, receipt = null }) {
    if (!TRANSITIONS[nextState]) fail('OWNER_LEDGER_STATE_INVALID')
    if (transactionId !== null && !/^[0-9a-f]{64}$/i.test(String(transactionId))) fail('OWNER_LEDGER_TXID_INVALID')
    const current = await database.query(
      "SELECT state FROM public.tron_transfer_owner_operations WHERE operation_id=$1 AND session_id=$2 AND wallet_role='owner'",
      [operationId, Number(sessionId)],
    )
    const state = current.rows?.[0]?.state
    if (!state) fail('OWNER_LEDGER_OPERATION_NOT_FOUND')
    if (!TRANSITIONS[state]?.has(nextState)) fail('OWNER_LEDGER_TRANSITION_NOT_ALLOWED')
    const result = await database.query(`
      UPDATE public.tron_transfer_owner_operations
      SET state=$3, transaction_id=COALESCE($4,transaction_id),
          block_number=COALESCE($5,block_number), failure_code=$6,
          receipt=CASE WHEN $7::jsonb IS NULL THEN receipt ELSE $7::jsonb END,
          updated_at=now(),
          signed_at=CASE WHEN $3='signed' THEN now() ELSE signed_at END,
          broadcast_at=CASE WHEN $3 IN ('broadcast','broadcast-unknown') THEN now() ELSE broadcast_at END,
          confirmed_at=CASE WHEN $3='confirmed' THEN now() ELSE confirmed_at END
      WHERE operation_id=$1 AND session_id=$2 AND state=$8 AND wallet_role='owner'
      RETURNING operation_id,state,transaction_id,block_number,updated_at,confirmed_at
    `, [operationId, Number(sessionId), nextState, transactionId, blockNumber, failureCode, receipt === null ? null : JSON.stringify(receipt), state])
    if (!result.rows?.[0]) fail('OWNER_LEDGER_CONCURRENT_TRANSITION')
    return result.rows[0]
  }

  async function claimConfirmation(operationId, sessionId) {
    const result = await database.query(`
      UPDATE public.tron_transfer_owner_operations
      SET state='confirming',updated_at=now()
      WHERE operation_id=$1 AND session_id=$2 AND wallet_role='owner' AND state='awaiting-confirmation'
      RETURNING operation_id,session_id,idempotency_key,operation_type,contract_address,
        intent,intent_sha256,state,transaction_id,block_number,receipt,failure_code,
        created_at,updated_at,signed_at,broadcast_at,confirmed_at
    `, [operationId, Number(sessionId)])
    if (!result.rows?.[0]) fail('OWNER_LEDGER_CONFIRMATION_ALREADY_CLAIMED_OR_NOT_PENDING')
    return result.rows[0]
  }

  async function get(operationId, sessionId) {
    const result = await database.query(`
      SELECT operation_id,session_id,idempotency_key,operation_type,contract_address,
        intent,intent_sha256,state,transaction_id,block_number,receipt,failure_code,
        created_at,updated_at,signed_at,broadcast_at,confirmed_at
      FROM public.tron_transfer_owner_operations
      WHERE operation_id=$1 AND session_id=$2 AND wallet_role='owner'
    `, [operationId, Number(sessionId)])
    return result.rows?.[0] || null
  }
  return Object.freeze({ prepare, transition, claimConfirmation, get })
}
