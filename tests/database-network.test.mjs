import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTransferVerificationUpsert, findVerifiedTransfer, isSponsorTokenContractAllowed, normalizeVerificationNetwork, recordTransferVerification } from '../server/database.mjs'

test('refuses to persist a transfer when the network is missing or unsupported', async () => {
  for (const network of [undefined, null, '', 'TRON', 'ethereum', 'MAINNET']) {
    const input = {
      network,
      transactionHash: 'a'.repeat(64),
      tokenContract: 'contract',
      fromAddress: 'sender',
      toAddress: 'receiver',
      amountBaseUnits: '1',
      status: 'verified-on-chain',
      result: { blockNumber: 123 },
    }
    assert.deepEqual(
      await recordTransferVerification(input),
      { persisted: false, reason: 'invalid-network' },
      `network: ${String(network)}`,
    )
  }
})

test('refuses to infer a network when the input object is missing', async () => {
  assert.deepEqual(
    await recordTransferVerification(undefined),
    { persisted: false, reason: 'invalid-network' },
  )
})

test('accepts only explicit supported TRON network identifiers', () => {
  for (const network of ['mainnet', 'shasta', 'nile']) {
    assert.equal(normalizeVerificationNetwork(network), network)
  }
  for (const network of [undefined, null, '', 'TRON', 'ethereum', 'MAINNET', 1]) {
    assert.equal(normalizeVerificationNetwork(network), null, `network: ${String(network)}`)
  }
})

test('rejects malformed transfer identity and non-integer amounts before database access', async () => {
  const valid = {
    network: 'mainnet',
    transactionHash: 'a'.repeat(64),
    tokenContract: 'contract',
    fromAddress: 'sender',
    toAddress: 'receiver',
    amountBaseUnits: '1',
    status: 'verified-on-chain',
    result: { blockNumber: 123 },
  }
  const invalidCases = [
    { transactionHash: 'not-a-hash' },
    { transactionHash: 'a'.repeat(63) },
    { tokenContract: '' },
    { fromAddress: ' ' },
    { toAddress: null },
    { amountBaseUnits: '1.5' },
    { amountBaseUnits: '-1' },
    { amountBaseUnits: '0' },
    { amountBaseUnits: '' },
    { amountBaseUnits: '9'.repeat(79) },
    { amountBaseUnits: 9007199254740993 },
  ]
  for (const overrides of invalidCases) {
    assert.deepEqual(
      await recordTransferVerification({ ...valid, ...overrides }),
      { persisted: false, reason: 'invalid-record' },
      JSON.stringify(overrides),
    )
  }
})

test('builds a parameterized network-scoped upsert and preserves exact base-unit strings', () => {
  const amountBaseUnits = '900719925474099312345678901234567890'
  const query = buildTransferVerificationUpsert({
    network: 'mainnet',
    transactionHash: 'A'.repeat(64),
    tokenContract: 'contract',
    fromAddress: 'sender',
    toAddress: 'receiver',
    amountBaseUnits,
    status: 'verified-on-chain',
    result: { blockNumber: 123 },
  })

  assert.ok(query.text.includes('ON CONFLICT (network, transaction_hash, token_contract, log_index)'))
  assert.ok(query.text.includes('VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)'))
  assert.equal(query.values[0], 'mainnet')
  assert.equal(query.values[1], 'a'.repeat(64))
  assert.equal(query.values[5], amountBaseUnits)
  assert.equal(query.values[6], 'verified-on-chain')
  assert.equal(query.values[7], 123)
  assert.equal(query.values[8], JSON.stringify({ blockNumber: 123 }))
  assert.equal(query.values[9], 0)
})

test('upsert builder rejects unsupported networks and invalid precision before SQL execution', () => {
  const valid = {
    network: 'mainnet',
    transactionHash: 'a'.repeat(64),
    tokenContract: 'contract',
    fromAddress: 'sender',
    toAddress: 'receiver',
    amountBaseUnits: '1',
  }
  assert.throws(() => buildTransferVerificationUpsert({ ...valid, network: 'TRON' }), /explicit network/)
  assert.throws(() => buildTransferVerificationUpsert({ ...valid, amountBaseUnits: '9'.repeat(79) }), /valid transfer/)
})

