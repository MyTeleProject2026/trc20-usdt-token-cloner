import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { TronWeb } from 'tronweb'
import {
  linkSponsorFeeReservation,
  normalizeSponsorFeeSettlementIdentity,
  settleSponsorChainFeeObservation,
  listSponsorChainFeeSettlements,
  closeSponsorChainFeeSettlementPool,
} from '../server/sponsor-chain-fee-settlements.mjs'
import {
  recordSponsorChainFeeObservation,
  closeSponsorChainFeeObservationPool,
} from '../server/sponsor-chain-fee-observations.mjs'
import { transitionSponsorTransfer } from '../server/database.mjs'

const { Pool } = pg
const enabled = process.env.SPONSOR_PG_INTEGRATION === '1'
const databaseUrl = process.env.DATABASE_URL || ''
const schema = 'trc20_token_clone'
const network = 'nile'
const principalAddress = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const receiverAddress = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH'
const amountBaseUnits = '2500000'
const feeSun = '4200'

function assertIsolatedDatabaseUrl(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('SPONSOR_PG_INTEGRATION requires a valid DATABASE_URL')
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) || databaseName !== 'sponsor_test') {
    throw new Error('Refusing sponsor fee settlement integration tests unless DATABASE_URL targets local dedicated sponsor_test')
  }
}

if (enabled) assertIsolatedDatabaseUrl(databaseUrl)

const tronWeb = new TronWeb({ fullHost: 'https://nile.trongrid.io' })
const principalHex = tronWeb.address.toHex(principalAddress).replace(/^41/i, '').toLowerCase()

test('fee settlement identity accepts only explicit testnet stored-transfer identity', () => {
  assert.deepEqual(normalizeSponsorFeeSettlementIdentity({
    network: 'nile', transactionHash: 'A'.repeat(64), idempotencyKey: 'fee-settlement-unit-key-0001',
  }), {
    success: true,
    identity: { network: 'nile', transactionHash: 'a'.repeat(64), idempotencyKey: 'fee-settlement-unit-key-0001' },
  })
  for (const input of [
    {},
    { network: 'mainnet', transactionHash: 'a'.repeat(64), idempotencyKey: 'fee-settlement-unit-key-0001' },
    { network: 'shasta', transactionHash: 'bad', idempotencyKey: 'fee-settlement-unit-key-0001' },
    { network: 'nile', transactionHash: 'a'.repeat(64), idempotencyKey: 'short' },
  ]) {
    assert.deepEqual(normalizeSponsorFeeSettlementIdentity(input), {
      success: false, reason: 'invalid-fee-settlement-identity',
    })
  }
})

