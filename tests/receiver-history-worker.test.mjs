import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { makeReceiverEventKey, normalizeIndexedEvent, runReceiverHistorySweep } from '../server/receiver-history-worker.mjs'

const worker = await readFile(new URL('../server/receiver-history-worker.mjs', import.meta.url), 'utf8')
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

test('receiver worker is opt-in and does not connect to a database while disabled', async () => {
  const result = await runReceiverHistorySweep({
    env: { RECEIVER_HISTORY_WORKER_ENABLED: 'false' },
    fetchImpl: async () => { throw new Error('fetch must not be called') },
  })
  assert.deepEqual(result, { enabled: false, scannedWallets: 0, insertedCandidates: 0, failedWallets: 0 })
})

test('receiver event identity is deterministic and distinguishes different transfer events', () => {
  const event = {
    transactionId: 'a'.repeat(64),
    tokenContract: 'TContractAddress',
    senderAddress: 'TSenderAddress',
    receiverAddress: 'TReceiverAddress',
    amountBaseUnits: '1000000',
    timestamp: 123456789,
    eventIndex: '4',
  }
  assert.equal(makeReceiverEventKey(event), makeReceiverEventKey({ ...event }))
  assert.notEqual(makeReceiverEventKey(event), makeReceiverEventKey({ ...event, eventIndex: '5' }))
  assert.notEqual(makeReceiverEventKey(event), makeReceiverEventKey({ ...event, amountBaseUnits: '2000000' }))
})

test('worker is bounded, network-scoped, idempotent, and stores candidates without crediting balances', () => {
  assert.match(worker, /MAX_WALLETS_PER_RUN = 100/)
  assert.match(worker, /MAX_PAGES_PER_WALLET = 5/)
  assert.match(worker, /PAGE_SIZE = 50/)
  assert.match(worker, /NETWORK_HOSTS/)
  assert.ok(worker.includes("ON CONFLICT (network,wallet_address,event_key) DO NOTHING"))
  assert.ok(worker.includes("result.rowCount > 0"))
  assert.ok(!worker.includes("RETURNING (xmax = 0)"))
  assert.match(worker, /indexed-candidate-awaiting-solidified-verification/)
  assert.match(worker, /verified_on_chain BOOLEAN NOT NULL DEFAULT FALSE/)
  assert.match(worker, /MAX_VERIFICATIONS_PER_RUN = 25/)
  assert.match(worker, /TRON_VERIFIED_TOKEN_CONTRACTS/)
  assert.match(worker, /verifySolidifiedTrc20Transfer/)
  assert.match(worker, /recordTransferVerification/)
  assert.match(worker, /status: 'verified-on-chain'/)
  assert.match(worker, /RECEIVER_HISTORY_WORKER_ENABLED !== 'true'/)
  assert.match(packageJson.scripts['worker:receiver-history'], /server\/receiver-history-worker\.mjs/)
  assert.doesNotMatch(worker, /privateKey|broadcasttransaction|sendRawTransaction|wallet\/broadcasttransaction/i)
  assert.doesNotMatch(worker, /UPDATE .*wallet_balances|INSERT INTO .*wallet_balances/i)
})

test('worker normalizes only well-formed incoming token events', () => {
  const address = (char) => 'T' + char.repeat(33)
  const item = {
    transaction_id: 'a'.repeat(64),
    from: address('A'),
    to: address('B'),
    value: '1000000',
    block_timestamp: 1760000000000,
    event_index: 2,
    token_info: { address: address('C'), name: 'Test Token', symbol: 'TST', decimals: 6 },
  }
  const normalized = normalizeIndexedEvent(item, 'shasta', address('B'))
  assert.equal(normalized.network, 'shasta')
  assert.equal(normalized.amountBaseUnits, '1000000')
  assert.equal(normalized.tokenDecimals, 6)
  assert.equal(normalized.eventIndex, '2')
  assert.equal(normalized.eventKey.length, 64)
  assert.equal(normalizeIndexedEvent({ ...item, value: '-1' }, 'shasta', address('B')), null)
  assert.equal(normalizeIndexedEvent({ ...item, transaction_id: 'not-a-hash' }, 'shasta', address('B')), null)
})
