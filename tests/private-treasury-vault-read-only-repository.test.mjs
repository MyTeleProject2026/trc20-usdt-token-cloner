import test from 'node:test'
import assert from 'node:assert/strict'
import { createPrivateTreasuryVaultReadOnlyRepository } from '../server/private-treasury-vault-read-only-repository.mjs'
const vaultId = '123e4567-e89b-42d3-a456-426614174000'
const trust = { configured: true, checkedAtMs: 1_800_000_000_000, trustedKeys: new Map(), revokedKeyIds: [] }
function fakePool({ failAt = null } = {}) {
  const calls = []
  const client = {
    async query(sql, params) {
      calls.push({ sql, params })
      if (sql === 'COMMIT' || sql === 'ROLLBACK' || sql.startsWith('BEGIN')) return { rows: [] }
      if (failAt && sql.includes(failAt)) throw Object.assign(new Error('test failure'), { code: 'XX000' })
      if (sql.includes('private_treasury_vaults')) return { rows: [{ vault_id: vaultId, network: 'mainnet', asset: 'USDT', token_contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6, vault_address: 'T'+'A'.repeat(33), active: true }] }
      if (sql.includes('private_treasury_observation_state')) return { rows: [{ last_sequence: '4', last_observation_id: 'observation-0004', last_receipt_id: 'receipt-00000004' }] }
      if (sql.includes('private_treasury_observation_claims')) return { rows: [{ receipt_id: 'receipt-00000004', observation_id: 'observation-0004' }] }
      if (sql.includes('private_treasury_reservations')) return { rows: [{ reservation_id: '123e4567-e89b-42d3-a456-426614174001', request_id: '123e4567-e89b-42d3-a456-426614174002', reservation_sequence: '4', amount_base_units: '1000000000', created_at: new Date(0) }] }
      throw new Error('unexpected SQL')
    },
    release() { calls.push({ released: true }) },
  }
  return { calls, async connect() { return client } }
}
test('reads a consistent repeatable-read snapshot in a read-only transaction', async () => {
  const pool = fakePool()
  const result = await createPrivateTreasuryVaultReadOnlyRepository(pool).readSnapshot(vaultId, trust)
  assert.equal(result.success, true)
  assert.equal(result.vault.network, 'mainnet')
  assert.equal(result.ledgerState.lastSequence, '4')
  assert.deepEqual(result.replayState.seenReceiptIds, ['receipt-00000004'])
  assert.equal(pool.calls[0].sql, 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(pool.calls.filter((call) => call.sql === 'COMMIT').length, 1)
  assert.ok(pool.calls.findIndex((call) => call.sql === 'COMMIT') < pool.calls.findIndex((call) => call.released))
  assert.ok(pool.calls.every(({ sql }) => !sql || /^(BEGIN|COMMIT|ROLLBACK)|^SELECT /i.test(sql)))
  assert.ok(pool.calls.some((call) => call.released))
})
test('reads the full immutable claim history rather than truncating replay protection', async () => {
  const pool = fakePool()
  await createPrivateTreasuryVaultReadOnlyRepository(pool).readSnapshot(vaultId, trust)
  const claimsQuery = pool.calls.find((call) => call.sql?.includes('private_treasury_observation_claims'))
  assert.ok(claimsQuery)
  assert.doesNotMatch(claimsQuery.sql, /LIMIT/i)
})
test('does not initialize schema or access database for malformed IDs or missing trust', async () => {
  const pool = fakePool()
  const repository = createPrivateTreasuryVaultReadOnlyRepository(pool)
  await assert.rejects(repository.readSnapshot('bad-id', trust), /Invalid Treasury Vault ID/)
  assert.equal((await repository.readSnapshot(vaultId, { ...trust, configured: false })).success, false)
  assert.equal(pool.calls.length, 0)
})
test('rolls back and releases connection on query failure', async () => {
  const pool = fakePool({ failAt: 'private_treasury_observation_claims' })
  const result = await createPrivateTreasuryVaultReadOnlyRepository(pool).readSnapshot(vaultId, trust)
  assert.equal(result.reason, 'database-read-failed')
  assert.ok(pool.calls.some((call) => call.sql === 'ROLLBACK'))
  assert.ok(pool.calls.some((call) => call.released))
})
test('rejects unsafe schema identifiers before issuing SQL', () => {
  const pool = fakePool()
  assert.throws(() => createPrivateTreasuryVaultReadOnlyRepository(pool, { schema: 'x; DROP SCHEMA public' }), /Invalid/)
  assert.equal(pool.calls.length, 0)
})

test('returns a fail-closed result when PostgreSQL connection acquisition fails', async () => {
  const pool = {
    async connect() {
      throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })
    },
  }
  const result = await createPrivateTreasuryVaultReadOnlyRepository(pool).readSnapshot(vaultId, trust)
  assert.equal(result.success, false)
  assert.equal(result.reason, 'database-read-failed')
  assert.equal(result.databaseCode, 'ECONNREFUSED')
})
