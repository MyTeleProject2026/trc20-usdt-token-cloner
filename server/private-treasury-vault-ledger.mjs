import { randomUUID } from 'node:crypto'
import { isVerifiedPrivateTreasuryVaultObservation } from './private-treasury-vault-observation.mjs'

export const PRIVATE_TREASURY_VAULT_MINIMUM_USDT_BASE_UNITS = '1000000000'
export const PRIVATE_TREASURY_VAULT_USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UINT_PATTERN = /^(0|[1-9][0-9]{0,77})$/
const DIGEST_PATTERN = /^[0-9a-f]{64}$/
const IDENTIFIER_PATTERN = /^[^\u0000-\u001f\u007f]{1,200}$/
const MAX_PG_BIGINT = 9223372036854775807n
const MAX_TRUST_SNAPSHOT_AGE_MS = 60_000

function qualifiedSchema(schema) {
  if (typeof schema !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new TypeError('Invalid Treasury Vault ledger schema identifier.')
  return schema
}
function requiredIdentifier(value, name) {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value.trim())) throw new TypeError('Invalid ' + name + '.')
  return value.trim()
}
function requiredSequence(value) {
  const text = String(value ?? '')
  if (!/^[1-9][0-9]{0,18}$/.test(text)) throw new TypeError('Invalid reservation sequence.')
  const sequence = BigInt(text)
  if (sequence > MAX_PG_BIGINT) throw new TypeError('Reservation sequence exceeds PostgreSQL BIGINT.')
  return sequence
}
function requiredAmount(value) {
  const amount = String(value ?? '')
  if (!UINT_PATTERN.test(amount) || BigInt(amount) < BigInt(PRIVATE_TREASURY_VAULT_MINIMUM_USDT_BASE_UNITS)) {
    throw new RangeError('Reservation amount is below the 1,000 USDT minimum or is invalid.')
  }
  return amount
}

/**
 * Atomically claims a cryptographically verified observation and records an
 * internal accounting reservation. It cannot authorize or execute a payout.
 * All receipt identity, sequence and digest fields are derived from the branded
 * verifier result; callers cannot override them.
 */