test('keeps user-controlled fields in SQL parameters and downgrades invalid status', () => {
  const marker = "contract'); DROP TABLE transfer_verifications; --"
  const query = buildTransferVerificationUpsert({
    network: 'shasta',
    transactionHash: 'b'.repeat(64),
    tokenContract: marker,
    fromAddress: 'sender',
    toAddress: 'receiver',
    amountBaseUnits: '42',
    status: 'exchange-credit-confirmed',
    result: { blockNumber: Number.MAX_SAFE_INTEGER + 1 },
  })

  assert.equal(query.text.includes(marker), false)
  assert.equal(query.values[0], 'shasta')
  assert.equal(query.values[2], marker)
  assert.equal(query.values[6], 'not-verified')
  assert.equal(query.values[7], null)
  assert.match(query.text, /verification_status='verified-on-chain'/)
  assert.match(query.text, /THEN trc20_token_clone\.transfer_verifications\.result/)
  assert.match(query.text, /THEN trc20_token_clone\.transfer_verifications\.verification_status/)
  assert.match(query.text, /THEN trc20_token_clone\.transfer_verifications\.from_address/)
  assert.match(query.text, /THEN trc20_token_clone\.transfer_verifications\.to_address/)
  assert.match(query.text, /THEN trc20_token_clone\.transfer_verifications\.amount_base_units/)
  assert.match(query.text, /block_number=CASE[\s\S]*THEN trc20_token_clone\.transfer_verifications\.block_number[\s\S]*ELSE COALESCE\(EXCLUDED\.block_number, trc20_token_clone\.transfer_verifications\.block_number\)/)
  assert.doesNotMatch(query.text, /verification_status='verified-on-chain'\s+AND EXCLUDED\.verification_status/)
})

test('does not coerce missing, null, fractional, or negative block numbers into a real block', () => {
  const valid = {
    network: 'mainnet',
    transactionHash: 'c'.repeat(64),
    tokenContract: 'contract',
    fromAddress: 'sender',
    toAddress: 'receiver',
    amountBaseUnits: '10',
    status: 'verified-on-chain',
  }
  for (const blockNumber of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const query = buildTransferVerificationUpsert({
      ...valid,
      result: { blockNumber },
    })
    assert.equal(query.values[7], null, `blockNumber: ${String(blockNumber)}`)
  }
  assert.equal(buildTransferVerificationUpsert({
    ...valid,
    result: { blockNumber: 123 },
  }).values[7], 123)
})


test('uses exact event log index as transfer identity and validates it', () => {
  const base = { network: 'mainnet', transactionHash: 'd'.repeat(64), tokenContract: 'contract', fromAddress: 'sender', toAddress: 'receiver', amountBaseUnits: '25', status: 'verified-on-chain', result: { blockNumber: 321, logIndex: 2 } };
  const query = buildTransferVerificationUpsert(base);
  assert.ok(query.text.includes('ON CONFLICT (network, transaction_hash, token_contract, log_index)'))
  assert.equal(query.values[9], 2);
  assert.equal(buildTransferVerificationUpsert({ ...base, logIndex: 1 }).values[9], 1);
  assert.equal(buildTransferVerificationUpsert({ ...base, logIndex: -1 }).values[9], 2);
});

test('database migration uses valid PL/pgSQL block quoting and removes ambiguous wallet network defaults', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../server/database.mjs', import.meta.url), 'utf8')
  assert.ok(source.includes('DO $$ BEGIN'))
  assert.ok(source.includes('END; $$'))
  assert.ok(source.includes('ALTER TABLE ${schema}.tracked_wallets ALTER COLUMN network DROP DEFAULT'))
  assert.ok(!source.includes("network TEXT NOT NULL DEFAULT 'TRON',\n          wallet_address TEXT NOT NULL"))
})