async function createFixture({
  feeBudgetAddress = principalAddress,
  feeBudgetBaseUnits = '10000',
  feeBudgetReserved = '1000',
  feeReservationAmount = null,
  feeBudgetSpent = '0',
  includeApproval = true,
  reportedFeeSun = feeSun,
  energyFeeSun = '0',
  netFeeSun = feeSun,
  executionResult = 'FAILED',
  energyUsage = '0',
} = {}) {
  const { initializeDatabase } = await import('../server/database.mjs')
  const pool = new Pool({ connectionString: databaseUrl })
  await initializeDatabase()
  const identity = await pool.query('SELECT current_database() AS name')
  assert.equal(identity.rows[0].name, 'sponsor_test')
  const feeLedgerReady = await listSponsorChainFeeSettlements({ network, limit: 1 })
  assert.equal(feeLedgerReady.success, true)

  const suffix = randomUUID().replaceAll('-', '')
  const sponsorReference = 'fee-settlement-' + suffix
  const idempotencyKey = 'fee-settlement:' + suffix
  const transactionHash = suffix + suffix
  const settlementReference = 'trx-fee:' + network + ':' + transactionHash
  const approvalReference = 'approved-fee-scope-' + suffix
  const reviewReference = 'review-fee-scope-' + suffix
  const oldApprovedScopes = process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES
  const scope = [
    approvalReference, sponsorReference, network, feeBudgetAddress,
    'network-fee', 'TRX', '-',
  ].join('|')
  if (includeApproval) {
    const previous = String(oldApprovedScopes || '').split(';').map((item) => item.trim()).filter(Boolean)
    process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES = [...previous, scope].join(';')
  }

  await pool.query(
    'INSERT INTO ' + schema + '.sponsor_budgets '
    + '(sponsor_reference, sponsor_address, network, purpose, asset, token_contract, '
    + 'budget_base_units, reserved_base_units, spent_base_units, status, '
    + 'approval_reference, review_reference, approved_at) '
    + "VALUES ($1,$2,$3,'network-fee','TRX',NULL,$4::numeric,$5::numeric,$6::numeric,'active',$7,$8,now())",
    [sponsorReference, feeBudgetAddress, network, feeBudgetBaseUnits,
      feeReservationAmount === null ? feeBudgetReserved : feeReservationAmount, feeBudgetSpent,
      includeApproval ? approvalReference : null, includeApproval ? reviewReference : null],
  )
  await pool.query(
    'INSERT INTO ' + schema + '.sponsor_transfers '
    + '(idempotency_key, sponsor_reference, sponsor_address, network, purpose, asset, token_contract, '
    + 'receiver_address, amount_base_units, status, transaction_hash) '
    + "VALUES ($1,$2,$3,$4,'asset-grant','TRX',NULL,$5,$6,'submitted',$7)",
    [idempotencyKey, sponsorReference, principalAddress, network, receiverAddress, amountBaseUnits, transactionHash],
  )

  const feeReservationIdempotencyKey = feeReservationAmount === null
    ? null : 'fee-reservation:' + suffix
  if (feeReservationIdempotencyKey) {
    await pool.query(
      'INSERT INTO ' + schema + '.sponsor_transfers '
      + '(idempotency_key, sponsor_reference, sponsor_address, network, purpose, asset, token_contract, '
      + 'receiver_address, amount_base_units, status) '
      + "VALUES ($1,$2,$3,$4,'network-fee','TRX',NULL,$5,$6,'pending-review')",
      [feeReservationIdempotencyKey, sponsorReference, principalAddress, network,
        receiverAddress, feeReservationAmount],
    )
  }

  const observed = await recordSponsorChainFeeObservation({
    network,
    transactionHash,
    idempotencyKey,
    blockNumber: 987654,
    executionResult,
    transactionOwnerAddressHex: principalHex,
    trxFeePayerAddressHex: BigInt(reportedFeeSun) > 0n ? principalHex : null,
    reportedFeeSun,
    energyFeeSun,
    netFeeSun,
    energyUsageTotal: energyUsage,
    energyUsage,
    originEnergyUsage: null,
    netUsage: '220',
    energyPenaltyTotal: null,
  })
  assert.equal(observed.success, true, 'fixture receipt observation must persist')

  return {
    pool,
    sponsorReference,
    idempotencyKey,
    transactionHash,
    settlementReference,
    approvalReference,
    reviewReference,
    oldApprovedScopes,
    feeBudgetAddress,
    feeReservationIdempotencyKey,
  }
}

