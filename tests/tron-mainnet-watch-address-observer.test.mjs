import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createTronMainnetWatchAddressObserver,
  TRON_MAINNET_WATCH_ONLY_ADDRESSES,
  TRON_MAINNET_WATCH_ONLY_USDT_CONTRACT,
} from '../server/tron-mainnet-watch-address-observer.mjs'

const [firstAddress, secondAddress] = TRON_MAINNET_WATCH_ONLY_ADDRESSES
const sender = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const transactionHash = 'a'.repeat(64)

function event(to, overrides = {}) {
  return {
    transaction_id: transactionHash,
    from: sender,
    to,
    value: '25000000',
    block_timestamp: 1794000000000,
    token_info: { address: TRON_MAINNET_WATCH_ONLY_USDT_CONTRACT, decimals: 6 },
    ...overrides,
  }
}

function response(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('watch list contains exactly the two specified addresses and no inferred ownership', async () => {
  assert.deepEqual(TRON_MAINNET_WATCH_ONLY_ADDRESSES, [
    'TU3kjFuhtEo42tsCBtfYUAZxoqQ4yuSLQ5',
    'THPvaUhoh2Qn2y9THCZML3H815hhFhn5YC',
  ])
  const calls = []
  const observer = createTronMainnetWatchAddressObserver({
    env: { TRONGRID_API_KEY: 'existing-provider-key' },
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options })
      return response({ data: [] })
    },
    verifyTransfer: async () => ({ verified: false }),
    now: () => 1794000000000,
  })
  const result = await observer()
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map((call) => call.url.pathname), [
    '/v1/accounts/' + firstAddress + '/transactions/trc20',
    '/v1/accounts/' + secondAddress + '/transactions/trc20',
  ])
  for (const call of calls) {
    assert.equal(call.options.method, 'GET')
    assert.equal(call.options.redirect, 'error')
    assert.equal(call.options.headers['TRON-PRO-API-KEY'], 'existing-provider-key')
    assert.equal(call.url.searchParams.get('only_confirmed'), 'true')
    assert.equal(call.url.searchParams.get('contract_address'), TRON_MAINNET_WATCH_ONLY_USDT_CONTRACT)
  }
  assert.equal(result.network, 'mainnet')
  assert.equal(result.ownershipVerified, false)
  assert.equal(result.ledgerMutationPerformed, false)
  assert.equal(result.spendableBalanceImpact, 'none')
  assert.equal(result.payoutSubmissionEnabled, false)
  assert.ok(result.addresses.every((item) => item.ownershipStatus === 'not-verified'))
})

test('only exact incoming official six-decimal USDT events are considered and solidified proof is required', async () => {
  const requested = []
  const observer = createTronMainnetWatchAddressObserver({
    env: {},
    fetchImpl: async (url) => {
      const address = new URL(url).pathname.includes(firstAddress) ? firstAddress : secondAddress
      return response({
        data: [
          event(address),
          event(address, { to: sender }),
          event(address, { token_info: { address: sender, decimals: 6 } }),
          event(address, { token_info: { address: TRON_MAINNET_WATCH_ONLY_USDT_CONTRACT, decimals: 18 } }),
          event(address, { value: '0' }),
        ],
      })
    },
    verifyTransfer: async (_env, input) => {
      requested.push(input)
      return {
        verified: true,
        transactionHash: input.transactionHash,
        contract: TRON_MAINNET_WATCH_ONLY_USDT_CONTRACT,
        from: input.from,
        to: input.to,
        amountBaseUnits: input.amountBaseUnits,
        blockNumber: 123456,
        logIndex: 1,
      }
    },
    now: () => 1794000000000,
  })
  const result = await observer()
  assert.equal(requested.length, 2)
  assert.ok(result.addresses.every((item) => item.observations.length === 1))
  assert.ok(result.addresses.every((item) => item.observations[0].status === 'solidified-mainnet-usdt-transfer-observed'))
  assert.ok(result.addresses.every((item) => item.observations[0].spendableBalanceImpact === 'none'))
})

test('an indexer candidate is not reported as observed when solidified verification fails', async () => {
  const observer = createTronMainnetWatchAddressObserver({
    fetchImpl: async (url) => response({
      data: [event(new URL(url).pathname.includes(firstAddress) ? firstAddress : secondAddress)],
    }),
    verifyTransfer: async () => ({ verified: false, status: 'awaiting-solidified-receipt' }),
    now: () => 1794000000000,
  })
  const result = await observer()
  assert.ok(result.addresses.every((item) => item.observations[0].observedOnChain === false))
  assert.ok(result.addresses.every((item) => item.observations[0].status === 'awaiting-solidified-receipt'))
  assert.equal(result.spendableBalanceImpact, 'none')
})

test('mismatched verifier identity cannot be treated as a confirmed watch observation', async () => {
  const observer = createTronMainnetWatchAddressObserver({
    fetchImpl: async (url) => response({
      data: [event(new URL(url).pathname.includes(firstAddress) ? firstAddress : secondAddress)],
    }),
    verifyTransfer: async () => ({
      verified: true,
      transactionHash: 'b'.repeat(64),
      contract: TRON_MAINNET_WATCH_ONLY_USDT_CONTRACT,
      from: sender,
      to: firstAddress,
      amountBaseUnits: '25000000',
      blockNumber: 123456,
      logIndex: 0,
    }),
    now: () => 1794000000000,
  })
  const result = await observer()
  assert.ok(result.addresses.every((item) => item.observations[0].status === 'not-verified'))
  assert.ok(result.addresses.every((item) => item.observations[0].observedOnChain === false))
})

test('provider failure for one watched address is isolated and never creates accounting state', async () => {
  const observer = createTronMainnetWatchAddressObserver({
    fetchImpl: async (url) => {
      if (new URL(url).pathname.includes(firstAddress)) throw new Error('network down')
      return response({ data: [event(secondAddress)] })
    },
    verifyTransfer: async (_env, input) => ({
      verified: true,
      transactionHash: input.transactionHash,
      contract: TRON_MAINNET_WATCH_ONLY_USDT_CONTRACT,
      from: input.from,
      to: input.to,
      amountBaseUnits: input.amountBaseUnits,
      blockNumber: 123456,
      logIndex: 0,
    }),
    now: () => 1794000000000,
  })
  const result = await observer()
  assert.equal(result.addresses[0].status, 'history-unavailable')
  assert.equal(result.addresses[0].observations.length, 0)
  assert.equal(result.addresses[1].observations[0].observedOnChain, true)
  assert.equal(result.spendableBalanceImpact, 'none')
})

test('oversized watch-history responses are rejected before full buffering', async () => {
  let cancelled = false
  const oversized = new Uint8Array(256 * 1024 + 1).fill(0x20)
  const fetchImpl = async () => ({
    ok: true,
    headers: { get: () => null },
    body: new ReadableStream({
      start(controller) { controller.enqueue(oversized) },
      cancel() { cancelled = true },
    }),
  })
  const observer = createTronMainnetWatchAddressObserver({
    fetchImpl,
    verifyTransfer: async () => ({ verified: false }),
  })
  const result = await observer()
  assert.equal(result.addresses[0].status, 'history-unavailable')
  assert.equal(cancelled, true)
})

test('watch observer rejects missing verifier dependencies', () => {
  assert.throws(() => createTronMainnetWatchAddressObserver({ fetchImpl: async () => response({ data: [] }) }), /dependencies-invalid/)
})