test('verified-event lookup fails closed unless every event identity field is supplied', async () => {
  const base = {
    network: 'mainnet',
    transactionHash: 'e'.repeat(64),
    tokenContract: '41' + '1'.repeat(40),
    fromAddress: '41' + '2'.repeat(40),
    toAddress: '41' + '3'.repeat(40),
    amountBaseUnits: '2500000',
    logIndex: 0,
  }
  for (const overrides of [
    { network: 'TRON' },
    { transactionHash: 'bad' },
    { tokenContract: '' },
    { fromAddress: '' },
    { toAddress: '' },
    { amountBaseUnits: '2.5' },
    { amountBaseUnits: '0' },
    { logIndex: -1 },
    { logIndex: 1.5 },
    { logIndex: undefined },
  ]) {
    assert.deepEqual(
      await findVerifiedTransfer({ ...base, ...overrides }),
      { found: false, reason: 'invalid-lookup' },
      JSON.stringify(overrides),
    )
  }
})

test('verified-event lookup is scoped to network, hash, contract, parties, amount and log index', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../server/database.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('export async function findVerifiedTransfer')
  const end = source.indexOf('export async function getDatabaseStatus', start)
  assert.ok(start >= 0 && end > start)
  const lookup = source.slice(start, end)
  for (const field of [
    'network = $1',
    'transaction_hash = $2',
    'lower(token_contract) = lower($3)',
    'lower(from_address) = lower($4)',
    'lower(to_address) = lower($5)',
    'amount_base_units = $6::numeric',
    'log_index = $7',
    "verification_status = 'verified-on-chain'",
  ]) assert.ok(lookup.includes(field), field)
})


test('sponsor ledger schema separates fee sponsorship from asset grants and is idempotent', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../server/database.mjs', import.meta.url), 'utf8')
  assert.match(source, /CREATE TABLE IF NOT EXISTS \$\{schema\}\.sponsor_budgets/)
  assert.match(source, /budget_base_units NUMERIC\(78,0\)/)
  assert.match(source, /DROP CONSTRAINT IF EXISTS sponsor_budgets_sponsor_reference_key/)
  assert.match(source, /idx_ttc_sponsor_budget_identity/)
  assert.match(source, /COALESCE\(token_contract, ''\)/)
  assert.match(source, /reserved_base_units \+ spent_base_units <= budget_base_units/)
  assert.match(source, /CREATE TABLE IF NOT EXISTS \$\{schema\}\.sponsor_transfers/)
  assert.match(source, /idempotency_key TEXT NOT NULL UNIQUE/)
  assert.match(source, /purpose TEXT NOT NULL CHECK \(purpose IN \('network-fee','asset-grant'\)\)/)
  assert.match(source, /status IN \('pending-review','authorized','submitted','confirmed','failed','cancelled'\)/)
  assert.match(source, /no wallet secrets are stored/i)
})


test('sponsor address migration runs only after sponsor transfer table exists', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../server/database.mjs', import.meta.url), 'utf8')
  const createIndex = source.indexOf('CREATE TABLE IF NOT EXISTS ${schema}.sponsor_transfers')
  const addColumn = source.indexOf('ALTER TABLE ${schema}.sponsor_transfers ADD COLUMN IF NOT EXISTS sponsor_address')
  assert.ok(createIndex >= 0 && addColumn > createIndex)
  assert.match(source, /ALTER TABLE \$\{schema\}\.sponsor_budgets ADD COLUMN IF NOT EXISTS sponsor_address TEXT/)
})

test('sponsor reservations use row locks, atomic exact-unit updates, idempotency, and audit events', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../server/database.mjs', import.meta.url), 'utf8')
  const reserveStart = source.indexOf('export async function reserveSponsorTransfer')
  const transitionStart = source.indexOf('export async function transitionSponsorTransfer')
  assert.ok(reserveStart >= 0 && transitionStart > reserveStart)
  const reserve = source.slice(reserveStart, transitionStart)
  assert.match(reserve, /BEGIN/)
  assert.match(reserve, /sponsor_transfers WHERE idempotency_key = \$1 FOR UPDATE/)
  assert.match(reserve, /sponsor_budgets[\s\S]*FOR UPDATE/)
  assert.match(reserve, /reserved_base_units = reserved_base_units \+ \$1::numeric/)
  assert.match(reserve, /idempotency_key TEXT|idempotency_key/)
  assert.match(reserve, /sponsor-transfer-reserved/)
  assert.match(reserve, /COMMIT/)
  assert.match(reserve, /ROLLBACK/)
  assert.match(source, /idx_ttc_sponsor_transfer_tx_identity/)
  assert.match(source, /WHERE transaction_hash IS NOT NULL/)
})

