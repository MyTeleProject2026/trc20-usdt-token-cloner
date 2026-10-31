import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

const { Pool } = pg
const enabled = process.env.SPONSOR_PG_INTEGRATION === '1'
const databaseUrl = process.env.DATABASE_URL || ''

function assertIsolatedDatabaseUrl(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('SPONSOR_PG_INTEGRATION requires a valid DATABASE_URL')
  }
  const databaseName = decodeURIComponent(parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname)
  const localHosts = new Set(['localhost', '127.0.0.1', '::1'])
  if (!localHosts.has(parsed.hostname) || databaseName !== 'sponsor_test') {
    throw new Error('Refusing PostgreSQL integration tests unless DATABASE_URL targets the local dedicated sponsor_test database')
  }
}

if (enabled) assertIsolatedDatabaseUrl(databaseUrl)

const sponsorAddress = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
const receiverAddress = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const network = 'shasta'

async function setup({ fundingSnapshotReader: injectedFundingSnapshotReader } = {}) {
  const { initializeDatabase, reserveSponsorTransfer: reserveSponsorTransferWithFundingGate, transitionSponsorTransfer, createSponsorBudgetDraft, listSponsorBudgets, pauseSponsorBudget, activateSponsorBudget, getSponsorBudgetById } =
    await import('../server/database.mjs')
  const pool = new Pool({ connectionString: databaseUrl })
  const readiness = await initializeDatabase()
  assert.equal(readiness.ready, true)
  const identity = await pool.query('SELECT current_database() AS name')
  assert.equal(identity.rows[0].name, 'sponsor_test', 'tests must only touch the dedicated sponsor_test database')
  // Integration tests exercise PostgreSQL lifecycle behavior with a deterministic
  // test-only on-chain snapshot. Production defaults still require live provider
  // reads and never accept this test fixture outside this test process.
  const fundingSnapshotReader = injectedFundingSnapshotReader || (async (requestedNetwork, asset = 'TRX', tokenContract = null, address = sponsorAddress) => ({
    status: 'solidified-sponsor-balances-read',
    onChainBalanceRead: true,
    network: requestedNetwork,
    source: 'Tatum TRON SolidityNode account and constant-contract queries',
    sponsorAddress: address,
    checkedAt: new Date().toISOString(),
    cache: { status: 'fresh', ageMs: 0 },
    native: {
      status: 'verified', asset: 'TRX',
      balanceSun: '999999999999999999999999999999999999',
      balanceTRX: '999999999999999999999999999999.999999',
    },
    tokens: asset === 'TRX' ? [] : [{
      asset: asset === 'USDT' && requestedNetwork !== 'mainnet' ? 'USDT (testnet)' : asset,
      tokenContract,
      status: 'verified',
      balanceBaseUnits: '999999999999999999999999999999999999',
      decimals: asset === 'USDT' && requestedNetwork === 'mainnet' ? 6 : 18,
    }],
  }))
  const reserveSponsorTransfer = (input) => reserveSponsorTransferWithFundingGate(input, {
    fundingSnapshotReader: async (requestedNetwork) => fundingSnapshotReader(
      requestedNetwork, input.asset, input.tokenContract,
    ),
  })
  return { pool, reserveSponsorTransfer, transitionSponsorTransfer, createSponsorBudgetDraft, listSponsorBudgets, pauseSponsorBudget, activateSponsorBudget, getSponsorBudgetById }
}

const testBudgetApprovals = new Map()

function registerTestBudgetApproval({ sponsorReference, network, sponsorAddress, purpose, asset, tokenContract = null }) {
  const consentReference = `pg-approval-${randomUUID()}`
  const reviewReference = `pg-review-${randomUUID()}`
  const scope = [
    consentReference,
    sponsorReference,
    network,
    sponsorAddress,
    purpose,
    asset,
    tokenContract || '-',
  ].join('|')
  const previous = String(process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES || '')
    .split(';').map((entry) => entry.trim()).filter(Boolean)
  process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES = [...new Set([...previous, scope])].join(';')
  const approval = { sponsorReference, scope, consentReference, reviewReference }
  testBudgetApprovals.set(scope, approval)
  return approval
}

async function insertActiveBudget(pool, {
  sponsorReference,
  network: budgetNetwork = network,
  sponsorAddress: budgetSponsorAddress = sponsorAddress,
  purpose,
  asset,
  tokenContract = null,
  budgetBaseUnits,
}) {
  const approval = registerTestBudgetApproval({
    sponsorReference,
    network: budgetNetwork,
    sponsorAddress: budgetSponsorAddress,
    purpose,
    asset,
    tokenContract,
  })
  await pool.query(
    `INSERT INTO trc20_token_clone.sponsor_budgets
      (sponsor_reference, sponsor_address, network, purpose, asset, token_contract,
       budget_base_units, reserved_base_units, spent_base_units, status,
       approval_reference, review_reference, approved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,0,0,'active',$8,$9,now())`,
    [sponsorReference, budgetSponsorAddress, budgetNetwork, purpose, asset,
      tokenContract, budgetBaseUnits, approval.consentReference, approval.reviewReference],
  )
}

async function insertBudget(pool, sponsorReference, budgetBaseUnits) {
  return insertActiveBudget(pool, {
    sponsorReference, purpose: 'asset-grant', asset: 'TRX',
    tokenContract: null, budgetBaseUnits,
  })
}

async function insertUsdtBudget(pool, sponsorReference, tokenContract, budgetBaseUnits) {
  return insertActiveBudget(pool, {
    sponsorReference, purpose: 'asset-grant', asset: 'USDT',
    tokenContract, budgetBaseUnits,
  })
}

// Reconciliation integration tests may need to model a previously accepted provider
// broadcast. Seed that persisted state directly in the isolated test database rather
// than calling the production transition API, which correctly refuses to fabricate it.
async function seedPreviouslySubmittedTransfer(pool, idempotencyKey, transactionHash) {
  const result = await pool.query(
    `UPDATE trc20_token_clone.sponsor_transfers
        SET status = 'submitted', transaction_hash = $2, updated_at = now()
      WHERE idempotency_key = $1 AND status = 'pending-review'`,
    [idempotencyKey, transactionHash],
  )
  assert.equal(result.rowCount, 1, 'test fixture must seed exactly one pending transfer')
}

async function insertLegacyActiveBudget(pool, sponsorReference, budgetBaseUnits) {
  await pool.query(
    `INSERT INTO trc20_token_clone.sponsor_budgets
      (sponsor_reference, sponsor_address, network, purpose, asset, token_contract,
       budget_base_units, reserved_base_units, spent_base_units, status)
     VALUES ($1,$2,$3,'asset-grant','TRX',NULL,$4,0,0,'active')`,
    [sponsorReference, sponsorAddress, network, budgetBaseUnits],
  )
}

async function cleanup(pool, sponsorReferences, idempotencyKeys) {
  // Clean transfer and budget lifecycle audit rows as well as rows whose own
  // entity reference is an idempotency key; tests must leave no ledger residue.
  await pool.query(
    `DELETE FROM trc20_token_clone.audit_events AS a
      WHERE a.entity_reference = ANY($2::text[])
         OR a.details->>'sponsorReference' = ANY($1::text[])
         OR (a.entity_type = 'sponsor-budget' AND a.entity_reference IN (
           SELECT id::text FROM trc20_token_clone.sponsor_budgets
            WHERE sponsor_reference = ANY($1::text[])
         ))`,
    [sponsorReferences, idempotencyKeys],
  )
  await pool.query(
    'DELETE FROM trc20_token_clone.sponsor_transfers WHERE idempotency_key = ANY($1::text[])',
    [idempotencyKeys],
  )
  await pool.query(
    'DELETE FROM trc20_token_clone.sponsor_budgets WHERE sponsor_reference = ANY($1::text[])',
    [sponsorReferences],
  )
  const removedScopes = [...testBudgetApprovals.values()]
    .filter((approval) => sponsorReferences.includes(approval.sponsorReference))
    .map((approval) => approval.scope)
  if (removedScopes.length) {
    const remaining = String(process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES || '')
      .split(';').map((entry) => entry.trim()).filter((entry) => entry && !removedScopes.includes(entry))
    if (remaining.length) process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES = remaining.join(';')
    else delete process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES
    for (const scope of removedScopes) testBudgetApprovals.delete(scope)
  }
}