async function cleanupFixture(fixture, { triggerName = null, functionName = null } = {}) {
  const { pool, transactionHash, idempotencyKey, sponsorReference, settlementReference, oldApprovedScopes } = fixture
  if (triggerName) await pool.query('DROP TRIGGER IF EXISTS ' + triggerName + ' ON ' + schema + '.audit_events').catch(() => {})
  if (functionName) await pool.query('DROP FUNCTION IF EXISTS ' + schema + '.' + functionName + '()').catch(() => {})

  await pool.query('ALTER TABLE ' + schema + '.sponsor_chain_fee_settlements DISABLE TRIGGER sponsor_chain_fee_settlements_immutable').catch(() => {})
  await pool.query(
    'DELETE FROM ' + schema + '.sponsor_chain_fee_settlements WHERE network = $1 AND transaction_hash = $2',
    [network, transactionHash],
  ).catch(() => {})
  await pool.query('ALTER TABLE ' + schema + '.sponsor_chain_fee_settlements ENABLE TRIGGER sponsor_chain_fee_settlements_immutable').catch(() => {})

  await pool.query('ALTER TABLE ' + schema + '.sponsor_fee_reservation_links DISABLE TRIGGER sponsor_fee_reservation_links_immutable').catch(() => {})
  await pool.query(
    'DELETE FROM ' + schema + '.sponsor_fee_reservation_links WHERE asset_transfer_idempotency_key = $1 OR fee_reservation_idempotency_key = $2',
    [idempotencyKey, fixture.feeReservationIdempotencyKey],
  ).catch(() => {})
  await pool.query('ALTER TABLE ' + schema + '.sponsor_fee_reservation_links ENABLE TRIGGER sponsor_fee_reservation_links_immutable').catch(() => {})

  await pool.query('ALTER TABLE ' + schema + '.sponsor_chain_fee_observations DISABLE TRIGGER sponsor_chain_fee_observations_immutable').catch(() => {})
  await pool.query(
    'DELETE FROM ' + schema + '.sponsor_chain_fee_observations WHERE network = $1 AND transaction_hash = $2',
    [network, transactionHash],
  ).catch(() => {})
  await pool.query('ALTER TABLE ' + schema + '.sponsor_chain_fee_observations ENABLE TRIGGER sponsor_chain_fee_observations_immutable').catch(() => {})

  await pool.query(
    'DELETE FROM ' + schema + '.audit_events WHERE entity_reference = ANY($1::text[])',
    [[settlementReference, network + ':' + transactionHash,
      'fee-reservation-link:' + network + ':' + idempotencyKey]],
  ).catch(() => {})
  await pool.query(
    'DELETE FROM ' + schema + '.sponsor_transfers WHERE idempotency_key = ANY($1::text[])',
    [[idempotencyKey, fixture.feeReservationIdempotencyKey].filter(Boolean)],
  ).catch(() => {})
  await pool.query('DELETE FROM ' + schema + '.sponsor_budgets WHERE sponsor_reference = $1', [sponsorReference]).catch(() => {})
  if (oldApprovedScopes === undefined) delete process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES
  else process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES = oldApprovedScopes
  await closeSponsorChainFeeSettlementPool().catch(() => {})
  await closeSponsorChainFeeObservationPool().catch(() => {})
  await pool.end()
}

async function readBudgetAndSettlement(fixture) {
  const [budget, settlements, audit] = await Promise.all([
    fixture.pool.query(
      'SELECT budget_base_units::text AS budget, reserved_base_units::text AS reserved, '
      + 'spent_base_units::text AS spent, status FROM ' + schema + '.sponsor_budgets '
      + "WHERE sponsor_reference = $1 AND purpose = 'network-fee'",
      [fixture.sponsorReference],
    ),
    fixture.pool.query(
      'SELECT count(*)::int AS count, min(settled_fee_sun::text) AS fee FROM '
      + schema + '.sponsor_chain_fee_settlements WHERE network = $1 AND transaction_hash = $2',
      [network, fixture.transactionHash],
    ),
    fixture.pool.query(
      'SELECT count(*)::int AS count FROM ' + schema + '.audit_events '
      + "WHERE event_type = 'sponsor-chain-fee-settled' AND entity_reference = $1",
      [fixture.settlementReference],
    ),
  ])
  return { budget: budget.rows[0], settlements: settlements.rows[0], audit: audit.rows[0] }
}

test('PostgreSQL settles a finalized direct TRX burn once, including failed execution, with immutable audit evidence', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async () => {
  const fixture = await createFixture()
  try {
    const results = await Promise.all([
      settleSponsorChainFeeObservation({
        network, transactionHash: fixture.transactionHash, idempotencyKey: fixture.idempotencyKey,
      }),
      settleSponsorChainFeeObservation({
        network, transactionHash: fixture.transactionHash, idempotencyKey: fixture.idempotencyKey,
      }),
    ])
    assert.equal(results.filter((item) => item.success && item.settled && item.duplicate === false).length, 1)
    assert.equal(results.filter((item) => item.success && item.settled && item.duplicate === true).length, 1)
    assert.ok(results.every((item) => item.executionResult === 'FAILED'))

    const state = await readBudgetAndSettlement(fixture)
    assert.deepEqual(state.budget, {
      budget: '10000', reserved: '1000', spent: feeSun, status: 'active',
    })
    assert.deepEqual(state.settlements, { count: 1, fee: feeSun })
    assert.equal(state.audit.count, 1)

    const history = await listSponsorChainFeeSettlements({ network, limit: 10 })
    assert.equal(history.success, true)
    assert.equal(history.settlements.some((item) => item.transaction_hash.trim() === fixture.transactionHash), true)
  } finally {
    await cleanupFixture(fixture)
  }
})