test('concurrent sponsor idempotency-key races re-read and compare the complete intent', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../server/database.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('export async function reserveSponsorTransfer')
  const end = source.indexOf('export async function transitionSponsorTransfer', start)
  assert.ok(start >= 0 && end > start)
  const reserve = source.slice(start, end)
  assert.match(reserve, /error\?\.code === '23505'/)
  assert.match(reserve, /Re-read after rollback/)
  assert.match(reserve, /FROM \$\{schema\}\.sponsor_transfers WHERE idempotency_key = \$1/)
  assert.match(reserve, /row\.sponsor_reference === sponsorReference\.trim\(\)/)
  assert.match(reserve, /row\.network === network && row\.purpose === purpose && row\.asset === asset/)
  assert.match(reserve, /row\.receiver_address === receiverAddress\.trim\(\)/)
  assert.match(reserve, /row\.amount_base_units === amountBaseUnits/)
  assert.match(reserve, /reserved: true, duplicate: true, status: row\.status/)
  assert.match(reserve, /reason: 'idempotency-key-conflict'/)
  assert.match(reserve, /reason: 'reservation-conflict'/)
})

test('sponsor confirmation requires persisted matching finalized chain evidence and reconciles reserved budget', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../server/database.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('export async function transitionSponsorTransfer')
  assert.ok(start >= 0)
  const transition = source.slice(start)
  assert.match(transition, /finalized-transaction-hash-required/)
  assert.match(transition, /submitted-transaction-hash-required/)
  assert.match(transition, /transaction-hash-conflict/)
  assert.match(transition, /submitted: \['confirmed'\]/)
  assert.match(transition, /native_transfer_verifications/)
  assert.match(transition, /verification_status = 'verified-on-chain'/)
  assert.match(transition, /finalized-transfer-evidence-not-found/)
  assert.match(transition, /reserved_base_units = reserved_base_units - \$1::numeric/)
  assert.match(transition, /spent_base_units = spent_base_units \+ \$1::numeric/)
  assert.match(transition, /sponsor-transfer-status-changed/)
  assert.match(source, /sponsor_address TEXT/)
  assert.match(transition, /sponsor_address/)
  assert.ok(transition.includes('lower(from_address) = lower($3)'))
  assert.ok(transition.includes('lower(from_address) = lower($4)'))
})

test('native transfer verification persists only solidified matching records before sponsor reconciliation', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../server/routes/native-tron.mjs', import.meta.url), 'utf8')
  assert.match(source, /recordNativeTransferVerification/)
  assert.match(source, /if \(verified && senderAddress && receiverAddress && actualAmountSun/)
  assert.match(source, /verificationPersistence/)
})


test('sponsor confirmation loads purpose and fails closed for network-fee until fee reconciliation exists', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../server/database.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('export async function transitionSponsorTransfer')
  assert.ok(start >= 0)
  const transition = source.slice(start)
  assert.match(transition, /network, purpose, asset, token_contract/)
  assert.match(transition, /nextStatus === 'confirmed' && transfer\.purpose === 'network-fee'/)
  assert.match(transition, /purpose-specific-fee-evidence-and-reconciliation-required/)
  assert.match(transition, /nextStatus === 'confirmed' && transfer\.purpose !== 'asset-grant'/)
  assert.match(transition, /unsupported-sponsor-transfer-purpose/)
  assert.ok(transition.indexOf("transfer.purpose === 'network-fee'") < transition.indexOf('let evidence'))
  assert.match(transition, /transfer\.purpose === 'network-fee'[\s\S]*?ROLLBACK[\s\S]*?purpose-specific-fee-evidence-and-reconciliation-required/)
})