test('PostgreSQL keeps legacy VTRC history readable but rejects new VTRC ledger and intake writes', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async () => {
  const { pool } = await setup()
  const suffix = randomUUID()
  const sponsorReference = `pg-usdt-only-${suffix}`
  const transferKey = `pg-usdt-only:${suffix}`
  const rejectedTransferKey = `pg-vtrc-transfer:${suffix}`
  const intakeKey = `pg-intake-usdt-only:${suffix}`
  const contractAddress = receiverAddress
  const { createSponsorRequestStore } = await import('../server/routes/sponsor-request-intake.mjs')
  const intakeStore = createSponsorRequestStore({ DATABASE_URL: databaseUrl })
  try {
    // A migration marked NOT VALID must remain unvalidated (so prior VTRC rows are
    // still readable) while PostgreSQL enforces it for every new row.
    const guardNames = [
      'sponsor_budgets_supported_asset_only',
      'sponsor_transfers_supported_asset_only',
      'sponsor_chain_cost_observations_supported_asset_only',
    ]
    const guards = await pool.query(
      'SELECT conname, convalidated FROM pg_constraint WHERE conname = ANY($1::text[])',
      [guardNames],
    )
    assert.equal(guards.rows.length, guardNames.length)
    assert.ok(guards.rows.every((row) => row.convalidated === false))

    await assert.rejects(
      pool.query(`INSERT INTO trc20_token_clone.sponsor_budgets
        (sponsor_reference, sponsor_address, network, purpose, asset, token_contract,
         budget_base_units, reserved_base_units, spent_base_units, status)
       VALUES ($1,$2,$3,'asset-grant','VTRC',$4,100,0,0,'pending-review')`,
        [sponsorReference, sponsorAddress, network, contractAddress]),
      (error) => error?.code === '23514' && error?.constraint === 'sponsor_budgets_supported_asset_only',
    )

    await assert.rejects(
      pool.query(`INSERT INTO trc20_token_clone.sponsor_transfers
        (idempotency_key, sponsor_reference, network, purpose, asset, token_contract, receiver_address, amount_base_units)
       VALUES ($1,$2,$3,'asset-grant','VTRC',$4,$5,1)`,
        [rejectedTransferKey, sponsorReference, network, contractAddress, receiverAddress]),
      (error) => error?.code === '23514' && error?.constraint === 'sponsor_transfers_supported_asset_only',
    )

    // Create one supported parent transfer so the immutable cost-observation foreign
    // key is valid; the VTRC observation must still be rejected by its own guard.
    await pool.query(`INSERT INTO trc20_token_clone.sponsor_transfers
      (idempotency_key, sponsor_reference, network, purpose, asset, token_contract, receiver_address, amount_base_units)
      VALUES ($1,$2,$3,'asset-grant','TRX',NULL,$4,1)`,
      [transferKey, sponsorReference, network, receiverAddress])
    await assert.rejects(
      pool.query(`INSERT INTO trc20_token_clone.sponsor_chain_cost_observations
        (network, transaction_hash, idempotency_key, sponsor_reference, fee_sponsor_address,
         asset_principal_address, receiver_address, asset, token_contract, amount_base_units,
         block_number, execution_result, reported_fee_sun)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'VTRC',$8,1,54321,'SUCCESS',0)`,
        [network, 'a'.repeat(64), transferKey, sponsorReference, sponsorAddress, receiverAddress, receiverAddress, contractAddress]),
      (error) => error?.code === '23514' && error?.constraint === 'sponsor_chain_cost_observations_supported_asset_only',
    )

    const intakeCreated = await intakeStore.createRequest({
      idempotencyKey: intakeKey, requesterAddress: sponsorAddress, network, recipientAddress: receiverAddress,
      asset: 'USDT', tokenContract: contractAddress, amountBaseUnits: '1', decimals: 6,
    })
    assert.equal(intakeCreated.success, true)
    const intakeGuard = await pool.query(
      `SELECT convalidated FROM pg_constraint
        WHERE conname = 'sponsor_payout_intake_supported_asset_only'
          AND conrelid = 'trc20_token_clone.sponsor_payout_intake_requests'::regclass`,
    )
    assert.equal(intakeGuard.rows.length, 1)
    assert.equal(intakeGuard.rows[0].convalidated, false)
  } finally {
    await pool.query('DELETE FROM trc20_token_clone.sponsor_payout_intake_requests WHERE idempotency_key = $1', [intakeKey]).catch(() => {})
    await intakeStore.close()
    await pool.query('DELETE FROM trc20_token_clone.sponsor_chain_cost_observations WHERE idempotency_key = $1', [transferKey]).catch(() => {})
    await pool.query('DELETE FROM trc20_token_clone.sponsor_transfers WHERE idempotency_key = ANY($1::text[])', [[transferKey, rejectedTransferKey]])
    await pool.query('DELETE FROM trc20_token_clone.sponsor_budgets WHERE sponsor_reference = $1', [sponsorReference]).catch(() => {})
    await pool.end()
  }
})

test('PostgreSQL refuses new reservations from a legacy active budget without scope approval', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async () => {
  const { pool, reserveSponsorTransfer } = await setup()
  const suffix = randomUUID()
  const sponsorReference = `pg-legacy-active-${suffix}`
  const idempotencyKey = `pg-legacy-active:${suffix}`
  try {
    await insertLegacyActiveBudget(pool, sponsorReference, '100')
    const result = await reserveSponsorTransfer({
      idempotencyKey,
      sponsorReference,
      network,
      purpose: 'asset-grant',
      asset: 'TRX',
      receiverAddress,
      amountBaseUnits: '25',
    })
    assert.deepEqual(result, { reserved: false, reason: 'sponsor-budget-activation-required' })

    const budget = await pool.query(
      `SELECT reserved_base_units::text AS reserved, spent_base_units::text AS spent
         FROM trc20_token_clone.sponsor_budgets WHERE sponsor_reference = $1`,
      [sponsorReference],
    )
    assert.deepEqual(budget.rows[0], { reserved: '0', spent: '0' })
    const transfers = await pool.query(
      'SELECT count(*)::int AS count FROM trc20_token_clone.sponsor_transfers WHERE idempotency_key = $1',
      [idempotencyKey],
    )
    assert.equal(transfers.rows[0].count, 0)
  } finally {
    await cleanup(pool, [sponsorReference], [idempotencyKey])
    await pool.end()
  }
})

test('PostgreSQL does not treat an opaque reference as verified wallet authorization', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async () => {
  const { pool, reserveSponsorTransfer, transitionSponsorTransfer, pauseSponsorBudget } = await setup()
  const suffix = randomUUID()
  const sponsorReference = `pg-pause-before-auth-${suffix}`
  const idempotencyKey = `pg-pause-before-auth:${suffix}`
  try {
    await insertBudget(pool, sponsorReference, '100')
    const reserved = await reserveSponsorTransfer({
      idempotencyKey,
      sponsorReference,
      network,
      purpose: 'asset-grant',
      asset: 'TRX',
      receiverAddress,
      amountBaseUnits: '25',
    })
    assert.equal(reserved.reserved, true)

    const budgetLookup = await pool.query(
      `SELECT id::text AS id FROM trc20_token_clone.sponsor_budgets
        WHERE sponsor_reference = $1 AND purpose = 'asset-grant'`,
      [sponsorReference],
    )
    const pause = await pauseSponsorBudget({
      budgetId: budgetLookup.rows[0].id,
      reasonCode: 'provider-incident',
    })
    assert.equal(pause.success, true)
    assert.equal(pause.status, 'paused')

    const authorization = await transitionSponsorTransfer({
      idempotencyKey,
      nextStatus: 'authorized',
      authorizationReference: `wallet-approval-${suffix}`,
    })
    assert.deepEqual(authorization, { updated: false, reason: 'wallet-signature-verification-not-integrated' })

    const transfer = await pool.query(
      'SELECT status FROM trc20_token_clone.sponsor_transfers WHERE idempotency_key = $1',
      [idempotencyKey],
    )
    assert.equal(transfer.rows[0].status, 'pending-review')
    const budgetAfter = await pool.query(
      `SELECT status, reserved_base_units::text AS reserved, spent_base_units::text AS spent
        FROM trc20_token_clone.sponsor_budgets WHERE sponsor_reference = $1`,
      [sponsorReference],
    )
    assert.deepEqual(budgetAfter.rows[0], { status: 'paused', reserved: '25', spent: '0' })
  } finally {
    await cleanup(pool, [sponsorReference], [idempotencyKey])
    await pool.end()
  }
})

test('PostgreSQL reservation refuses an underfunded sponsor wallet before creating ledger entries', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async () => {
  const lowBalanceReader = async (requestedNetwork) => ({
    status: 'solidified-sponsor-balances-read',
    onChainBalanceRead: true,
    network: requestedNetwork,
    source: 'Tatum TRON SolidityNode account and constant-contract queries',
    sponsorAddress: receiverAddress,
    checkedAt: new Date().toISOString(),
    cache: { status: 'fresh', ageMs: 0 },
    native: { status: 'verified', asset: 'TRX', balanceSun: '0', balanceTRX: '0' },
    tokens: [],
  })
  const { pool, reserveSponsorTransfer } = await setup({ fundingSnapshotReader: lowBalanceReader })
  const suffix = randomUUID()
  const sponsorReference = `pg-underfunded-reserve-${suffix}`
  const idempotencyKey = `pg-underfunded-reserve:${suffix}`
  try {
    await insertActiveBudget(pool, {
      sponsorReference,
      sponsorAddress: receiverAddress,
      network,
      purpose: 'asset-grant',
      asset: 'TRX',
      tokenContract: null,
      budgetBaseUnits: '100',
    })
    const result = await reserveSponsorTransfer({
      idempotencyKey,
      sponsorReference,
      network,
      purpose: 'asset-grant',
      asset: 'TRX',
      receiverAddress,
      amountBaseUnits: '25',
    })
    assert.deepEqual(result, {
      reserved: false,
      reason: 'insufficient-onchain-funding',
      requiredBaseUnits: '100',
      chainBalanceBaseUnits: '0',
      deficitBaseUnits: '100',
    })

    const budget = await pool.query(
      `SELECT reserved_base_units::text AS reserved, spent_base_units::text AS spent
         FROM trc20_token_clone.sponsor_budgets WHERE sponsor_reference = $1`,
      [sponsorReference],
    )
    assert.deepEqual(budget.rows[0], { reserved: '0', spent: '0' })
    const transfers = await pool.query(
      'SELECT count(*)::int AS count FROM trc20_token_clone.sponsor_transfers WHERE idempotency_key = $1',
      [idempotencyKey],
    )
    assert.equal(transfers.rows[0].count, 0)
  } finally {
    await cleanup(pool, [sponsorReference], [idempotencyKey])
    await pool.end()
  }
})

