import { randomUUID } from 'node:crypto'

export const PRIVATE_TREASURY_VAULT_MINIMUM_USDT_BASE_UNITS = '1000000000'
export const PRIVATE_TREASURY_VAULT_USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UINT_PATTERN = /^(0|[1-9][0-9]{0,77})$/
const DIGEST_PATTERN = /^[0-9a-f]{64}$/
const IDENTIFIER_PATTERN = /^[^\u0000-\u001f\u007f]{1,200}$/
const MAX_PG_BIGINT = 9223372036854775807n

function qualifiedSchema(schema) {
  if (typeof schema !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
    throw new TypeError('Invalid Treasury Vault ledger schema identifier.')
  }
  return schema
}

function requiredIdentifier(value, name) {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value.trim())) {
    throw new TypeError('Invalid ' + name + '.')
  }
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
 * Atomically claims a read-only observation and records an internal reservation.
 *
 * This function performs database writes only. It has no provider, wallet,
 * signing, transaction-construction, broadcast, or payout-authorization API.
 * The reservation is an internal accounting control, not an external custody hold.
 */
export async function recordPrivateTreasuryVaultReservation(db, input, options = {}) {
  if (!db || typeof db.connect !== 'function') {
    throw new TypeError('A PostgreSQL pool with connect() is required.')
  }
  const schema = qualifiedSchema(options.schema || 'trc20_token_clone')
  const vaultId = input?.vaultId
  const requestId = input?.requestId
  if (typeof vaultId !== 'string' || !UUID_PATTERN.test(vaultId)) throw new TypeError('Invalid vault ID.')
  if (typeof requestId !== 'string' || !UUID_PATTERN.test(requestId)) throw new TypeError('Invalid request ID.')
  const receiptId = requiredIdentifier(input.receiptId, 'receipt ID')
  const observationId = requiredIdentifier(input.observationId, 'observation ID')
  const sequence = requiredSequence(input.sequence)
  const amountBaseUnits = requiredAmount(input.amountBaseUnits)
  const payloadDigest = String(input.payloadDigest ?? '')
  if (!DIGEST_PATTERN.test(payloadDigest)) throw new TypeError('Invalid observation payload digest.')

  const reservationId = input.reservationId || randomUUID()
  if (typeof reservationId !== 'string' || !UUID_PATTERN.test(reservationId)) {
    throw new TypeError('Invalid reservation ID.')
  }

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
    if (sequence <= previousSequence) {
      const error = new Error('Reservation sequence must be strictly greater than the last accepted sequence.')
      error.code = 'PRIVATE_TREASURY_VAULT_SEQUENCE_NOT_MONOTONIC'
      throw error
    }

    await client.query(
      'INSERT INTO ' + schema + '.private_treasury_observation_claims ' +
      '(vault_id, receipt_id, observation_id, reservation_sequence, payload_digest) ' +
      'VALUES ($1,$2,$3,$4,$5)',
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
      [reservationId, vaultId, 'reservation-created', JSON.stringify({
        sequence: sequence.toString(),
        receiptId,
        observationId,
        amountBaseUnits,
      })],
    )

    await client.query(
      'UPDATE ' + schema + '.private_treasury_observation_state ' +
      'SET last_sequence=$2, last_observation_id=$3, last_receipt_id=$4, updated_at=now() ' +
      'WHERE vault_id=$1',
      [vaultId, sequence.toString(), observationId, receiptId],
    )

    await client.query('COMMIT')
    transactionOpen = false
    return {
      reservationId,
      vaultId,
      requestId,
      sequence: sequence.toString(),
      amountBaseUnits,
      payoutAuthorized: false,
      executionEnabled: false,
    }
  } catch (error) {
    if (transactionOpen) {
      try { await client.query('ROLLBACK') } catch {}
    }
    throw error
  } finally {
    client.release()
  }
}