test('submitted sponsor transfers cannot release reservations without finalized failure evidence and fee reconciliation', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../server/database.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('export async function transitionSponsorTransfer')
  assert.ok(start >= 0)
  const transition = source.slice(start)
  assert.match(transition, /transfer\.status === 'submitted' && nextStatus === 'failed'/)
  assert.match(transition, /finalized-failure-evidence-and-fee-reconciliation-required/)
  assert.match(transition, /submitted: \['confirmed'\]/)
  assert.match(transition, /if \(nextStatus === 'confirmed'\)[\s\S]*finalized-transfer-evidence-not-found/)
})


test('behavioral sponsor transition harness preserves reservations for network-fee confirmations', async () => {
  const { transitionSponsorTransferWithPool } = await import('../server/database.mjs')
  const state = makeSponsorTransitionState({ purpose: 'network-fee' })
  const pool = makeSponsorTransitionPool(state)
  const result = await transitionSponsorTransferWithPool({
    idempotencyKey: state.transfer.idempotency_key,
    nextStatus: 'confirmed',
    transactionHash: state.transfer.transaction_hash,
  }, pool, { initialize: false })

  assert.deepEqual(result, {
    updated: false,
    reason: 'purpose-specific-fee-evidence-and-reconciliation-required',
  })
  assert.equal(state.transfer.status, 'submitted')
  assert.equal(state.budget.reserved_base_units, '25')
  assert.equal(state.budget.spent_base_units, '0')
  assert.ok(state.queries.includes('ROLLBACK'))
  assert.ok(!state.queries.some((query) => query.includes('UPDATE sponsor_budgets')))
})

test('behavioral sponsor transition harness reconciles matching asset grants once only', async () => {
  const { transitionSponsorTransferWithPool } = await import('../server/database.mjs')
  const state = makeSponsorTransitionState({ purpose: 'asset-grant' })
  const pool = makeSponsorTransitionPool(state)
  const input = {
    idempotencyKey: state.transfer.idempotency_key,
    nextStatus: 'confirmed',
    transactionHash: state.transfer.transaction_hash,
  }

  const first = await transitionSponsorTransferWithPool(input, pool, { initialize: false })
  assert.deepEqual(first, { updated: true, duplicate: false, status: 'confirmed' })
  assert.equal(state.transfer.status, 'confirmed')
  assert.equal(state.budget.reserved_base_units, '0')
  assert.equal(state.budget.spent_base_units, '25')
  assert.equal(state.commits, 1)
  assert.equal(state.rollbacks, 0)

  const second = await transitionSponsorTransferWithPool(input, pool, { initialize: false })
  assert.deepEqual(second, { updated: true, duplicate: true, status: 'confirmed' })
  assert.equal(state.budget.reserved_base_units, '0')
  assert.equal(state.budget.spent_base_units, '25')
  assert.equal(state.commits, 2)
  assert.equal(state.rollbacks, 0)
})

test('behavioral sponsor transition harness rolls back asset grants without exact finalized evidence', async () => {
  const { transitionSponsorTransferWithPool } = await import('../server/database.mjs')
  const state = makeSponsorTransitionState({ purpose: 'asset-grant', evidenceMatches: false })
  const pool = makeSponsorTransitionPool(state)
  const result = await transitionSponsorTransferWithPool({
    idempotencyKey: state.transfer.idempotency_key,
    nextStatus: 'confirmed',
    transactionHash: state.transfer.transaction_hash,
  }, pool, { initialize: false })

  assert.deepEqual(result, { updated: false, reason: 'finalized-transfer-evidence-not-found' })
  assert.equal(state.transfer.status, 'submitted')
  assert.equal(state.budget.reserved_base_units, '25')
  assert.equal(state.budget.spent_base_units, '0')
  assert.equal(state.rollbacks, 1)
  assert.equal(state.commits, 0)
})

test('behavioral sponsor transition harness rejects unknown purposes before evidence or budget access', async () => {
  const { transitionSponsorTransferWithPool } = await import('../server/database.mjs')
  const state = makeSponsorTransitionState({ purpose: 'unsupported-purpose' })
  const pool = makeSponsorTransitionPool(state)
  const result = await transitionSponsorTransferWithPool({
    idempotencyKey: state.transfer.idempotency_key,
    nextStatus: 'confirmed',
    transactionHash: state.transfer.transaction_hash,
  }, pool, { initialize: false })

  assert.deepEqual(result, { updated: false, reason: 'unsupported-sponsor-transfer-purpose' })
  assert.equal(state.transfer.status, 'submitted')
  assert.equal(state.budget.reserved_base_units, '25')
  assert.equal(state.budget.spent_base_units, '0')
  assert.equal(state.rollbacks, 1)
  assert.equal(state.commits, 0)
  assert.ok(!state.queries.some((query) => query.includes('native_transfer_verifications')))
  assert.ok(!state.queries.some((query) => query.includes('UPDATE sponsor_budgets')))
})