test('PostgreSQL reservation rejects stale sponsor snapshots without reserving budget', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async () => {
  const staleReader = async (requestedNetwork) => ({
    status: 'solidified-sponsor-balances-read',
    onChainBalanceRead: true,
    network: requestedNetwork,
    source: 'Tatum TRON SolidityNode account and constant-contract queries',
    sponsorAddress: receiverAddress,
    checkedAt: '2020-01-01T00:00:00.000Z',
    cache: { status: 'fresh', ageMs: 0 },
    native: { status: 'verified', asset: 'TRX', balanceSun: '999999999', balanceTRX: '999.999999' },
    tokens: [],
  })
  const { pool, reserveSponsorTransfer } = await setup({ fundingSnapshotReader: staleReader })
  const suffix = randomUUID()
  const sponsorReference = `pg-stale-reserve-${suffix}`
  const idempotencyKey = `pg-stale-reserve:${suffix}`
  try {
    await insertActiveBudget(pool, {
      sponsorReference,
      sponsorAddress: receiverAddress,
      network,
      purpose: 'asset-grant',
      asset: 'TRX',
      tokenContract: null,
      budgetBaseUnits: '100',
    })
    const result = await reserveSponsorTransfer({
      idempotencyKey,
      sponsorReference,
      network,
      purpose: 'asset-grant',
      asset: 'TRX',
      receiverAddress,
      amountBaseUnits: '25',
    })
    assert.deepEqual(result, { reserved: false, reason: 'fresh-sponsor-balance-unavailable' })

    const budget = await pool.query(
      `SELECT reserved_base_units::text AS reserved, spent_base_units::text AS spent
         FROM trc20_token_clone.sponsor_budgets WHERE sponsor_reference = $1`,
      [sponsorReference],
    )
    assert.deepEqual(budget.rows[0], { reserved: '0', spent: '0' })
  } finally {
    await cleanup(pool, [sponsorReference], [idempotencyKey])
    await pool.end()
  }
})

test('PostgreSQL reservation rejects a snapshot for a different sponsor wallet', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async () => {
  const mismatchedReader = async (requestedNetwork) => ({
    status: 'solidified-sponsor-balances-read',
    onChainBalanceRead: true,
    network: requestedNetwork,
    source: 'Tatum TRON SolidityNode account and constant-contract queries',
    sponsorAddress,
    checkedAt: new Date().toISOString(),
    cache: { status: 'fresh', ageMs: 0 },
    native: { status: 'verified', asset: 'TRX', balanceSun: '999999999', balanceTRX: '999.999999' },
    tokens: [],
  })
  const { pool, reserveSponsorTransfer } = await setup({ fundingSnapshotReader: mismatchedReader })
  const suffix = randomUUID()
  const sponsorReference = `pg-wallet-mismatch-${suffix}`
  const idempotencyKey = `pg-wallet-mismatch:${suffix}`
  try {
    await insertActiveBudget(pool, {
      sponsorReference,
      sponsorAddress: receiverAddress,
      network,
      purpose: 'asset-grant',
      asset: 'TRX',
      tokenContract: null,
      budgetBaseUnits: '100',
    })
    const result = await reserveSponsorTransfer({
      idempotencyKey,
      sponsorReference,
      network,
      purpose: 'asset-grant',
      asset: 'TRX',
      receiverAddress,
      amountBaseUnits: '25',
    })
    assert.deepEqual(result, { reserved: false, reason: 'funding-snapshot-identity-mismatch' })
    const budget = await pool.query(
      `SELECT reserved_base_units::text AS reserved
         FROM trc20_token_clone.sponsor_budgets WHERE sponsor_reference = $1`,
      [sponsorReference],
    )
    assert.deepEqual(budget.rows[0], { reserved: '0' })
    const transfers = await pool.query(
      'SELECT count(*)::int AS count FROM trc20_token_clone.sponsor_transfers WHERE idempotency_key = $1',
      [idempotencyKey],
    )
    assert.equal(transfers.rows[0].count, 0)
  } finally {
    await cleanup(pool, [sponsorReference], [idempotencyKey])
    await pool.end()
  }
})

test('PostgreSQL sponsor budget drafts are audited, pending-review, and idempotent', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async () => {
  const { pool, reserveSponsorTransfer, createSponsorBudgetDraft, listSponsorBudgets, pauseSponsorBudget, activateSponsorBudget, getSponsorBudgetById } = await setup()
  const suffix = randomUUID()
  const sponsorReference = `pg-draft-${suffix}`
  const draftSponsorAddress = receiverAddress
  const amount = '123456789'
  const consentReference = `signed-sponsor-${suffix}`
  const reviewReference = `review-ticket-${suffix}`
  const pauseKey = `pg-pause:${suffix}`
  const previousAgreementReferences = process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES
  process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES =
    `${consentReference}|${sponsorReference}|${network}|${draftSponsorAddress}|asset-grant|TRX|-`
  let created = null
  try {
    created = await createSponsorBudgetDraft({
      sponsorReference,
      network,
      purpose: 'asset-grant',
      asset: 'TRX',
      tokenContract: null,
      budgetBaseUnits: amount,
      sponsorAddress: draftSponsorAddress,
    })
    assert.equal(created.success, true)
    assert.equal(created.duplicate, false)
    assert.equal(created.budget.status, 'pending-review')
    assert.equal(created.budget.budget_base_units, amount)
    assert.equal(created.budget.reserved_base_units, '0')
    assert.equal(created.budget.spent_base_units, '0')
    assert.equal(created.canReserve, false)

    const duplicate = await createSponsorBudgetDraft({
      sponsorReference,
      network,
      purpose: 'asset-grant',
      asset: 'TRX',
      tokenContract: null,
      budgetBaseUnits: amount,
      sponsorAddress: draftSponsorAddress,
    })
    assert.deepEqual(duplicate, { success: false, reason: 'budget-already-exists' })

    const listing = await listSponsorBudgets({ network, limit: 100 })
    assert.equal(listing.success, true)
    const listed = listing.budgets.find((item) => item.sponsor_reference === sponsorReference)
    assert.ok(listed, 'created draft must be visible in the protected ledger query')
    assert.equal(listed.status, 'pending-review')
    assert.equal(listed.ledger_available_base_units, amount)

    const walletListing = await listSponsorBudgets({ network, sponsorAddress: draftSponsorAddress, limit: 100 })
    assert.equal(walletListing.success, true)
    assert.ok(walletListing.budgets.some((item) => item.sponsor_reference === sponsorReference))
    assert.ok(walletListing.budgets.every((item) => item.sponsor_address === draftSponsorAddress))

    const audit = await pool.query(
      `SELECT event_type, details
         FROM trc20_token_clone.audit_events
        WHERE entity_type = 'sponsor-budget'
          AND entity_reference = $1`,
      [`${sponsorReference}:${network}:asset-grant:TRX:`],
    )
    assert.equal(audit.rows.length, 1)
    assert.equal(audit.rows[0].event_type, 'sponsor-budget-draft-created')
    assert.equal(audit.rows[0].details.status, 'pending-review')
    assert.equal(audit.rows[0].details.budgetBaseUnits, amount)

    const unapproved = await activateSponsorBudget({
      budgetId: created.budget.id,
      consentReference: `unapproved-${suffix}`,
      reviewReference,
      fundingSnapshot: {},
    })
    assert.deepEqual(unapproved, { success: false, reason: 'agreement-reference-not-approved' })

    const lowFundingSnapshot = {
      status: 'solidified-sponsor-balances-read',
      onChainBalanceRead: true,
      network,
      source: 'Tatum TRON SolidityNode account and constant-contract queries',
      sponsorAddress: draftSponsorAddress,
      checkedAt: new Date().toISOString(),
      cache: { status: 'fresh', ageMs: 0 },
      native: { status: 'verified', asset: 'TRX', balanceSun: '100000000', balanceTRX: '100' },
      tokens: [],
    }
    const underfunded = await activateSponsorBudget({
      budgetId: created.budget.id, consentReference, reviewReference, fundingSnapshot: lowFundingSnapshot,
    })
    assert.deepEqual(underfunded, {
      success: false,
      reason: 'insufficient-onchain-funding',
      chainBalanceBaseUnits: '100000000',
      requiredBaseUnits: amount,
    })
    const stillPending = await getSponsorBudgetById(created.budget.id)
    assert.equal(stillPending.budget.status, 'pending-review')

    const fundingSnapshot = {
      ...lowFundingSnapshot,
      checkedAt: new Date().toISOString(),
      native: { status: 'verified', asset: 'TRX', balanceSun: '250000000', balanceTRX: '250' },
    }
    const activated = await activateSponsorBudget({
      budgetId: created.budget.id, consentReference, reviewReference, fundingSnapshot,
    })
    assert.deepEqual(activated, {
      success: true,
      duplicate: false,
      status: 'active',
      budgetId: created.budget.id,
      canReserve: true,
      canSubmitSponsoredTransfer: false,
      submissionEnabled: false,
      chainBalanceBaseUnits: '250000000',
      committedBaseUnits: amount,
    })

    const duplicateActivation = await activateSponsorBudget({
      budgetId: created.budget.id, consentReference, reviewReference, fundingSnapshot,
    })
    assert.deepEqual(duplicateActivation, {
      success: true, duplicate: true, status: 'active', budgetId: created.budget.id, canReserve: true,
    })
    const activatedLookup = await getSponsorBudgetById(created.budget.id)
    assert.equal(activatedLookup.budget.status, 'active')
    assert.equal(activatedLookup.budget.approval_reference, consentReference)
    assert.equal(activatedLookup.budget.review_reference, reviewReference)
    assert.ok(activatedLookup.budget.approved_at)

    const activationAudit = await pool.query(
      `SELECT event_type, details FROM trc20_token_clone.audit_events
        WHERE entity_type = 'sponsor-budget' AND entity_reference = $1`,
      [created.budget.id],
    )
    assert.equal(activationAudit.rows.length, 1)
    assert.equal(activationAudit.rows[0].event_type, 'sponsor-budget-activated')
    assert.equal(activationAudit.rows[0].details.consentReference, consentReference)
    assert.equal(activationAudit.rows[0].details.reviewReference, reviewReference)

    const paused = await pauseSponsorBudget({ budgetId: created.budget.id, reasonCode: 'funding-mismatch' })
    assert.deepEqual(paused, {
      success: true,
      duplicate: false,
      status: 'paused',
      budgetId: created.budget.id,
      previousStatus: 'active',
    })
    const repeatedPause = await pauseSponsorBudget({ budgetId: created.budget.id, reasonCode: 'funding-mismatch' })
    assert.deepEqual(repeatedPause, {
      success: true, duplicate: true, status: 'paused', budgetId: created.budget.id,
    })

    const afterPause = await listSponsorBudgets({ network, limit: 100 })
    const pausedBudget = afterPause.budgets.find((item) => item.sponsor_reference === sponsorReference)
    assert.equal(pausedBudget.status, 'paused')
    assert.equal(pausedBudget.ledger_available_base_units, amount)

    const attemptedReservation = await reserveSponsorTransfer({
      idempotencyKey: pauseKey,
      sponsorReference,
      network,
      purpose: 'asset-grant',
      asset: 'TRX',
      receiverAddress,
      amountBaseUnits: '1',
    })
    assert.deepEqual(attemptedReservation, { reserved: false, reason: 'sponsor-budget-not-active' })

    const pauseAudit = await pool.query(
      `SELECT event_type, details FROM trc20_token_clone.audit_events
        WHERE entity_type = 'sponsor-budget' AND entity_reference = $1`,
      [created.budget.id],
    )
    assert.equal(pauseAudit.rows.length, 2)
    const pauseAuditRow = pauseAudit.rows.find((row) => row.event_type === 'sponsor-budget-paused')
    assert.ok(pauseAuditRow)
    assert.equal(pauseAuditRow.details.reasonCode, 'funding-mismatch')
    assert.equal(pauseAuditRow.details.previousStatus, 'active')
  } finally {
    await cleanup(pool, [sponsorReference], [pauseKey])
    await pool.query(
      `DELETE FROM trc20_token_clone.audit_events
        WHERE entity_type = 'sponsor-budget'
          AND (entity_reference LIKE $1 OR entity_reference = $2)`,
      [`${sponsorReference}:%`, created?.budget?.id ?? '0'],
    )
    await pool.query(
      'DELETE FROM trc20_token_clone.sponsor_budgets WHERE sponsor_reference = $1',
      [sponsorReference],
    )
    await pool.end()
    if (previousAgreementReferences === undefined) delete process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES
    else process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES = previousAgreementReferences
  }
})

