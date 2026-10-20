import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTransferVerificationUpsert, normalizeVerificationNetwork, recordTransferVerification } from '../server/database.mjs'

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