export async function recordPrivateTreasuryVaultReservation(db, input, options = {}) {
  if (!db || typeof db.connect !== 'function') throw new TypeError('A PostgreSQL pool with connect() is required.')
  const schema = qualifiedSchema(options.schema || 'trc20_token_clone')
  const verifiedObservation = input?.verifiedObservation
  if (!isVerifiedPrivateTreasuryVaultObservation(verifiedObservation)
    || verifiedObservation.valid !== true
    || verifiedObservation.limitations?.sourceObservationCryptographicallyAttested !== true
    || verifiedObservation.limitations?.payoutAuthorized !== false
    || verifiedObservation.limitations?.ledgerMutationPerformed !== false
    || verifiedObservation.limitations?.reservationCreated !== false
    || verifiedObservation.limitations?.signingRequestCreated !== false
    || verifiedObservation.limitations?.signatureProduced !== false
    || verifiedObservation.limitations?.transactionSigned !== false
    || verifiedObservation.limitations?.broadcastAttempted !== false
    || verifiedObservation.limitations?.mainnetExecutionEnabled !== false) {
    const error = new Error('A cryptographically verified read-only Treasury Vault observation is required.')
    error.code = 'PRIVATE_TREASURY_VAULT_VERIFIED_OBSERVATION_REQUIRED'
    throw error
  }
  const nowMs = options.nowMs ?? Date.now()
  const maxTrustSnapshotAgeMs = options.maxTrustSnapshotAgeMs ?? MAX_TRUST_SNAPSHOT_AGE_MS
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0
    || !Number.isSafeInteger(maxTrustSnapshotAgeMs) || maxTrustSnapshotAgeMs < 1
    || maxTrustSnapshotAgeMs > MAX_TRUST_SNAPSHOT_AGE_MS
    || !Number.isSafeInteger(verifiedObservation.trustRegistryCheckedAtMs)
    || verifiedObservation.trustRegistryCheckedAtMs > nowMs + 5_000
    || nowMs - verifiedObservation.trustRegistryCheckedAtMs > maxTrustSnapshotAgeMs
    || !Number.isSafeInteger(verifiedObservation.expiresAtMs)
    || verifiedObservation.expiresAtMs <= nowMs) {
    const error = new Error('Verified Treasury Vault observation or trust snapshot is stale.')
    error.code = 'PRIVATE_TREASURY_VAULT_VERIFIED_OBSERVATION_STALE'
    throw error
  }
  const vaultId = verifiedObservation.vaultId
  const requestId = input?.requestId
  if (typeof vaultId !== 'string' || !UUID_PATTERN.test(vaultId)) throw new TypeError('Invalid verified vault ID.')
  if (typeof requestId !== 'string' || !UUID_PATTERN.test(requestId)) throw new TypeError('Invalid request ID.')
  const receiptId = requiredIdentifier(verifiedObservation.receiptId, 'verified receipt ID')
  const observationId = requiredIdentifier(verifiedObservation.observationId, 'verified observation ID')
  const sequence = requiredSequence(verifiedObservation.reservation?.sequence)
  const amountBaseUnits = requiredAmount(input?.amountBaseUnits)
  const availableBaseUnits = String(verifiedObservation.assets?.usdt?.availableBaseUnits ?? '')
  if (!UINT_PATTERN.test(availableBaseUnits) || BigInt(amountBaseUnits) > BigInt(availableBaseUnits)) {
    const error = new RangeError('Reservation amount exceeds the verified available USDT balance.')
    error.code = 'PRIVATE_TREASURY_VAULT_AMOUNT_EXCEEDS_VERIFIED_BALANCE'
    throw error
  }
  const payloadDigest = String(verifiedObservation.payloadDigest ?? '')
  if (!DIGEST_PATTERN.test(payloadDigest)) throw new TypeError('Verified observation payload digest is invalid.')
  if (verifiedObservation.assets?.usdt?.contract !== PRIVATE_TREASURY_VAULT_USDT_CONTRACT
    || verifiedObservation.assets?.usdt?.decimals !== 6
    || typeof verifiedObservation.treasuryAddress !== 'string' || !verifiedObservation.treasuryAddress.trim()) {
    throw new TypeError('Verified observation asset or treasury binding is invalid.')
  }

  const reservationId = randomUUID()
  const client = await db.connect()
  let transactionOpen = false
  try {
    await client.query('BEGIN')
    transactionOpen = true
    const locked = await client.query(
      'SELECT v.network, v.asset, v.token_contract, v.decimals, v.active, s.last_sequence ' +
      'FROM ' + schema + '.private_treasury_vaults v ' +
      'JOIN ' + schema + '.private_treasury_observation_state s ON s.vault_id=v.vault_id ' +
      'WHERE v.vault_id=$1 FOR UPDATE OF s',
      [vaultId],
    )
    const vault = locked.rows?.[0]
    if (!vault || vault.active !== true || vault.network !== 'mainnet' || vault.asset !== 'USDT'
      || vault.token_contract !== PRIVATE_TREASURY_VAULT_USDT_CONTRACT || Number(vault.decimals) !== 6) {
      const error = new Error('Treasury Vault is missing, inactive, or has an unsupported asset binding.')
      error.code = 'PRIVATE_TREASURY_VAULT_UNAVAILABLE'
      throw error
    }
    const previousSequence = BigInt(String(vault.last_sequence))
    if (sequence !== previousSequence + 1n) {
      const error = new Error('Reservation sequence must be exactly the next sequence.')
      error.code = 'PRIVATE_TREASURY_VAULT_SEQUENCE_NOT_NEXT'
      throw error
    }
    await client.query(
      'INSERT INTO ' + schema + '.private_treasury_observation_claims ' +
      '(vault_id, receipt_id, observation_id, reservation_sequence, payload_digest) VALUES ($1,$2,$3,$4,$5)',
      [vaultId, receiptId, observationId, sequence.toString(), payloadDigest],
    )
    await client.query(
      'INSERT INTO ' + schema + '.private_treasury_reservations ' +
      '(reservation_id, vault_id, request_id, receipt_id, observation_id, reservation_sequence, amount_base_units) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [reservationId, vaultId, requestId, receiptId, observationId, sequence.toString(), amountBaseUnits],
    )
    await client.query(
      'INSERT INTO ' + schema + '.private_treasury_reservation_events ' +
      '(reservation_id, vault_id, event_type, event_data) VALUES ($1,$2,$3,$4::jsonb)',
      [reservationId, vaultId, 'reservation-created', JSON.stringify({ sequence: sequence.toString(), receiptId, observationId, amountBaseUnits, payloadDigest })],
    )
    await client.query(
      'UPDATE ' + schema + '.private_treasury_observation_state ' +
      'SET last_sequence=$2, last_observation_id=$3, last_receipt_id=$4, updated_at=now() WHERE vault_id=$1',
      [vaultId, sequence.toString(), observationId, receiptId],
    )
    await client.query('COMMIT')
    transactionOpen = false
    return { reservationId, vaultId, requestId, sequence: sequence.toString(), amountBaseUnits, payoutAuthorized: false, executionEnabled: false }
  } catch (error) {
    if (transactionOpen) { try { await client.query('ROLLBACK') } catch {} }
    throw error
  } finally {
    client.release()
  }
}
