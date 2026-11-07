const DEFAULT_SCHEMA = 'trc20_token_clone'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
function schemaName(value) {
  if (typeof value !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new TypeError('Invalid Treasury Vault read schema.')
  return value
}
function validVaultId(value) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw new TypeError('Invalid Treasury Vault ID.')
  return value
}
const rows = (result) => Array.isArray(result?.rows) ? result.rows : []

/**
 * Read-only PostgreSQL repository for the private financial Treasury Vault.
 * No migrations, initialization, DDL, inserts, updates, deletes, or write
 * transactions are performed. Claims are read without a row limit because
 * replay protection must cover the complete immutable claim history.
 */
export function createPrivateTreasuryVaultReadOnlyRepository(db, { schema = DEFAULT_SCHEMA } = {}) {
  const tableSchema = schemaName(schema)
  if (!db || typeof db.connect !== 'function') throw new TypeError('A PostgreSQL pool with connect() is required.')

  async function readSnapshot(id, trustSnapshot) {
    const targetVaultId = validVaultId(id)
    if (!trustSnapshot || trustSnapshot.configured !== true
      || !(trustSnapshot.trustedKeys instanceof Map)
      || !Array.isArray(trustSnapshot.revokedKeyIds)
      || !Number.isSafeInteger(trustSnapshot.checkedAtMs)) {
      return { success: false, reason: 'financial-vault-trust-snapshot-unavailable' }
    }

    const client = await db.connect()
    let transactionOpen = false
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      transactionOpen = true
      const vaultResult = await client.query(
        'SELECT vault_id::text AS vault_id, network, asset, token_contract, decimals, vault_address, active ' +
        'FROM ' + tableSchema + '.private_treasury_vaults WHERE vault_id=$1', [targetVaultId])
      const stateResult = await client.query(
        'SELECT last_sequence::text AS last_sequence, last_observation_id, last_receipt_id ' +
        'FROM ' + tableSchema + '.private_treasury_observation_state WHERE vault_id=$1', [targetVaultId])
      const claimsResult = await client.query(
        'SELECT receipt_id, observation_id FROM ' + tableSchema + '.private_treasury_observation_claims ' +
        'WHERE vault_id=$1 ORDER BY reservation_sequence DESC', [targetVaultId])
      const reservationsResult = await client.query(
        'SELECT reservation_id::text AS reservation_id, request_id::text AS request_id, ' +
        'reservation_sequence::text AS reservation_sequence, amount_base_units::text AS amount_base_units, created_at ' +
        'FROM ' + tableSchema + '.private_treasury_reservations WHERE vault_id=$1 ' +
        'ORDER BY reservation_sequence DESC LIMIT 1000', [targetVaultId])
      await client.query('COMMIT')
      transactionOpen = false

      const vault = rows(vaultResult)[0]
      const state = rows(stateResult)[0]
      if (!vault || !state) return { success: false, reason: 'financial-vault-or-observation-state-not-found' }
      const claims = rows(claimsResult)
      const reservations = rows(reservationsResult)
      return Object.freeze({
        success: true,
        vault: Object.freeze({
          vaultId: vault.vault_id, network: vault.network, asset: vault.asset,
          tokenContract: vault.token_contract, decimals: Number(vault.decimals),
          treasuryAddress: vault.vault_address, active: vault.active === true,
        }),
        replayState: Object.freeze({
          trustedKeys: trustSnapshot.trustedKeys,
          revokedKeyIds: trustSnapshot.revokedKeyIds,
          trustRegistryCheckedAtMs: trustSnapshot.checkedAtMs,
          seenReceiptIds: Object.freeze(claims.map((claim) => claim.receipt_id)),
          seenObservationIds: Object.freeze(claims.map((claim) => claim.observation_id)),
        }),
        ledgerState: Object.freeze({
          lastSequence: String(state.last_sequence),
          lastObservationId: state.last_observation_id,
          lastReceiptId: state.last_receipt_id,
          reservations: Object.freeze(reservations.map((row) => Object.freeze({
            reservationId: row.reservation_id, requestId: row.request_id,
            sequence: String(row.reservation_sequence), amountBaseUnits: String(row.amount_base_units),
            createdAt: row.created_at,
          }))),
        }),
      })
    } catch (error) {
      if (transactionOpen) { try { await client.query('ROLLBACK') } catch {} }
      return { success: false, reason: 'database-read-failed', databaseCode: error?.code || null }
    } finally {
      client.release()
    }
  }
  return Object.freeze({ readSnapshot })
}
