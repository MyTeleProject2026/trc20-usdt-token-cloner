import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { canonicalizePrivateTreasuryVaultObservationPayload, verifyPrivateTreasuryVaultObservation } from '../server/private-treasury-vault-observation.mjs'
import { recordPrivateTreasuryVaultReservation } from '../server/private-treasury-vault-ledger.mjs'

const { Pool } = pg
const integrationEnabled = process.env.PRIVATE_TREASURY_VAULT_PG_INTEGRATION === '1'
const databaseUrl = process.env.DATABASE_URL || ''
const minimum = '1000000000'
const now = 1_800_000_000_000
const issuer = 'private-vault-gateway'
const audience = 'tron-transfer-private-treasury'
const address = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const trustedKeys = { 'vault-ed25519-01': {
  status: 'active', issuer, audiences: [audience],
  publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
  notBeforeMs: now - 86_400_000, notAfterMs: now + 86_400_000,
} }

function assertDedicatedLocalTestDatabase(value) {
  let parsed
  try { parsed = new URL(value) } catch { throw new Error('PRIVATE_TREASURY_VAULT_PG_INTEGRATION requires a valid DATABASE_URL') }
  const databaseName = decodeURIComponent(parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname)
  if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) || databaseName !== 'sponsor_test') {
    throw new Error('Refusing Treasury Vault integration tests outside the local dedicated sponsor_test database')
  }
}
function verifiedObservation(vaultId, sequence, suffix, available = '1500000000', overrides = {}) {
  const payload = {
    schema: 'tron-transfer.private-treasury-vault-observation.v1', issuer, audience,
    receiptId: 'receipt-' + suffix, observationId: 'observation-' + suffix,
    vaultId, network: 'TRON_MAINNET', treasuryAddress: address,
    issuedAtMs: now - 1000, observedAtMs: now - 2000, expiresAtMs: now + 20_000,
    chain: { blockNumber: 99_123_456, blockId: 'a'.repeat(64), finality: 'solidified' },
    assets: {
      usdt: { contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6, balanceBaseUnits: '2000000000', reservedBaseUnits: String(2_000_000_000n - BigInt(available)), availableBaseUnits: available },
      trx: { balanceSun: '9000000', reservedSun: '1000000', availableSun: '8000000' },
    },
    resources: { freeBandwidthLimit: '1500', freeBandwidthUsed: '200', stakedBandwidthLimit: '1200', stakedBandwidthUsed: '300', energyLimit: '5000', energyUsed: '1000' },
    reservation: { sequence, snapshotId: 'snapshot-' + suffix }, ...overrides,
  }
  const signature = sign(null, Buffer.from(canonicalizePrivateTreasuryVaultObservationPayload(payload)), privateKey).toString('base64url')
  return verifyPrivateTreasuryVaultObservation({ payload, signature: { algorithm: 'Ed25519', keyId: 'vault-ed25519-01', value: signature } }, {
    expectedIssuer: issuer, expectedAudience: audience, expectedVaultId: vaultId,
    expectedTreasuryAddress: address, minimumUsdtBaseUnits: minimum, trustedKeys,
    revokedKeyIds: [], trustRegistryCheckedAtMs: now, seenReceiptIds: [], seenObservationIds: [], nowMs: now,
  })
}