test('behavioral sponsor transition harness rejects a conflicting transaction hash without reconciliation', async () => {
  const { transitionSponsorTransferWithPool } = await import('../server/database.mjs')
  const state = makeSponsorTransitionState({ purpose: 'asset-grant' })
  const pool = makeSponsorTransitionPool(state)
  const result = await transitionSponsorTransferWithPool({
    idempotencyKey: state.transfer.idempotency_key,
    nextStatus: 'confirmed',
    transactionHash: 'b'.repeat(64),
  }, pool, { initialize: false })

  assert.deepEqual(result, { updated: false, reason: 'transaction-hash-conflict' })
  assert.equal(state.transfer.status, 'submitted')
  assert.equal(state.budget.reserved_base_units, '25')
  assert.equal(state.budget.spent_base_units, '0')
  assert.equal(state.rollbacks, 1)
  assert.equal(state.commits, 0)
  assert.ok(!state.queries.some((query) => query.includes('native_transfer_verifications')))
  assert.ok(!state.queries.some((query) => query.includes('UPDATE sponsor_budgets')))
})

test('behavioral sponsor transition harness refuses caller-declared failure after submission', async () => {
  const { transitionSponsorTransferWithPool } = await import('../server/database.mjs')
  const state = makeSponsorTransitionState({ purpose: 'asset-grant' })
  const pool = makeSponsorTransitionPool(state)
  const result = await transitionSponsorTransferWithPool({
    idempotencyKey: state.transfer.idempotency_key,
    nextStatus: 'failed',
  }, pool, { initialize: false })

  assert.deepEqual(result, {
    updated: false,
    reason: 'finalized-failure-evidence-and-fee-reconciliation-required',
  })
  assert.equal(state.transfer.status, 'submitted')
  assert.equal(state.budget.reserved_base_units, '25')
  assert.equal(state.budget.spent_base_units, '0')
  assert.equal(state.rollbacks, 1)
  assert.equal(state.commits, 0)
  assert.ok(!state.queries.some((query) => query.includes('UPDATE sponsor_budgets')))
})

test('behavioral sponsor transition harness rolls back unexpected database errors and releases the client', async () => {
  const { transitionSponsorTransferWithPool } = await import('../server/database.mjs')
  const state = makeSponsorTransitionState({ purpose: 'asset-grant' })
  const basePool = makeSponsorTransitionPool(state)
  let released = false
  const pool = {
    async connect() {
      const client = await basePool.connect()
      const query = client.query.bind(client)
      return {
        async query(sql, values) {
          if (sql.includes('FROM trc20_token_clone.native_transfer_verifications')) {
            throw new Error('simulated evidence query failure')
          }
          return query(sql, values)
        },
        release() {
          released = true
          client.release()
        },
      }
    },
  }

  await assert.rejects(
    transitionSponsorTransferWithPool({
      idempotencyKey: state.transfer.idempotency_key,
      nextStatus: 'confirmed',
      transactionHash: state.transfer.transaction_hash,
    }, pool, { initialize: false }),
    /simulated evidence query failure/,
  )
  assert.equal(state.transfer.status, 'submitted')
  assert.equal(state.budget.reserved_base_units, '25')
  assert.equal(state.budget.spent_base_units, '0')
  assert.equal(state.rollbacks, 1)
  assert.equal(state.commits, 0)
  assert.equal(released, true)
})

