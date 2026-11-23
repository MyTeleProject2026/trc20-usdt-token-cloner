import test from 'node:test'
import assert from 'node:assert/strict'
import { createSponsorTransactionEngine } from '../sponsor-engine.mjs'

const OWNER = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const SPONSOR = 'TSPz5ULCfd4zbMUCfF337KWyia8F1F5kYR'
const PRIVATE_KEY = 'a'.repeat(64)

function createHarness(overrides = {}) {
  const calls = { factory: 0, balance: 0, sign: 0, broadcast: 0, fetch: 0 }
  const env = {
    TRON_OWNER_ADDRESS: OWNER,
    SPONSOR_MAINNET_ADDRESS: SPONSOR,
    SPONSOR_MAINNET_PRIVATE_KEY: PRIVATE_KEY,
    SPONSOR_TRANSACTION_ENGINE_ENABLED: 'false',
    SPONSOR_MAINNET_BROADCAST_ENABLED: 'false',
    SPONSOR_MAX_TX_FEE_SUN: '0',
    SPONSOR_LIQUID_RESERVE_TRX: '2',
    ...overrides,
  }
  const engine = createSponsorTransactionEngine({
    env,
    fetchImpl: async () => { calls.fetch++; throw new Error('network access is forbidden in this test') },
    tronWebFactory: () => {
      calls.factory++
      return {
        address: { fromPrivateKey: () => SPONSOR },
        trx: {
          getBalance: async () => { calls.balance++; return 100_000_000 },
          sign: async () => { calls.sign++; throw new Error('signing is forbidden in this test') },
          sendRawTransaction: async () => { calls.broadcast++; throw new Error('broadcast is forbidden in this test') },
        },
      }
    },
  })
  return { engine, calls }
}

test('Sponsor transaction engine ignores server private-key configuration and remains disabled', async () => {
  const { engine, calls } = createHarness()
  const readiness = engine.readiness()
  assert.equal(readiness.configured, false)
  assert.equal(readiness.enabled, false)
  assert.equal(readiness.broadcastAvailable, false)

  const result = await engine.execute({
    operation: 'topup',
    resource: 'TRX',
    amountSun: '1000000',
    ownerAddress: OWNER,
    onSigned: async () => { throw new Error('must not persist a signature') },
  })
  assert.deepEqual(result, {
    success: false,
    status: 'sponsor-engine-disabled-or-unconfigured',
    signed: false,
    broadcast: false,
  })
  assert.equal(calls.balance, 0)
  assert.equal(calls.sign, 0)
  assert.equal(calls.broadcast, 0)
  assert.equal(calls.fetch, 0)
})

test('Sponsor engine does not broadcast when execution is enabled but broadcast remains disabled', async () => {
  const { engine, calls } = createHarness({
    SPONSOR_TRANSACTION_ENGINE_ENABLED: 'true',
    SPONSOR_MAINNET_BROADCAST_ENABLED: 'false',
  })
  assert.equal(engine.readiness().enabled, false)
  assert.equal(engine.readiness().broadcastAvailable, false)
  const result = await engine.execute({
    operation: 'delegate',
    resource: 'ENERGY',
    amountSun: '1000000',
    ownerAddress: OWNER,
    onSigned: async () => {},
  })
  assert.equal(result.broadcast, false)
  assert.equal(result.signed, false)
  assert.equal(calls.balance, 0)
  assert.equal(calls.sign, 0)
  assert.equal(calls.broadcast, 0)
  assert.equal(calls.fetch, 0)
})

test('Sponsor engine fails closed when signer address does not match configured Sponsor address', async () => {
  const env = {
    TRON_OWNER_ADDRESS: OWNER,
    SPONSOR_MAINNET_ADDRESS: SPONSOR,
    SPONSOR_MAINNET_PRIVATE_KEY: PRIVATE_KEY,
    SPONSOR_TRANSACTION_ENGINE_ENABLED: 'true',
    SPONSOR_MAINNET_BROADCAST_ENABLED: 'true',
    SPONSOR_MAX_TX_FEE_SUN: '0',
    SPONSOR_LIQUID_RESERVE_TRX: '2',
  }
  let networkCalls = 0
  const engine = createSponsorTransactionEngine({
    env,
    fetchImpl: async () => { networkCalls++; throw new Error('unexpected network call') },
    tronWebFactory: () => ({ address: { fromPrivateKey: () => OWNER } }),
  })
  assert.equal(engine.readiness().configured, false)
  assert.equal(engine.readiness().broadcastAvailable, false)
  const result = await engine.execute({
    operation: 'topup',
    resource: 'TRX',
    amountSun: '1000000',
    ownerAddress: OWNER,
    onSigned: async () => {},
  })
  assert.equal(result.signed, false)
  assert.equal(result.broadcast, false)
  assert.equal(networkCalls, 0)
})