test('PostgreSQL refuses to debit a separate fee-sponsor wallet that is not the transaction owner', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async () => {
  const fixture = await createFixture({ feeBudgetAddress: receiverAddress })
  try {
    const result = await settleSponsorChainFeeObservation({
      network, transactionHash: fixture.transactionHash, idempotencyKey: fixture.idempotencyKey,
    })
    assert.deepEqual(result, {
      success: false,
      reason: 'network-fee-sponsor-is-not-trx-burn-payer',
      delegatedResourceSettlement: false,
    })
    const state = await readBudgetAndSettlement(fixture)
    assert.equal(state.budget.spent, '0')
    assert.equal(state.settlements.count, 0)
    assert.equal(state.audit.count, 0)
  } finally {
    await cleanupFixture(fixture)
  }
})

test('PostgreSQL does not infer a sponsor debit from resource usage when TRX burn is zero', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async () => {
  const fixture = await createFixture({
    reportedFeeSun: '0', energyFeeSun: '0', netFeeSun: '0', energyUsage: '500',
  })
  try {
    const result = await settleSponsorChainFeeObservation({
      network, transactionHash: fixture.transactionHash, idempotencyKey: fixture.idempotencyKey,
    })
    assert.deepEqual(result, { success: false, reason: 'no-trx-burn-to-settle' })
    const state = await readBudgetAndSettlement(fixture)
    assert.equal(state.budget.spent, '0')
    assert.equal(state.settlements.count, 0)
  } finally {
    await cleanupFixture(fixture)
  }
})

test('PostgreSQL preserves fee reservations and rejects an actual burn above unreserved network-fee capacity', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async () => {
  const fixture = await createFixture({ feeBudgetBaseUnits: '5000', feeBudgetReserved: '1000' })
  try {
    const result = await settleSponsorChainFeeObservation({
      network, transactionHash: fixture.transactionHash, idempotencyKey: fixture.idempotencyKey,
    })
    assert.deepEqual(result, {
      success: false,
      reason: 'insufficient-unreserved-network-fee-budget',
      requiredFeeSun: feeSun,
      availableBaseUnits: '4000',
    })
    const state = await readBudgetAndSettlement(fixture)
    assert.equal(state.budget.reserved, '1000')
    assert.equal(state.budget.spent, '0')
    assert.equal(state.settlements.count, 0)
  } finally {
    await cleanupFixture(fixture)
  }
})

test('PostgreSQL rolls back fee-budget spend and settlement row when the audit insert fails', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async () => {
  const fixture = await createFixture()
  const triggerName = 'fail_fee_settlement_' + fixture.transactionHash.slice(0, 20)
  const functionName = 'fail_fee_settlement_fn_' + fixture.transactionHash.slice(0, 20)
  try {
    await fixture.pool.query(
      'CREATE FUNCTION ' + schema + '.' + functionName + '() RETURNS trigger LANGUAGE plpgsql AS $$ '
      + 'BEGIN IF NEW.event_type = \'sponsor-chain-fee-settled\' '
      + 'AND NEW.entity_reference = \'' + fixture.settlementReference + '\' '
      + "THEN RAISE EXCEPTION 'intentional fee settlement audit failure'; END IF; RETURN NEW; END; $$",
    )
    await fixture.pool.query(
      'CREATE TRIGGER ' + triggerName + ' BEFORE INSERT ON ' + schema + '.audit_events '
      + 'FOR EACH ROW EXECUTE FUNCTION ' + schema + '.' + functionName + '()',
    )
    const result = await settleSponsorChainFeeObservation({
      network, transactionHash: fixture.transactionHash, idempotencyKey: fixture.idempotencyKey,
    })
    assert.deepEqual(result, { success: false, reason: 'database-unavailable' })
    const state = await readBudgetAndSettlement(fixture)
    assert.equal(state.budget.spent, '0')
    assert.equal(state.settlements.count, 0)
    assert.equal(state.audit.count, 0)
  } finally {
    await cleanupFixture(fixture, { triggerName, functionName })
  }
})