// These deterministic query doubles exercise transition outcomes without connecting to any live database or chain.
function makeSponsorTransitionState({ purpose, evidenceMatches = true } = {}) {
  return {
    queries: [],
    commits: 0,
    rollbacks: 0,
    evidenceMatches,
    transfer: {
      idempotency_key: 'sponsor-test-key-0001',
      sponsor_reference: 'test-sponsor',
      sponsor_address: 'T1111111111111111111111111',
      network: 'shasta',
      purpose,
      asset: 'TRX',
      token_contract: null,
      receiver_address: 'T2222222222222222222222222',
      amount_base_units: '25',
      status: 'submitted',
      transaction_hash: 'a'.repeat(64),
    },
    budget: {
      id: 7,
      reserved_base_units: '25',
      spent_base_units: '0',
      budget_base_units: '100',
    },
  }
}

function makeSponsorTransitionPool(state) {
  return {
    async connect() {
      return {
        async query(sql, values = []) {
          const normalized = sql.replace(/\s+/g, ' ').trim()
          state.queries.push(normalized)
          if (normalized === 'BEGIN') return { rows: [] }
          if (normalized === 'COMMIT') {
            state.commits += 1
            return { rows: [] }
          }
          if (normalized === 'ROLLBACK') {
            state.rollbacks += 1
            return { rows: [] }
          }
          if (normalized.includes('FROM trc20_token_clone.sponsor_transfers WHERE idempotency_key = $1 FOR UPDATE')) {
            return { rows: [{ ...state.transfer }] }
          }
          if (normalized.includes('FROM trc20_token_clone.native_transfer_verifications')) {
            const [network, hash, sender, receiver, amount] = values
            const matches = state.evidenceMatches
              && network === state.transfer.network
              && hash === state.transfer.transaction_hash
              && sender === state.transfer.sponsor_address
              && receiver === state.transfer.receiver_address
              && amount === state.transfer.amount_base_units
            return { rows: matches ? [{ '?column?': 1 }] : [] }
          }
          if (normalized.includes('FROM trc20_token_clone.sponsor_budgets')) {
            return { rows: [{ ...state.budget }] }
          }
          if (normalized.startsWith('UPDATE trc20_token_clone.sponsor_budgets SET reserved_base_units = reserved_base_units -')) {
            const [amount] = values
            state.budget.reserved_base_units = (BigInt(state.budget.reserved_base_units) - BigInt(amount)).toString()
            if (normalized.includes('spent_base_units = spent_base_units +')) {
              state.budget.spent_base_units = (BigInt(state.budget.spent_base_units) + BigInt(amount)).toString()
            }
            return { rows: [], rowCount: 1 }
          }
          if (normalized.startsWith('UPDATE trc20_token_clone.sponsor_transfers SET status =')) {
            const [status, authorizationReference, hash] = values
            state.transfer.status = status
            if (authorizationReference) state.transfer.authorization_reference = authorizationReference
            if (hash) state.transfer.transaction_hash = hash
            return { rows: [], rowCount: 1 }
          }
          if (normalized.startsWith('INSERT INTO trc20_token_clone.audit_events')) {
            return { rows: [], rowCount: 1 }
          }
          throw new Error('Unexpected SQL in sponsor transition test harness')
        },
        release() {},
      }
    },
  }
}


test('sponsor token contract allowlists are exact and network-scoped', () => {
  const officialUsdt = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
  const vtrcShasta = 'TQ9u4P2xVtrcTestContract'
  assert.equal(isSponsorTokenContractAllowed('mainnet', 'USDT', officialUsdt), true)
  assert.equal(isSponsorTokenContractAllowed('shasta', 'USDT', officialUsdt), false)
  assert.equal(isSponsorTokenContractAllowed('mainnet', 'USDT', 'TWrongContract'), false)
  assert.equal(isSponsorTokenContractAllowed('shasta', 'VTRC', vtrcShasta), false)
  assert.equal(isSponsorTokenContractAllowed('shasta', 'VTRC', vtrcShasta, [vtrcShasta]), true)
  assert.equal(isSponsorTokenContractAllowed('mainnet', 'VTRC', vtrcShasta), false)
  assert.equal(isSponsorTokenContractAllowed('mainnet', 'VTRC', vtrcShasta, ['TAnotherContract']), false)
  assert.equal(isSponsorTokenContractAllowed('TRON', 'VTRC', vtrcShasta, [vtrcShasta]), false)
})
