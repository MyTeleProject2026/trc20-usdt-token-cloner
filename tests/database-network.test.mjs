import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTransferVerificationUpsert, findVerifiedTransfer, normalizeVerificationNetwork, recordTransferVerification } from '../server/database.mjs'

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