test('isolated PostgreSQL Treasury Vault schema enforces verified claims and exact-next sequence atomically', {
  skip: !integrationEnabled && 'Set PRIVATE_TREASURY_VAULT_PG_INTEGRATION=1 with the dedicated local sponsor_test database',
}, async () => {
  assertDedicatedLocalTestDatabase(databaseUrl)
  const pool = new Pool({ connectionString: databaseUrl, max: 8 })
  const schema = 'private_treasury_vault_test_' + randomUUID().replace(/-/g, '').slice(0, 12)
  const vaultId = randomUUID()
  const migration = await readFile(new URL('../server/migrations/20261108_private_treasury_vault_reservation_ledger_stage7c.sql', import.meta.url), 'utf8')
  const isolatedMigration = migration.replaceAll('trc20_token_clone', schema)
  const input = (sequence, suffix, overrides = {}) => ({ verifiedObservation: verifiedObservation(vaultId, sequence, suffix), requestId: randomUUID(), amountBaseUnits: minimum, ...overrides })
  const counts = async () => {
    const result = await pool.query(
      'SELECT (SELECT COUNT(*) FROM ' + schema + '.private_treasury_observation_claims WHERE vault_id=$1)::int AS claims, ' +
      '(SELECT COUNT(*) FROM ' + schema + '.private_treasury_reservations WHERE vault_id=$1)::int AS reservations, ' +
      '(SELECT COUNT(*) FROM ' + schema + '.private_treasury_reservation_events WHERE vault_id=$1)::int AS events', [vaultId])
    return result.rows[0]
  }
  try {
    await pool.query(isolatedMigration)
    await pool.query(
      'INSERT INTO ' + schema + '.private_treasury_vaults (vault_id, network, asset, token_contract, decimals, vault_address) ' +
      'VALUES ($1,\'mainnet\',\'USDT\',\'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t\',6,$2)', [vaultId, address])
    await pool.query('INSERT INTO ' + schema + '.private_treasury_observation_state (vault_id) VALUES ($1)', [vaultId])

    const first = input(1, 'first')
    const created = await recordPrivateTreasuryVaultReservation(pool, first, { schema, nowMs: now })
    assert.equal(created.payoutAuthorized, false)
    assert.equal(created.executionEnabled, false)
    assert.equal(created.amountBaseUnits, minimum)

    await pool.query('UPDATE ' + schema + '.private_treasury_vaults SET vault_address=$2 WHERE vault_id=$1', [vaultId, 'T' + 'B'.repeat(33)])
    await assert.rejects(recordPrivateTreasuryVaultReservation(pool, input(2, 'wrong-vault-address'), { schema, nowMs: now }),
      (error) => error.code === 'PRIVATE_TREASURY_VAULT_UNAVAILABLE', 'verified treasury address must match the stored vault')
    await pool.query('UPDATE ' + schema + '.private_treasury_vaults SET vault_address=$2 WHERE vault_id=$1', [vaultId, address])

    await assert.rejects(recordPrivateTreasuryVaultReservation(pool, input(3, 'gap'), { schema, nowMs: now }),
      (error) => error.code === 'PRIVATE_TREASURY_VAULT_SEQUENCE_NOT_NEXT', 'writer must reject 1 to 3')
    await assert.rejects(recordPrivateTreasuryVaultReservation(pool, {
      ...input(2, 'duplicate-receipt'), verifiedObservation: first.verifiedObservation,
    }, { schema, nowMs: now }), (error) => error.code === '23505', 'receipt replay must fail')
    await assert.rejects(recordPrivateTreasuryVaultReservation(pool, {
      ...input(2, 'duplicate-observation'),
      verifiedObservation: verifiedObservation(vaultId, 2, 'new-receipt', '1500000000', { observationId: first.verifiedObservation.observationId }),
    }, { schema, nowMs: now }), (error) => error.code === '23505', 'observation replay must fail')
    await assert.rejects(recordPrivateTreasuryVaultReservation(pool, input(1, 'stale'), { schema, nowMs: now }),
      (error) => error.code === 'PRIVATE_TREASURY_VAULT_SEQUENCE_NOT_NEXT', 'stale sequence must fail')
    await assert.rejects(recordPrivateTreasuryVaultReservation(pool, {
      ...input(2, 'below-minimum'), amountBaseUnits: '999999999',
    }, { schema, nowMs: now }), /1,000 USDT minimum/, 'below-minimum reservation must fail')
    await assert.rejects(recordPrivateTreasuryVaultReservation(pool, {
      ...input(2, 'over-balance'), amountBaseUnits: '1500000001',
    }, { schema, nowMs: now }), (error) => error.code === 'PRIVATE_TREASURY_VAULT_AMOUNT_EXCEEDS_VERIFIED_BALANCE')
    await assert.rejects(recordPrivateTreasuryVaultReservation(pool, {
      ...input(2, 'unbranded'), verifiedObservation: { ...first.verifiedObservation },
    }, { schema, nowMs: now }), (error) => error.code === 'PRIVATE_TREASURY_VAULT_VERIFIED_OBSERVATION_REQUIRED')
    await assert.rejects(recordPrivateTreasuryVaultReservation(pool, input(2, 'stale-trust'), { schema, nowMs: now + 60_001 }),
      (error) => error.code === 'PRIVATE_TREASURY_VAULT_VERIFIED_OBSERVATION_STALE')
    await assert.rejects(recordPrivateTreasuryVaultReservation(pool, input(2, 'expired'), { schema, nowMs: now + 20_000 }),
      (error) => error.code === 'PRIVATE_TREASURY_VAULT_VERIFIED_OBSERVATION_STALE')

    const rollbackCandidate = input(2, 'rollback', { requestId: first.requestId })
    await assert.rejects(recordPrivateTreasuryVaultReservation(pool, rollbackCandidate, { schema, nowMs: now }),
      (error) => error.code === '23505', 'failed reservation must roll back claim')
    const rolledBackClaim = await pool.query(
      'SELECT COUNT(*)::int AS count FROM ' + schema + '.private_treasury_observation_claims WHERE vault_id=$1 AND receipt_id=$2',
      [vaultId, rollbackCandidate.verifiedObservation.receiptId])
    assert.equal(rolledBackClaim.rows[0].count, 0)

    await recordPrivateTreasuryVaultReservation(pool, input(2, 'second'), { schema, nowMs: now })
    const concurrent = await Promise.allSettled([
      recordPrivateTreasuryVaultReservation(pool, input(3, 'concurrent-a'), { schema, nowMs: now }),
      recordPrivateTreasuryVaultReservation(pool, input(3, 'concurrent-b'), { schema, nowMs: now }),
    ])
    assert.equal(concurrent.filter((item) => item.status === 'fulfilled').length, 1)
    assert.equal(concurrent.filter((item) => item.status === 'rejected').length, 1)
    assert.equal(concurrent.find((item) => item.status === 'rejected').reason.code, 'PRIVATE_TREASURY_VAULT_SEQUENCE_NOT_NEXT')

    const cursor = await pool.query('SELECT last_sequence::text AS last_sequence FROM ' + schema + '.private_treasury_observation_state WHERE vault_id=$1', [vaultId])
    assert.equal(cursor.rows[0].last_sequence, '3')
    await assert.rejects(pool.query('UPDATE ' + schema + '.private_treasury_observation_state SET last_sequence=2 WHERE vault_id=$1', [vaultId]),
      (error) => error.code === '23514', 'backward cursor must fail')
    await assert.rejects(pool.query('UPDATE ' + schema + '.private_treasury_observation_state SET last_observation_id=$2 WHERE vault_id=$1', [vaultId, 'forged-at-same-sequence']),
      (error) => error.code === '23514', 'identity change at same sequence must fail')

    await pool.query(
      'INSERT INTO ' + schema + '.private_treasury_observation_claims (vault_id, receipt_id, observation_id, reservation_sequence, payload_digest) VALUES ($1,$2,$3,$4,$5)',
      [vaultId, 'receipt-gap-direct', 'observation-gap-direct', '5', 'c'.repeat(64)])
    await assert.rejects(pool.query(
      'UPDATE ' + schema + '.private_treasury_observation_state SET last_sequence=5, last_observation_id=$2, last_receipt_id=$3 WHERE vault_id=$1',
      [vaultId, 'observation-gap-direct', 'receipt-gap-direct']),
      (error) => error.code === '23514', 'direct SQL 3 to 5 must fail even with a matching claim')

    await pool.query(
      'INSERT INTO ' + schema + '.private_treasury_observation_claims (vault_id, receipt_id, observation_id, reservation_sequence, payload_digest) VALUES ($1,$2,$3,$4,$5)',
      [vaultId, 'receipt-direct-next', 'observation-direct-next', '4', 'd'.repeat(64)])
    const validAdvance = await pool.query(
      'UPDATE ' + schema + '.private_treasury_observation_state SET last_sequence=4, last_observation_id=$2, last_receipt_id=$3 WHERE vault_id=$1',
      [vaultId, 'observation-direct-next', 'receipt-direct-next'])
    assert.equal(validAdvance.rowCount, 1, 'exact-next direct SQL advance must pass')
    await assert.rejects(pool.query('UPDATE ' + schema + '.private_treasury_observation_claims SET payload_digest=$2 WHERE vault_id=$1', [vaultId, 'b'.repeat(64)]),
      (error) => error.code === '55000', 'claims must remain immutable')
    const finalCounts = await counts()
    assert.equal(finalCounts.claims, 5)
    assert.equal(finalCounts.reservations, 3)
    assert.equal(finalCounts.events, 3)
  } finally {
    try { await pool.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE') } finally { await pool.end() }
  }
})