test('PostgreSQL links an exact network-fee hold to one asset transfer and settles only that hold', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async () => {
  const fixture = await createFixture({
    feeBudgetBaseUnits: '5000',
    feeReservationAmount: '5000',
  })
  try {
    const linkInput = {
      assetTransferIdempotencyKey: fixture.idempotencyKey,
      feeReservationIdempotencyKey: fixture.feeReservationIdempotencyKey,
    }
    const links = await Promise.all([
      linkSponsorFeeReservation(linkInput),
      linkSponsorFeeReservation(linkInput),
    ])
    assert.equal(links.filter((item) => item.success && item.duplicate === false).length, 1)
    assert.equal(links.filter((item) => item.success && item.duplicate === true).length, 1)

    const results = await Promise.all([
      settleSponsorChainFeeObservation({
        network, transactionHash: fixture.transactionHash, idempotencyKey: fixture.idempotencyKey,
      }),
      settleSponsorChainFeeObservation({
        network, transactionHash: fixture.transactionHash, idempotencyKey: fixture.idempotencyKey,
      }),
    ])
    assert.equal(results.filter((item) => item.success && item.duplicate === false).length, 1)
    assert.equal(results.filter((item) => item.success && item.duplicate === true).length, 1)
    const budget = await fixture.pool.query(
      'SELECT reserved_base_units::text AS reserved, spent_base_units::text AS spent '
      + 'FROM ' + schema + '.sponsor_budgets WHERE sponsor_reference = $1 AND purpose = \'network-fee\'',
      [fixture.sponsorReference],
    )
    assert.deepEqual(budget.rows[0], { reserved: '0', spent: feeSun })
    const feeTransfer = await fixture.pool.query(
      'SELECT status FROM ' + schema + '.sponsor_transfers WHERE idempotency_key = $1',
      [fixture.feeReservationIdempotencyKey],
    )
    assert.equal(feeTransfer.rows[0].status, 'fee-settled')
    const settlement = await fixture.pool.query(
      'SELECT fee_reservation_idempotency_key, reserved_fee_sun::text AS reserved_fee_sun, '
      + 'released_fee_reserve_sun::text AS released_fee_reserve_sun '
      + 'FROM ' + schema + '.sponsor_chain_fee_settlements WHERE network = $1 AND transaction_hash = $2',
      [network, fixture.transactionHash],
    )
    assert.deepEqual(settlement.rows[0], {
      fee_reservation_idempotency_key: fixture.feeReservationIdempotencyKey,
      reserved_fee_sun: '5000',
      released_fee_reserve_sun: '800',
    })
  } finally {
    await cleanupFixture(fixture)
  }
})

test('PostgreSQL refuses a linked reservation that is smaller than the observed fee without using unreserved capacity', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async () => {
  const fixture = await createFixture({
    feeBudgetBaseUnits: '10000',
    feeReservationAmount: '3000',
  })
  try {
    const linked = await linkSponsorFeeReservation({
      assetTransferIdempotencyKey: fixture.idempotencyKey,
      feeReservationIdempotencyKey: fixture.feeReservationIdempotencyKey,
    })
    assert.equal(linked.success, true)
    const result = await settleSponsorChainFeeObservation({
      network, transactionHash: fixture.transactionHash, idempotencyKey: fixture.idempotencyKey,
    })
    assert.deepEqual(result, {
      success: false,
      reason: 'observed-fee-exceeds-linked-reservation',
      requiredFeeSun: feeSun,
      reservedFeeSun: '3000',
    })
    const budget = await fixture.pool.query(
      'SELECT reserved_base_units::text AS reserved, spent_base_units::text AS spent '
      + 'FROM ' + schema + '.sponsor_budgets WHERE sponsor_reference = $1 AND purpose = \'network-fee\'',
      [fixture.sponsorReference],
    )
    assert.deepEqual(budget.rows[0], { reserved: '3000', spent: '0' })
    const feeTransfer = await fixture.pool.query(
      'SELECT status FROM ' + schema + '.sponsor_transfers WHERE idempotency_key = $1',
      [fixture.feeReservationIdempotencyKey],
    )
    assert.equal(feeTransfer.rows[0].status, 'pending-review')
  } finally {
    await cleanupFixture(fixture)
  }
})

test('PostgreSQL refuses to link a fee reservation belonging to a different budget wallet', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async () => {
  const fixture = await createFixture({
    feeBudgetAddress: receiverAddress,
    feeReservationAmount: '5000',
  })
  try {
    const result = await linkSponsorFeeReservation({
      assetTransferIdempotencyKey: fixture.idempotencyKey,
      feeReservationIdempotencyKey: fixture.feeReservationIdempotencyKey,
    })
    assert.deepEqual(result, {
      success: false,
      reason: 'network-fee-budget-not-found-or-mismatched',
    })
  } finally {
    await cleanupFixture(fixture)
  }
})