test('fee coverage and asset-grant principal require independent TRX sponsor budgets', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async () => {
  const { pool, reserveSponsorTransfer } = await setup()
  const suffix = randomUUID()
  const sponsorReference = `pg-purpose-${suffix}`
  const grantKey = `pg-grant:${suffix}`
  const feeKey = `pg-fee:${suffix}`
  try {
    await insertBudget(pool, sponsorReference, '100')
    const feeWithoutBudget = await reserveSponsorTransfer({
      idempotencyKey: feeKey, sponsorReference, network, purpose: 'network-fee',
      asset: 'TRX', receiverAddress, amountBaseUnits: '20',
    })
    assert.deepEqual(feeWithoutBudget, { reserved: false, reason: 'sponsor-budget-not-found' })

    await insertActiveBudget(pool, {
      sponsorReference,
      purpose: 'network-fee',
      asset: 'TRX',
      tokenContract: null,
      budgetBaseUnits: '50',
    })
    const fee = await reserveSponsorTransfer({
      idempotencyKey: feeKey, sponsorReference, network, purpose: 'network-fee',
      asset: 'TRX', receiverAddress, amountBaseUnits: '20',
    })
    assert.equal(fee.reserved, true)

    const grant = await reserveSponsorTransfer({
      idempotencyKey: grantKey, sponsorReference, network, purpose: 'asset-grant',
      asset: 'TRX', receiverAddress, amountBaseUnits: '80',
    })
    assert.equal(grant.reserved, true)

    const budgets = await pool.query(
      `SELECT purpose, budget_base_units::text AS budget, reserved_base_units::text AS reserved
         FROM trc20_token_clone.sponsor_budgets
        WHERE sponsor_reference = $1 ORDER BY purpose`,
      [sponsorReference],
    )
    assert.deepEqual(budgets.rows, [
      { purpose: 'asset-grant', budget: '100', reserved: '80' },
      { purpose: 'network-fee', budget: '50', reserved: '20' },
    ])
  } finally {
    await cleanup(pool, [sponsorReference], [grantKey, feeKey])
    await pool.end()
  }
})

test('PostgreSQL refuses opaque wallet references and caller-supplied hashes as authorization or submission evidence', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async () => {
  const { pool, reserveSponsorTransfer, transitionSponsorTransfer } = await setup()
  const suffix = randomUUID()
  const sponsorReference = `pg-no-fake-transition-${suffix}`
  const idempotencyKey = `pg-no-fake-transition:${suffix}`
  const transactionHash = 'a'.repeat(64)
  try {
    await insertBudget(pool, sponsorReference, '100')
    const intent = {
      idempotencyKey,
      sponsorReference,
      network,
      purpose: 'asset-grant',
      asset: 'TRX',
      receiverAddress,
      amountBaseUnits: '25',
    }
    assert.equal((await reserveSponsorTransfer(intent)).reserved, true)
    assert.equal((await reserveSponsorTransfer(intent)).duplicate, true)

    assert.deepEqual(await transitionSponsorTransfer({
      idempotencyKey, nextStatus: 'authorized', authorizationReference: `wallet-approval-${suffix}`,
    }), { updated: false, reason: 'wallet-signature-verification-not-integrated' })

    assert.deepEqual(await transitionSponsorTransfer({
      idempotencyKey, nextStatus: 'submitted', transactionHash,
    }), { updated: false, reason: 'provider-submission-adapter-disabled' })

    const budget = await pool.query(
      `SELECT reserved_base_units::text AS reserved, spent_base_units::text AS spent
         FROM trc20_token_clone.sponsor_budgets WHERE sponsor_reference = $1`,
      [sponsorReference],
    )
    assert.deepEqual(budget.rows[0], { reserved: '25', spent: '0' })
    const transfer = await pool.query(
      'SELECT status, transaction_hash FROM trc20_token_clone.sponsor_transfers WHERE idempotency_key = $1',
      [idempotencyKey],
    )
    assert.equal(transfer.rows[0].status, 'pending-review')
    assert.equal(transfer.rows[0].transaction_hash, null)
  } finally {
    await cleanup(pool, [sponsorReference], [idempotencyKey])
    await pool.end()
  }
})
test('PostgreSQL settles an already-submitted asset grant only with exact verified evidence and only once', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async () => {
  const { pool, reserveSponsorTransfer, transitionSponsorTransfer } = await setup()
  const suffix = randomUUID()
  const sponsorReference = `pg-reconcile-seeded-${suffix}`
  const idempotencyKey = `pg-reconcile-seeded:${suffix}`
  const transactionHash = 'f'.repeat(64)
  try {
    await insertBudget(pool, sponsorReference, '100')
    assert.equal((await reserveSponsorTransfer({
      idempotencyKey, sponsorReference, network, purpose: 'asset-grant', asset: 'TRX',
      receiverAddress, amountBaseUnits: '25',
    })).reserved, true)
    // This is a test fixture for an existing broadcast; production code cannot
    // create this state while provider submission remains disabled.
    await seedPreviouslySubmittedTransfer(pool, idempotencyKey, transactionHash)
    await pool.query(
      `INSERT INTO trc20_token_clone.native_transfer_verifications
        (network, transaction_hash, from_address, to_address, amount_sun, block_number, verification_status)
       VALUES ($1,$2,$3,$4,25,54321,'verified-on-chain')`,
      [network, transactionHash, sponsorAddress, receiverAddress],
    )

    assert.deepEqual(await transitionSponsorTransfer({
      idempotencyKey, nextStatus: 'confirmed', transactionHash,
    }), { updated: true, duplicate: false, status: 'confirmed' })
    assert.deepEqual(await transitionSponsorTransfer({
      idempotencyKey, nextStatus: 'confirmed', transactionHash,
    }), { updated: true, duplicate: true, status: 'confirmed' })

    const budget = await pool.query(
      `SELECT reserved_base_units::text AS reserved, spent_base_units::text AS spent
         FROM trc20_token_clone.sponsor_budgets WHERE sponsor_reference = $1`,
      [sponsorReference],
    )
    assert.deepEqual(budget.rows[0], { reserved: '0', spent: '25' })
  } finally {
    await cleanup(pool, [sponsorReference], [idempotencyKey])
    await pool.query(
      'DELETE FROM trc20_token_clone.native_transfer_verifications WHERE network = $1 AND transaction_hash = $2',
      [network, transactionHash],
    )
    await pool.end()
  }
})

test('concurrent reservations serialize on the budget row and cannot overspend', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async () => {
  const { pool, reserveSponsorTransfer } = await setup()
  const suffix = randomUUID()
  const sponsorReference = `pg-race-${suffix}`
  const keys = [`pg-race-a:${suffix}`, `pg-race-b:${suffix}`]
  try {
    await insertBudget(pool, sponsorReference, '100')
    const reserve = (idempotencyKey) => reserveSponsorTransfer({
      idempotencyKey,
      sponsorReference,
      network,
      purpose: 'asset-grant',
      asset: 'TRX',
      receiverAddress,
      amountBaseUnits: '60',
    })
    const outcomes = await Promise.all(keys.map(reserve))
    assert.equal(outcomes.filter((item) => item.reserved && !item.duplicate).length, 1)
    assert.equal(outcomes.filter((item) => !item.reserved && item.reason === 'insufficient-sponsor-budget').length, 1)

    const budget = await pool.query(
      `SELECT budget_base_units::text AS budget, reserved_base_units::text AS reserved,
              spent_base_units::text AS spent
         FROM trc20_token_clone.sponsor_budgets WHERE sponsor_reference = $1`,
      [sponsorReference],
    )
    assert.deepEqual(budget.rows[0], { budget: '100', reserved: '60', spent: '0' })
    const transfers = await pool.query(
      'SELECT count(*)::int AS count FROM trc20_token_clone.sponsor_transfers WHERE idempotency_key = ANY($1::text[])',
      [keys],
    )
    assert.equal(transfers.rows[0].count, 1)
  } finally {
    await cleanup(pool, [sponsorReference], keys)
    await pool.end()
  }
})


