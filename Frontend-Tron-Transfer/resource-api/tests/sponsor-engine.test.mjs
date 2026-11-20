import test from 'node:test'
import assert from 'node:assert/strict'
import { TronWeb } from 'tronweb'
import { createSponsorTransactionEngine } from '../sponsor-engine.mjs'

const SPONSOR = 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL'
const OWNER = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const PRIVATE_KEY = '1'.repeat(64)
const TXID = 'a'.repeat(64)
const tronWeb = new TronWeb({ fullHost: 'https://api.trongrid.io' })
const sponsorHex = tronWeb.address.toHex(SPONSOR)
const ownerHex = tronWeb.address.toHex(OWNER)

function configuredEnv(overrides = {}) {
  return {
    SPONSOR_MAINNET_PRIVATE_KEY: PRIVATE_KEY,
    SPONSOR_MAINNET_ADDRESS: SPONSOR,
    TRON_OWNER_ADDRESS: OWNER,
    SPONSOR_TRANSACTION_ENGINE_ENABLED: 'true',
    SPONSOR_MAINNET_BROADCAST_ENABLED: 'true',
    SPONSOR_LIQUID_RESERVE_TRX: '2',
    SPONSOR_MAX_TX_FEE_SUN: '0',
    ...overrides,
  }
}
function fixture({ bandwidth = 600, balance = 10_000_000n, onBroadcast, envOverrides = {} } = {}) {
  let signedCount = 0
  let broadcastCount = 0
  let durableTxId = false
  const transaction = {
    txID: TXID,
    raw_data_hex: '01'.repeat(10),
    raw_data: {
      expiration: Date.now() + 60_000,
      contract: [{ type: 'FreezeBalanceV2Contract', parameter: { value: { owner_address: sponsorHex, resource: 1, frozen_balance: '1000000' } } }],
    },
  }
  const fakeTronWeb = {
    address: { fromPrivateKey: () => SPONSOR, fromHex: () => SPONSOR },
    transactionBuilder: { freezeBalanceV2: async () => transaction },
    trx: {
      getBalance: async () => balance,
      getAccountResources: async () => ({ freeNetLimit: bandwidth, freeNetUsed: 0, NetLimit: 0, NetUsed: 0 }),
      getChainParameters: async () => [{ key: 'getTransactionFee', value: 1000 }],
      sign: async tx => { signedCount += 1; return { ...tx, signature: ['signature'] } },
      sendRawTransaction: async () => { broadcastCount += 1; onBroadcast?.(durableTxId); return { result: true, txid: TXID } },
    },
  }
  const fetchImpl = async url => ({
    ok: true,
    json: async () => url.endsWith('gettransactioninfobyid')
      ? { id: TXID, blockNumber: 123, receipt: { result: 'SUCCESS' } }
      : { txID: TXID, raw_data: { contract: [{ type: 'FreezeBalanceV2Contract', parameter: { value: { owner_address: sponsorHex, resource: 1, frozen_balance: '1000000' } } }] } },
  })
  const engine = createSponsorTransactionEngine({
    env: configuredEnv(envOverrides),
    tronWebFactory: () => fakeTronWeb,
    fetchImpl,
  })
  return {
    engine, transaction,
    counts: () => ({ signedCount, broadcastCount }),
    markDurable: () => { durableTxId = true },
  }
}

test('engine defaults to disabled and never signs without explicit server flags', async () => {
  const engine = createSponsorTransactionEngine({ env: {} })
  const state = engine.readiness()
  assert.equal(state.broadcastAvailable, false)
  const result = await engine.execute({ operation: 'stake', resource: 'ENERGY', amountSun: '1000000', ownerAddress: OWNER })
  assert.equal(result.broadcast, false)
  assert.equal(result.signed, false)
  assert.equal(result.status, 'sponsor-engine-disabled-or-unconfigured')
})

test('engine persists the transaction ID before broadcasting and verifies a solidified Stake 2.0 transaction', async () => {
  const f = fixture({ onBroadcast: persisted => assert.equal(persisted, true, 'transaction ID must be durable before broadcast') })
  const result = await f.engine.execute({
    operation: 'stake', resource: 'ENERGY', amountSun: '1000000', ownerAddress: OWNER,
    onSigned: async txid => { assert.equal(txid, TXID); f.markDurable() },
  })
  assert.equal(result.success, true)
  assert.equal(result.solidified, true)
  assert.equal(result.blockNumber, 123)
  assert.equal(f.counts().signedCount, 1)
  assert.equal(f.counts().broadcastCount, 1)
})

test('zero-fee policy blocks transactions whose own Bandwidth pool cannot cover the full transaction', async () => {
  const f = fixture({ bandwidth: 0, envOverrides: { SPONSOR_MAX_TX_FEE_SUN: undefined } })
  const result = await f.engine.execute({
    operation: 'stake', resource: 'ENERGY', amountSun: '1000000', ownerAddress: OWNER,
    onSigned: async () => assert.fail('must not sign a transaction with an unauthorized fee shortfall'),
  })
  assert.equal(result.status, 'bandwidth-shortfall-exceeds-authorized-fee-cap')
  assert.equal(f.counts().signedCount, 0)
  assert.equal(f.counts().broadcastCount, 0)
})

test('Stake 2.0 checks the protected liquid reserve before signing', async () => {
  const f = fixture({ balance: 2_000_000n })
  const result = await f.engine.execute({
    operation: 'stake', resource: 'ENERGY', amountSun: '1000000', ownerAddress: OWNER,
    onSigned: async () => assert.fail('must not sign when the protected reserve would be consumed'),
  })
  assert.equal(result.status, 'insufficient-balance-after-reserve')
  assert.equal(f.counts().signedCount, 0)
  assert.equal(f.counts().broadcastCount, 0)
})

test('transaction ID persistence callback is mandatory before any broadcast', async () => {
  const f = fixture()
  const result = await f.engine.execute({ operation: 'stake', resource: 'ENERGY', amountSun: '1000000', ownerAddress: OWNER })
  assert.equal(result.broadcast, false)
  assert.equal(f.counts().broadcastCount, 0)
})