test('invalid fee reservation link keys fail before database access', async () => {
  assert.deepEqual(await linkSponsorFeeReservation({
    assetTransferIdempotencyKey: 'short',
    feeReservationIdempotencyKey: 'also-short',
  }), { success: false, reason: 'invalid-fee-reservation-link-identity' })
})


test('PostgreSQL prevents cancellation of a linked fee hold after its asset transfer is submitted', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async () => {
  const fixture = await createFixture({ feeReservationAmount: '5000' })
  try {
    const linked = await linkSponsorFeeReservation({
      assetTransferIdempotencyKey: fixture.idempotencyKey,
      feeReservationIdempotencyKey: fixture.feeReservationIdempotencyKey,
    })
    assert.equal(linked.success, true)
    const result = await transitionSponsorTransfer({
      idempotencyKey: fixture.feeReservationIdempotencyKey,
      nextStatus: 'cancelled',
      cancellationReason: 'operator-request',
    })
    assert.deepEqual(result, {
      updated: false,
      reason: 'linked-asset-transfer-must-be-cancelled-first',
    })
    const state = await fixture.pool.query(
      'SELECT status FROM ' + schema + '.sponsor_transfers WHERE idempotency_key = $1',
      [fixture.feeReservationIdempotencyKey],
    )
    assert.equal(state.rows[0].status, 'pending-review')
  } finally {
    await cleanupFixture(fixture)
  }
})


test('PostgreSQL rolls back linked reserve release and fee-reservation status when settlement audit fails', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async () => {
  const fixture = await createFixture({ feeReservationAmount: '5000' })
  const triggerName = 'fail_linked_fee_' + fixture.transactionHash.slice(0, 20)
  const functionName = 'fail_linked_fee_fn_' + fixture.transactionHash.slice(0, 20)
  try {
    const linked = await linkSponsorFeeReservation({
      assetTransferIdempotencyKey: fixture.idempotencyKey,
      feeReservationIdempotencyKey: fixture.feeReservationIdempotencyKey,
    })
    assert.equal(linked.success, true)
    await fixture.pool.query(
      'CREATE FUNCTION ' + schema + '.' + functionName + '() RETURNS trigger LANGUAGE plpgsql AS $$ '
      + 'BEGIN IF NEW.event_type = \'sponsor-chain-fee-settled\' '
      + 'AND NEW.entity_reference = \'' + fixture.settlementReference + '\' '
      + "THEN RAISE EXCEPTION 'intentional linked fee audit failure'; END IF; RETURN NEW; END; $$",
    )
    await fixture.pool.query(
      'CREATE TRIGGER ' + triggerName + ' BEFORE INSERT ON ' + schema + '.audit_events '
      + 'FOR EACH ROW EXECUTE FUNCTION ' + schema + '.' + functionName + '()',
    )
    const result = await settleSponsorChainFeeObservation({
      network, transactionHash: fixture.transactionHash, idempotencyKey: fixture.idempotencyKey,
    })
    assert.deepEqual(result, { success: false, reason: 'database-unavailable' })
    const budget = await fixture.pool.query(
      'SELECT reserved_base_units::text AS reserved, spent_base_units::text AS spent '
      + 'FROM ' + schema + '.sponsor_budgets WHERE sponsor_reference = $1 AND purpose = \'network-fee\'',
      [fixture.sponsorReference],
    )
    assert.deepEqual(budget.rows[0], { reserved: '5000', spent: '0' })
    const feeTransfer = await fixture.pool.query(
      'SELECT status FROM ' + schema + '.sponsor_transfers WHERE idempotency_key = $1',
      [fixture.feeReservationIdempotencyKey],
    )
    assert.equal(feeTransfer.rows[0].status, 'pending-review')
    const settlement = await fixture.pool.query(
      'SELECT count(*)::int AS count FROM ' + schema + '.sponsor_chain_fee_settlements '
      + 'WHERE network = $1 AND transaction_hash = $2',
      [network, fixture.transactionHash],
    )
    assert.equal(settlement.rows[0].count, 0)
  } finally {
    await cleanupFixture(fixture, { triggerName, functionName })
  }
})