test('PostgreSQL rolls back sponsor ledger and status when the audit insert fails', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async () => {
  const { pool, reserveSponsorTransfer, transitionSponsorTransfer } = await setup()
  const suffix = randomUUID()
  const sponsorReference = `pg-audit-${suffix}`
  const idempotencyKey = `pg-audit:${suffix}`
  const transactionHash = 'b'.repeat(64)
  const triggerName = `fail_audit_${suffix.replaceAll('-', '')}`
  const functionName = `fail_audit_fn_${suffix.replaceAll('-', '')}`
  try {
    await insertBudget(pool, sponsorReference, '100')
    const reserved = await reserveSponsorTransfer({
      idempotencyKey, sponsorReference, network, purpose: 'asset-grant', asset: 'TRX',
      receiverAddress, amountBaseUnits: '25',
    })
    assert.equal(reserved.reserved, true)
    await seedPreviouslySubmittedTransfer(pool, idempotencyKey, transactionHash)
    await pool.query(
      `INSERT INTO trc20_token_clone.native_transfer_verifications
        (network, transaction_hash, from_address, to_address, amount_sun, block_number, verification_status)
       VALUES ($1,$2,$3,$4,25,12346,'verified-on-chain')`,
      [network, transactionHash, sponsorAddress, receiverAddress],
    )

    await pool.query(`
      CREATE FUNCTION trc20_token_clone.${functionName}() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'sponsor-transfer-status-changed'
           AND NEW.entity_reference = '${idempotencyKey}' THEN
          RAISE EXCEPTION 'intentional integration-test audit failure';
        END IF;
        RETURN NEW;
      END;
      $$`)
    await pool.query(`
      CREATE TRIGGER ${triggerName}
      BEFORE INSERT ON trc20_token_clone.audit_events
      FOR EACH ROW EXECUTE FUNCTION trc20_token_clone.${functionName}()
    `)

    await assert.rejects(
      transitionSponsorTransfer({ idempotencyKey, nextStatus: 'confirmed', transactionHash }),
      /intentional integration-test audit failure/,
    )

    const budget = await pool.query(
      `SELECT reserved_base_units::text AS reserved, spent_base_units::text AS spent
         FROM trc20_token_clone.sponsor_budgets WHERE sponsor_reference = $1`,
      [sponsorReference],
    )
    assert.deepEqual(budget.rows[0], { reserved: '25', spent: '0' })
    const transfer = await pool.query(
      'SELECT status FROM trc20_token_clone.sponsor_transfers WHERE idempotency_key = $1',
      [idempotencyKey],
    )
    assert.equal(transfer.rows[0].status, 'submitted')
    const audit = await pool.query(
      `SELECT count(*)::int AS count FROM trc20_token_clone.audit_events
        WHERE event_type = 'sponsor-transfer-status-changed' AND entity_reference = $1
          AND details->>'toStatus' = 'confirmed'`,
      [idempotencyKey],
    )
    assert.equal(audit.rows[0].count, 0)
  } finally {
    await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON trc20_token_clone.audit_events`).catch(() => {})
    await pool.query(`DROP FUNCTION IF EXISTS trc20_token_clone.${functionName}()`).catch(() => {})
    await cleanup(pool, [sponsorReference], [idempotencyKey])
    await pool.query(
      'DELETE FROM trc20_token_clone.native_transfer_verifications WHERE network = $1 AND transaction_hash = $2',
      [network, transactionHash],
    )
    await pool.end()
  }
})


test('PostgreSQL rejects TRC20 sponsor confirmation when finalized evidence mismatches receiver, contract, or amount', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async () => {
  const { pool, reserveSponsorTransfer, transitionSponsorTransfer } = await setup()
  const suffix = randomUUID()
  const tokenContract = sponsorAddress
  const wrongContract = receiverAddress
  const cases = [
    { name: 'receiver', hash: 'c'.repeat(64), evidenceContract: tokenContract, evidenceReceiver: sponsorAddress, evidenceAmount: '25' },
    { name: 'contract', hash: 'd'.repeat(64), evidenceContract: wrongContract, evidenceReceiver: receiverAddress, evidenceAmount: '25' },
    { name: 'amount', hash: 'e'.repeat(64), evidenceContract: tokenContract, evidenceReceiver: receiverAddress, evidenceAmount: '24' },
  ]
  const sponsorReferences = cases.map(item => `pg-usdt-${item.name}-${suffix}`)
  const idempotencyKeys = cases.map(item => `pg-usdt-${item.name}:${suffix}`)
  const previousUsdtShastaContracts = process.env.SPONSOR_USDT_SHASTA_CONTRACTS
  try {
    // The test contract is deliberately scoped to this isolated test process and network.
    process.env.SPONSOR_USDT_SHASTA_CONTRACTS = tokenContract
    for (let i = 0; i < cases.length; i += 1) {
      const item = cases[i]
      const sponsorReference = sponsorReferences[i]
      const idempotencyKey = idempotencyKeys[i]
      await insertUsdtBudget(pool, sponsorReference, tokenContract, '100')
      const reserved = await reserveSponsorTransfer({
        idempotencyKey, sponsorReference, network, purpose: 'asset-grant', asset: 'USDT',
        tokenContract, receiverAddress, amountBaseUnits: '25',
      })
      assert.equal(reserved.reserved, true, `${item.name}: reservation should be created`)
      await seedPreviouslySubmittedTransfer(pool, idempotencyKey, item.hash)
      await pool.query(
        `INSERT INTO trc20_token_clone.transfer_verifications
          (network, transaction_hash, token_contract, from_address, to_address,
           amount_base_units, verification_status, block_number, log_index, result)
         VALUES ($1,$2,$3,$4,$5,$6,'verified-on-chain',12347,0,'{}'::jsonb)`,
        [network, item.hash, item.evidenceContract, sponsorAddress, item.evidenceReceiver, item.evidenceAmount],
      )
      const result = await transitionSponsorTransfer({ idempotencyKey, nextStatus: 'confirmed', transactionHash: item.hash })
      assert.deepEqual(result, { updated: false, reason: 'finalized-transfer-evidence-not-found' }, item.name)
      const budget = await pool.query(
        `SELECT reserved_base_units::text AS reserved, spent_base_units::text AS spent
           FROM trc20_token_clone.sponsor_budgets WHERE sponsor_reference = $1`,
        [sponsorReference],
      )
      assert.deepEqual(budget.rows[0], { reserved: '25', spent: '0' }, `${item.name}: budget must remain reserved`)
      const transfer = await pool.query(
        'SELECT status FROM trc20_token_clone.sponsor_transfers WHERE idempotency_key = $1',
        [idempotencyKey],
      )
      assert.equal(transfer.rows[0].status, 'submitted', `${item.name}: transfer must remain submitted`)
    }
  } finally {
    if (previousUsdtShastaContracts === undefined) delete process.env.SPONSOR_USDT_SHASTA_CONTRACTS
    else process.env.SPONSOR_USDT_SHASTA_CONTRACTS = previousUsdtShastaContracts
    await cleanup(pool, sponsorReferences, idempotencyKeys)
    await pool.query(
      'DELETE FROM trc20_token_clone.transfer_verifications WHERE network = $1 AND transaction_hash = ANY($2::char(64)[])',
      [network, cases.map(item => item.hash)],
    )
    await pool.end()
  }
})


test('PostgreSQL binds independent verified sponsor accounts to exact approved principal and fee budgets', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async () => {
  const { pool } = await setup()
  const {
    createSponsorOrganizationStore,
  } = await import('../server/sponsor-organizations.mjs')
  const store = createSponsorOrganizationStore({ databasePool: pool })
  const suffix = randomUUID()
  const organizationReference = `pg-multi-org-${suffix}`
  const principalReference = `pg-principal-${suffix}`
  const feeReference = `pg-fee-${suffix}`
  const agreementReference = `pg-org-agreement-${suffix}`
  const principalReview = `pg-principal-review-${suffix}`
  const feeReview = `pg-fee-review-${suffix}`
  const principalLinkReview = `pg-principal-link-${suffix}`
  const feeLinkReview = `pg-fee-link-${suffix}`
  const previousApprovals = process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES
  let organizationId = null
  const accountIds = []
  const budgetIds = []
  try {
    const scopes = [
      [agreementReference, principalReference, network, sponsorAddress, 'asset-grant', 'TRX', '-'].join('|'),
      [agreementReference, feeReference, network, receiverAddress, 'network-fee', 'TRX', '-'].join('|'),
    ]
    const existingScopes = String(previousApprovals || '').split(';').map((value) => value.trim()).filter(Boolean)
    process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES = [...new Set([...existingScopes, ...scopes])].join(';')

    const created = await store.createOrganization({
      sponsorReference: organizationReference,
      legalName: 'PostgreSQL Sponsor Registry Integration Ltd',
      displayName: 'PostgreSQL Sponsor Integration',
      jurisdictionCountryCode: 'SG',
    })
    assert.equal(created.success, true)
    organizationId = created.organization.id

    const underReview = await store.reviewOrganization(organizationId, {
      decision: 'under_review',
      reviewReference: `org-review-under-${suffix}`,
    })
    assert.equal(underReview.success, true)
    const verified = await store.reviewOrganization(organizationId, {
      decision: 'verified',
      reviewReference: `org-review-verified-${suffix}`,
      evidenceReference: `org-evidence-${suffix}`,
      verificationMethod: 'manual-independent-review',
    })
    assert.equal(verified.success, true)

    const principalAccount = await store.createAccount(organizationId, {
      sponsorReference: principalReference,
      network,
      role: 'asset-principal',
      address: sponsorAddress,
    })
    assert.equal(principalAccount.success, true)
    accountIds.push(principalAccount.account.id)
    const feeAccount = await store.createAccount(organizationId, {
      sponsorReference: feeReference,
      network,
      role: 'network-fee',
      address: receiverAddress,
    })
    assert.equal(feeAccount.success, true)
    accountIds.push(feeAccount.account.id)

    for (const [accountId, label] of [
      [principalAccount.account.id, 'principal'],
      [feeAccount.account.id, 'fee'],
    ]) {
      const verifiedAccount = await store.reviewAccount(organizationId, accountId, {
        decision: 'verified',
        reviewReference: `account-review-${label}-${suffix}`,
        evidenceReference: `account-evidence-${label}-${suffix}`,
        verificationMethod: 'manual-independent-review',
      })
      assert.equal(verifiedAccount.success, true)
    }

    const approved = await store.reviewOrganization(organizationId, {
      decision: 'approved',
      reviewReference: `org-review-approved-${suffix}`,
      agreementReference,
    })
    assert.equal(approved.success, true)

    const insertedBudgets = await pool.query(`
      INSERT INTO trc20_token_clone.sponsor_budgets
        (sponsor_reference, sponsor_address, network, purpose, asset, token_contract,
         budget_base_units, reserved_base_units, spent_base_units, status,
         approval_reference, review_reference, approved_at)
      VALUES
        ($1,$2,$3,'asset-grant','TRX',NULL,1000000,0,0,'active',$4,$5,now()),
        ($6,$7,$3,'network-fee','TRX',NULL,2000000,0,0,'active',$4,$8,now())
      RETURNING id::text AS id, sponsor_reference
    `, [principalReference, sponsorAddress, network, agreementReference,
      principalReview, feeReference, receiverAddress, feeReview])
    assert.equal(insertedBudgets.rows.length, 2)
    const principalBudgetId = insertedBudgets.rows.find(row => row.sponsor_reference === principalReference).id
    const feeBudgetId = insertedBudgets.rows.find(row => row.sponsor_reference === feeReference).id
    budgetIds.push(principalBudgetId, feeBudgetId)

    const principalLink = await store.linkBudget(
      organizationId, principalAccount.account.id, principalBudgetId, principalLinkReview,
    )
    const feeLink = await store.linkBudget(
      organizationId, feeAccount.account.id, feeBudgetId, feeLinkReview,
    )
    assert.equal(principalLink.success, true)
    assert.equal(feeLink.success, true)
    assert.equal(principalLink.link.status, 'active')
    assert.equal(feeLink.link.status, 'active')

    const duplicate = await store.linkBudget(
      organizationId, principalAccount.account.id, principalBudgetId, principalLinkReview,
    )
    assert.equal(duplicate.success, true)
    assert.equal(duplicate.duplicate, true)

    const wrongRole = await store.linkBudget(
      organizationId, feeAccount.account.id, principalBudgetId, `wrong-role-link-${suffix}`,
    )
    assert.deepEqual(wrongRole, { success: false, reason: 'budget-account-scope-mismatch' })

    const listed = await store.listBudgetLinks({ organizationId, network, limit: 10 })
    assert.equal(listed.success, true)
    assert.equal(listed.links.length, 2)
    assert.ok(listed.links.every(link => link.linkCurrentlyActive === true))
    assert.ok(listed.links.every(link => link.agreementScopeVerified === true))

    const accountSuspended = await store.reviewAccount(organizationId, feeAccount.account.id, {
      decision: 'suspended',
      reviewReference: `suspend-fee-account-${suffix}`,
    })
    assert.equal(accountSuspended.success, true)
    const afterAccountSuspend = await store.listBudgetLinks({ organizationId, network, limit: 10 })
    const suspendedFeeLink = afterAccountSuspend.links.find(link => link.budgetId === feeBudgetId)
    assert.equal(suspendedFeeLink.linkStatus, 'suspended')
    assert.equal(suspendedFeeLink.linkCurrentlyActive, false)

    const revoked = await store.revokeBudgetLink(principalLink.link.id, `revoke-link-${suffix}`)
    assert.equal(revoked.success, true)
    assert.equal(revoked.link.status, 'revoked')
    const afterRevoke = await store.listBudgetLinks({ organizationId, network, limit: 10 })
    assert.equal(afterRevoke.success, true)
    assert.equal(afterRevoke.links.find(link => link.budgetId === principalBudgetId).linkCurrentlyActive, false)
  } finally {
    if (organizationId) {
      await pool.query(
        'DELETE FROM trc20_token_clone.sponsor_organization_audit_events WHERE organization_id = $1',
        [organizationId],
      )
      await pool.query(
        'DELETE FROM trc20_token_clone.sponsor_organization_budget_links WHERE organization_id = $1',
        [organizationId],
      )
      if (accountIds.length) {
        await pool.query(
          'DELETE FROM trc20_token_clone.sponsor_organization_accounts WHERE organization_id = $1 AND id = ANY($2::bigint[])',
          [organizationId, accountIds],
        )
      }
      await pool.query(
        'DELETE FROM trc20_token_clone.sponsor_organizations WHERE id = $1',
        [organizationId],
      )
    }
    if (budgetIds.length) {
      await pool.query('DELETE FROM trc20_token_clone.sponsor_budgets WHERE id = ANY($1::bigint[])', [budgetIds])
    }
    if (previousApprovals === undefined) delete process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES
    else process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES = previousApprovals
    await pool.end()
  }
})


test('PostgreSQL atomically reserves and releases independent principal and fee sponsor budgets', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async () => {
  const { pool } = await setup()
  const { createSponsorOrganizationStore } = await import('../server/sponsor-organizations.mjs')
  const store = createSponsorOrganizationStore({ databasePool: pool })
  const suffix = randomUUID()
  const principalOrgRef = 'pg-intent-principal-org-' + suffix
  const feeOrgRef = 'pg-intent-fee-org-' + suffix
  const principalRef = 'pg-intent-principal-' + suffix
  const feeRef = 'pg-intent-fee-' + suffix
  const principalAgreement = 'pg-intent-principal-agreement-' + suffix
  const feeAgreement = 'pg-intent-fee-agreement-' + suffix
  const principalReview = 'pg-intent-principal-budget-review-' + suffix
  const feeReview = 'pg-intent-fee-budget-review-' + suffix
  const principalLinkReview = 'pg-intent-principal-link-' + suffix
  const feeLinkReview = 'pg-intent-fee-link-' + suffix
  const primaryKey = 'pg-dual-intent:' + suffix
  const expiryKey = 'pg-dual-expiry:' + suffix
  const organizationIds = []
  const budgetIds = []
  const intentIds = []
  const previousScopes = process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES
  try {
    const scopes = [
      [principalAgreement, principalRef, network, sponsorAddress, 'asset-grant', 'TRX', '-'].join('|'),
      [feeAgreement, feeRef, network, receiverAddress, 'network-fee', 'TRX', '-'].join('|'),
    ]
    const priorScopes = String(previousScopes || '').split(';').map((value) => value.trim()).filter(Boolean)
    process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES = [...new Set([...priorScopes, ...scopes])].join(';')

    async function registerSponsor({ organizationReference, accountReference, agreementReference, address, role, legalName }) {
      const created = await store.createOrganization({ sponsorReference: organizationReference, legalName })
      assert.equal(created.success, true)
      organizationIds.push(created.organization.id)
      const underReview = await store.reviewOrganization(created.organization.id, {
        decision: 'under_review', reviewReference: 'under-review-' + suffix + '-' + role,
      })
      assert.equal(underReview.success, true)
      const verified = await store.reviewOrganization(created.organization.id, {
        decision: 'verified', reviewReference: 'verified-review-' + suffix + '-' + role,
        evidenceReference: 'evidence-' + suffix + '-' + role, verificationMethod: 'manual-independent-review',
      })
      assert.equal(verified.success, true)
      const account = await store.createAccount(created.organization.id, {
        sponsorReference: accountReference, network, role, address,
      })
      assert.equal(account.success, true)
      const accountVerified = await store.reviewAccount(created.organization.id, account.account.id, {
        decision: 'verified', reviewReference: 'account-review-' + suffix + '-' + role,
        evidenceReference: 'account-evidence-' + suffix + '-' + role,
        verificationMethod: 'manual-independent-review',
      })
      assert.equal(accountVerified.success, true)
      const approved = await store.reviewOrganization(created.organization.id, {
        decision: 'approved', reviewReference: 'approved-review-' + suffix + '-' + role, agreementReference,
      })
      assert.equal(approved.success, true)
      return { organizationId: created.organization.id, accountId: account.account.id }
    }

    const principalSponsor = await registerSponsor({
      organizationReference: principalOrgRef, accountReference: principalRef,
      agreementReference: principalAgreement, address: sponsorAddress,
      role: 'asset-principal', legalName: 'Independent Principal Sponsor Integration Ltd',
    })
    const feeSponsor = await registerSponsor({
      organizationReference: feeOrgRef, accountReference: feeRef,
      agreementReference: feeAgreement, address: receiverAddress,
      role: 'network-fee', legalName: 'Independent Network Fee Sponsor Integration Ltd',
    })

    const inserted = await pool.query(
      "INSERT INTO trc20_token_clone.sponsor_budgets " +
      "(sponsor_reference, sponsor_address, network, purpose, asset, token_contract, budget_base_units, " +
      "reserved_base_units, spent_base_units, status, approval_reference, review_reference, approved_at) " +
      "VALUES ($1,$2,$3,'asset-grant','TRX',NULL,1000000,0,0,'active',$4,$5,now()), " +
      "($6,$7,$3,'network-fee','TRX',NULL,2000000,0,0,'active',$8,$9,now()) " +
      "RETURNING id::text AS id, sponsor_reference",
      [principalRef, sponsorAddress, network, principalAgreement, principalReview,
        feeRef, receiverAddress, feeAgreement, feeReview],
    )
    assert.equal(inserted.rows.length, 2)
    const principalBudgetId = inserted.rows.find(row => row.sponsor_reference === principalRef).id
    const feeBudgetId = inserted.rows.find(row => row.sponsor_reference === feeRef).id
    budgetIds.push(principalBudgetId, feeBudgetId)

    const principalLink = await store.linkBudget(
      principalSponsor.organizationId, principalSponsor.accountId, principalBudgetId, principalLinkReview,
    )
    const feeLink = await store.linkBudget(
      feeSponsor.organizationId, feeSponsor.accountId, feeBudgetId, feeLinkReview,
    )
    assert.equal(principalLink.success, true)
    assert.equal(feeLink.success, true)

    const makeSnapshot = (address) => ({
      status: 'solidified-sponsor-balances-read',
      onChainBalanceRead: true,
      network,
      sponsorAddress: address,
      source: 'Tatum TRON SolidityNode account and constant-contract queries',
      checkedAt: new Date().toISOString(),
      cache: { status: 'fresh', ageMs: 0 },
      native: { status: 'verified', asset: 'TRX', balanceSun: '999999999999999999999999999999999999' },
      tokens: [],
    })
    const fundingSnapshots = {
      networkFeeSponsor: makeSnapshot(receiverAddress),
      assetPrincipalSponsor: makeSnapshot(sponsorAddress),
    }
    const baseIntent = {
      idempotencyKey: primaryKey, network, asset: 'TRX', tokenContract: null,
      receiverAddress: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE',
      amountBaseUnits: '250000', feeCapSun: '125000',
      principalLinkId: principalLink.link.id, feeLinkId: feeLink.link.id, fundingSnapshots,
    }

    const reserved = await store.reservePayoutIntent(baseIntent)
    assert.equal(reserved.success, true, JSON.stringify(reserved))
    assert.equal(reserved.status, 'pending_authorization')
    assert.equal(reserved.canSubmitSponsoredTransfer, false)
    intentIds.push(reserved.intentId)

    async function authorizeRole(intentId, role, address, suffixRole) {
      const challenge = await store.createPayoutAuthorizationChallenge(intentId, role, {
        sessionAddress: address,
        sessionNetwork: network,
      })
      assert.equal(challenge.success, true, JSON.stringify(challenge))
      assert.equal(challenge.challenge.role, role)
      assert.match(challenge.challenge.message, /Intent digest \(SHA-256\):/)
      assert.match(challenge.challenge.message, /This message is not a blockchain transaction/)
      assert.match(challenge.challenge.message, new RegExp(role === 'asset-principal' ? 'Independent Principal Sponsor Integration Ltd' : 'Independent Network Fee Sponsor Integration Ltd'))
      const consumedChallenge = await store.consumePayoutAuthorizationChallenge(
        intentId, role, challenge.challenge.nonce,
        { sessionAddress: address, sessionNetwork: network },
      )
      assert.equal(consumedChallenge.success, true, JSON.stringify(consumedChallenge))
      assert.equal(consumedChallenge.authorization.sponsorAddress, address)
      const recorded = await store.recordPayoutAuthorization({
        intentId,
        role,
        challengeId: consumedChallenge.authorization.challengeId,
        intentDigest: consumedChallenge.authorization.intentDigest,
        recoveredAddress: address,
        signatureHash: (suffixRole === 'principal' ? 'a' : 'b').repeat(64),
        messageHash: consumedChallenge.authorization.messageHash,
      })
      assert.equal(recorded.success, true, JSON.stringify(recorded))
      return recorded
    }

    const principalApproval = await authorizeRole(
      reserved.intentId, 'asset-principal', sponsorAddress, 'principal',
    )
    assert.equal(principalApproval.status, 'pending_authorization')
    assert.deepEqual(principalApproval.missingRoles, ['network-fee'])
    assert.equal(principalApproval.canSubmitSponsoredTransfer, false)

    const feeApproval = await authorizeRole(
      reserved.intentId, 'network-fee', receiverAddress, 'fee',
    )
    assert.equal(feeApproval.status, 'sponsor_authorization_complete')
    assert.equal(feeApproval.bothSponsorsAuthorized, true)
    assert.deepEqual(feeApproval.authorizedRoles, ['asset-principal', 'network-fee'])
    assert.equal(feeApproval.canSubmitSponsoredTransfer, false)
    assert.equal(feeApproval.submissionEnabled, false)

    const preflightIntent = await store.getPayoutIntentForPreflight(reserved.intentId)
    assert.equal(preflightIntent.success, true, JSON.stringify(preflightIntent))
    assert.equal(preflightIntent.sponsorOwnerApprovalsVerified, true)
    assert.equal(preflightIntent.intent.status, 'sponsor_authorization_complete')
    assert.equal(preflightIntent.intent.principalSponsorAddress, sponsorAddress)
    assert.equal(preflightIntent.intent.feeSponsorAddress, receiverAddress)
    assert.equal(preflightIntent.canSubmitSponsoredTransfer, false)
    assert.equal(preflightIntent.submissionEnabled, false)

    const authorizationRows = await pool.query(
      "SELECT role, sponsor_address, signature_hash FROM trc20_token_clone.sponsor_organization_payout_authorizations " +
      "WHERE intent_id = $1 ORDER BY role",
      [reserved.intentId],
    )
    assert.equal(authorizationRows.rows.length, 2)
    assert.equal(authorizationRows.rows[0].signature_hash.length, 64)
    assert.equal(authorizationRows.rows[1].signature_hash.length, 64)
    const challengeRows = await pool.query(
      "SELECT nonce_hash, consumed_at FROM trc20_token_clone.sponsor_organization_payout_authorization_challenges " +
      "WHERE intent_id = $1 ORDER BY id",
      [reserved.intentId],
    )
    assert.equal(challengeRows.rows.length, 2)
    assert.ok(challengeRows.rows.every(row => row.consumed_at != null && row.nonce_hash.length === 64))

    const duplicate = await store.reservePayoutIntent(baseIntent)
    assert.equal(duplicate.success, true)
    assert.equal(duplicate.duplicate, true)
    assert.equal(duplicate.intentId, reserved.intentId)

    const conflict = await store.reservePayoutIntent({ ...baseIntent, amountBaseUnits: '250001' })
    assert.deepEqual(conflict, { success: false, reason: 'idempotency-key-conflict' })

    const budgetAfterReserve = await pool.query(
      "SELECT id::text AS id, reserved_base_units::text AS reserved " +
      "FROM trc20_token_clone.sponsor_budgets WHERE id = ANY($1::bigint[]) ORDER BY id",
      [budgetIds],
    )
    assert.deepEqual(budgetAfterReserve.rows.map(row => row.reserved), ['250000', '125000'])

    const cancelled = await store.cancelPayoutIntent(reserved.intentId, 'operator-cancel-' + suffix)
    assert.equal(cancelled.success, true)
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(cancelled.reservationReleased, true)
    const budgetAfterCancel = await pool.query(
      "SELECT id::text AS id, reserved_base_units::text AS reserved " +
      "FROM trc20_token_clone.sponsor_budgets WHERE id = ANY($1::bigint[]) ORDER BY id",
      [budgetIds],
    )
    assert.deepEqual(budgetAfterCancel.rows.map(row => row.reserved), ['0', '0'])

    const expiring = await store.reservePayoutIntent({ ...baseIntent, idempotencyKey: expiryKey })
    assert.equal(expiring.success, true, JSON.stringify(expiring))
    intentIds.push(expiring.intentId)
    const expiryPrincipalApproval = await authorizeRole(
      expiring.intentId, 'asset-principal', sponsorAddress, 'principal',
    )
    assert.equal(expiryPrincipalApproval.status, 'pending_authorization')
    const expiryFeeApproval = await authorizeRole(
      expiring.intentId, 'network-fee', receiverAddress, 'fee',
    )
    assert.equal(expiryFeeApproval.status, 'sponsor_authorization_complete')
    await pool.query(
      "UPDATE trc20_token_clone.sponsor_organization_payout_intents " +
      "SET expires_at = now() - interval '1 second' WHERE id = $1",
      [expiring.intentId],
    )
    const expired = await store.expirePayoutIntents({ limit: 10 })
    assert.equal(expired.success, true)
    assert.equal(expired.expiredCount, 1)
    const expiredBudgetState = await pool.query(
      "SELECT id::text AS id, reserved_base_units::text AS reserved " +
      "FROM trc20_token_clone.sponsor_budgets WHERE id = ANY($1::bigint[]) ORDER BY id",
      [budgetIds],
    )
    assert.deepEqual(expiredBudgetState.rows.map(row => row.reserved), ['0', '0'])
    const expiredIntent = await pool.query(
      "SELECT status FROM trc20_token_clone.sponsor_organization_payout_intents WHERE id = $1",
      [expiring.intentId],
    )
    assert.equal(expiredIntent.rows[0].status, 'expired')
  } finally {
    if (previousScopes === undefined) delete process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES
    else process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES = previousScopes
    if (intentIds.length) {
      await pool.query(
        'DELETE FROM trc20_token_clone.sponsor_organization_payout_authorizations WHERE intent_id = ANY($1::bigint[])',
        [intentIds],
      ).catch(() => {})
      await pool.query(
        'DELETE FROM trc20_token_clone.sponsor_organization_payout_authorization_challenges WHERE intent_id = ANY($1::bigint[])',
        [intentIds],
      ).catch(() => {})
      await pool.query(
        'DELETE FROM trc20_token_clone.sponsor_organization_payout_reservations WHERE intent_id = ANY($1::bigint[])',
        [intentIds],
      ).catch(() => {})
      await pool.query(
        'DELETE FROM trc20_token_clone.sponsor_organization_payout_intents WHERE id = ANY($1::bigint[])',
        [intentIds],
      ).catch(() => {})
    }
    if (organizationIds.length) {
      await pool.query(
        'DELETE FROM trc20_token_clone.sponsor_organization_audit_events WHERE organization_id = ANY($1::bigint[])',
        [organizationIds],
      ).catch(() => {})
      await pool.query(
        'DELETE FROM trc20_token_clone.sponsor_organization_budget_links WHERE organization_id = ANY($1::bigint[])',
        [organizationIds],
      ).catch(() => {})
      await pool.query(
        'DELETE FROM trc20_token_clone.sponsor_organization_accounts WHERE organization_id = ANY($1::bigint[])',
        [organizationIds],
      ).catch(() => {})
      await pool.query(
        'DELETE FROM trc20_token_clone.sponsor_organizations WHERE id = ANY($1::bigint[])',
        [organizationIds],
      ).catch(() => {})
    }
    if (budgetIds.length) {
      await pool.query('DELETE FROM trc20_token_clone.sponsor_budgets WHERE id = ANY($1::bigint[])', [budgetIds]).catch(() => {})
    }
    await pool.end()
  }
})

test('PostgreSQL reserves both payout roles for one organization using distinct verified accounts and budgets', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async () => {
  const { pool } = await setup()
  const { createSponsorOrganizationStore } = await import('../server/sponsor-organizations.mjs')
  const store = createSponsorOrganizationStore({ databasePool: pool })
  const suffix = randomUUID()
  const organizationReference = 'pg-single-provider-org-' + suffix
  const principalReference = 'pg-single-provider-principal-' + suffix
  const feeReference = 'pg-single-provider-fee-' + suffix
  const agreementReference = 'pg-single-provider-agreement-' + suffix
  const principalReview = 'pg-single-provider-principal-review-' + suffix
  const feeReview = 'pg-single-provider-fee-review-' + suffix
  const principalLinkReview = 'pg-single-provider-principal-link-' + suffix
  const feeLinkReview = 'pg-single-provider-fee-link-' + suffix
  const idempotencyKey = 'pg-single-provider-intent:' + suffix
  const organizationIds = []
  const accountIds = []
  const budgetIds = []
  const intentIds = []
  const previousScopes = process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES
  try {
    const scopes = [
      [agreementReference, principalReference, network, sponsorAddress, 'asset-grant', 'TRX', '-'].join('|'),
      [agreementReference, feeReference, network, receiverAddress, 'network-fee', 'TRX', '-'].join('|'),
    ]
    const priorScopes = String(previousScopes || '').split(';').map((value) => value.trim()).filter(Boolean)
    process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES = [...new Set([...priorScopes, ...scopes])].join(';')

    const created = await store.createOrganization({
      sponsorReference: organizationReference,
      legalName: 'Single Provider Dual Role Integration Ltd',
    })
    assert.equal(created.success, true)
    const organizationId = created.organization.id
    organizationIds.push(organizationId)
    assert.equal((await store.reviewOrganization(organizationId, {
      decision: 'under_review', reviewReference: 'org-under-review-' + suffix,
    })).success, true)
    assert.equal((await store.reviewOrganization(organizationId, {
      decision: 'verified', reviewReference: 'org-verified-' + suffix,
      evidenceReference: 'org-evidence-' + suffix, verificationMethod: 'manual-independent-review',
    })).success, true)

    const principalAccount = await store.createAccount(organizationId, {
      sponsorReference: principalReference, network, role: 'asset-principal', address: sponsorAddress,
    })
    const feeAccount = await store.createAccount(organizationId, {
      sponsorReference: feeReference, network, role: 'network-fee', address: receiverAddress,
    })
    assert.equal(principalAccount.success, true)
    assert.equal(feeAccount.success, true)
    accountIds.push(principalAccount.account.id, feeAccount.account.id)

    for (const [accountId, role] of [
      [principalAccount.account.id, 'principal'],
      [feeAccount.account.id, 'fee'],
    ]) {
      const verified = await store.reviewAccount(organizationId, accountId, {
        decision: 'verified', reviewReference: 'account-review-' + role + '-' + suffix,
        evidenceReference: 'account-evidence-' + role + '-' + suffix,
        verificationMethod: 'manual-independent-review',
      })
      assert.equal(verified.success, true)
    }

    const approved = await store.reviewOrganization(organizationId, {
      decision: 'approved', reviewReference: 'org-approved-' + suffix, agreementReference,
    })
    assert.equal(approved.success, true)

    const inserted = await pool.query(
      "INSERT INTO trc20_token_clone.sponsor_budgets " +
      "(sponsor_reference, sponsor_address, network, purpose, asset, token_contract, budget_base_units, " +
      "reserved_base_units, spent_base_units, status, approval_reference, review_reference, approved_at) " +
      "VALUES ($1,$2,$3,'asset-grant','TRX',NULL,1000000,0,0,'active',$4,$5,now()), " +
      "($6,$7,$3,'network-fee','TRX',NULL,2000000,0,0,'active',$8,$9,now()) " +
      "RETURNING id::text AS id, sponsor_reference",
      [principalReference, sponsorAddress, network, agreementReference, principalReview,
        feeReference, receiverAddress, agreementReference, feeReview],
    )
    assert.equal(inserted.rows.length, 2)
    const principalBudgetId = inserted.rows.find(row => row.sponsor_reference === principalReference).id
    const feeBudgetId = inserted.rows.find(row => row.sponsor_reference === feeReference).id
    budgetIds.push(principalBudgetId, feeBudgetId)

    const principalLink = await store.linkBudget(
      organizationId, principalAccount.account.id, principalBudgetId, principalLinkReview,
    )
    const feeLink = await store.linkBudget(
      organizationId, feeAccount.account.id, feeBudgetId, feeLinkReview,
    )
    assert.equal(principalLink.success, true, JSON.stringify(principalLink))
    assert.equal(feeLink.success, true, JSON.stringify(feeLink))

    const makeSnapshot = (address) => ({
      status: 'solidified-sponsor-balances-read',
      onChainBalanceRead: true,
      network,
      sponsorAddress: address,
      source: 'Tatum TRON SolidityNode account and constant-contract queries',
      checkedAt: new Date().toISOString(),
      cache: { status: 'fresh', ageMs: 0 },
      native: { status: 'verified', asset: 'TRX', balanceSun: '999999999999999999999999999999999999' },
      tokens: [],
    })
    const fundingSnapshots = {
      networkFeeSponsor: makeSnapshot(receiverAddress),
      assetPrincipalSponsor: makeSnapshot(sponsorAddress),
    }
    const reserved = await store.reservePayoutIntent({
      idempotencyKey, network, asset: 'TRX', tokenContract: null,
      receiverAddress: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE',
      amountBaseUnits: '250000', feeCapSun: '125000',
      principalLinkId: principalLink.link.id, feeLinkId: feeLink.link.id, fundingSnapshots,
    })
    assert.equal(reserved.success, true, JSON.stringify(reserved))
    assert.equal(reserved.status, 'pending_authorization')
    assert.equal(reserved.canSubmitSponsoredTransfer, false)
    intentIds.push(reserved.intentId)

    const roleApprovals = []
    for (const [role, address, marker] of [
      ['asset-principal', sponsorAddress, 'a'],
      ['network-fee', receiverAddress, 'b'],
    ]) {
      const challenge = await store.createPayoutAuthorizationChallenge(reserved.intentId, role, {
        sessionAddress: address, sessionNetwork: network,
      })
      assert.equal(challenge.success, true, JSON.stringify(challenge))
      assert.match(challenge.challenge.message, /Single Provider Dual Role Integration Ltd/)
      const consumed = await store.consumePayoutAuthorizationChallenge(
        reserved.intentId, role, challenge.challenge.nonce,
        { sessionAddress: address, sessionNetwork: network },
      )
      assert.equal(consumed.success, true, JSON.stringify(consumed))
      roleApprovals.push(await store.recordPayoutAuthorization({
        intentId: reserved.intentId, role,
        challengeId: consumed.authorization.challengeId,
        intentDigest: consumed.authorization.intentDigest,
        recoveredAddress: address,
        signatureHash: marker.repeat(64),
        messageHash: consumed.authorization.messageHash,
      }))
    }
    assert.equal(roleApprovals[0].status, 'pending_authorization')
    assert.equal(roleApprovals[1].status, 'sponsor_authorization_complete')
    const ready = await store.getPayoutIntentForPreflight(reserved.intentId)
    assert.equal(ready.success, true, JSON.stringify(ready))
    assert.equal(ready.sponsorOwnerApprovalsVerified, true)
    assert.equal(ready.intent.principalSponsorAddress, sponsorAddress)
    assert.equal(ready.intent.feeSponsorAddress, receiverAddress)
    assert.equal(ready.canSubmitSponsoredTransfer, false)
  } finally {
    if (previousScopes === undefined) delete process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES
    else process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES = previousScopes
    if (intentIds.length) {
      await pool.query('DELETE FROM trc20_token_clone.sponsor_organization_payout_authorizations WHERE intent_id = ANY($1::bigint[])', [intentIds]).catch(() => {})
      await pool.query('DELETE FROM trc20_token_clone.sponsor_organization_payout_authorization_challenges WHERE intent_id = ANY($1::bigint[])', [intentIds]).catch(() => {})
      await pool.query('DELETE FROM trc20_token_clone.sponsor_organization_payout_reservations WHERE intent_id = ANY($1::bigint[])', [intentIds]).catch(() => {})
      await pool.query('DELETE FROM trc20_token_clone.sponsor_organization_payout_intents WHERE id = ANY($1::bigint[])', [intentIds]).catch(() => {})
    }
    if (organizationIds.length) {
      await pool.query('DELETE FROM trc20_token_clone.sponsor_organization_audit_events WHERE organization_id = ANY($1::bigint[])', [organizationIds]).catch(() => {})
      await pool.query('DELETE FROM trc20_token_clone.sponsor_organization_budget_links WHERE organization_id = ANY($1::bigint[])', [organizationIds]).catch(() => {})
      await pool.query('DELETE FROM trc20_token_clone.sponsor_organization_accounts WHERE organization_id = ANY($1::bigint[])', [organizationIds]).catch(() => {})
      await pool.query('DELETE FROM trc20_token_clone.sponsor_organizations WHERE id = ANY($1::bigint[])', [organizationIds]).catch(() => {})
    }
    if (budgetIds.length) await pool.query('DELETE FROM trc20_token_clone.sponsor_budgets WHERE id = ANY($1::bigint[])', [budgetIds]).catch(() => {})
    await pool.end()
  }
})
