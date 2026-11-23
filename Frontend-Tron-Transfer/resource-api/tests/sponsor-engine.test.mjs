import test from 'node:test'
import assert from 'node:assert/strict'
import { TronWeb } from 'tronweb'
import { createHash } from 'node:crypto'
import { createSponsorTransactionEngine, verifySponsorSignedTransaction } from '../sponsor-engine.mjs'

const SPONSOR = 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL'
const OWNER = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const TXID = 'a'.repeat(64)
const tronWeb = new TronWeb({ fullHost: 'https://api.trongrid.io' })
const sponsorHex = tronWeb.address.toHex(SPONSOR)
const ownerHex = tronWeb.address.toHex(OWNER)

function configuredEnv(overrides = {}) {
  return {
    SPONSOR_MAINNET_ADDRESS: SPONSOR,
    TRON_OWNER_ADDRESS: OWNER,
    SPONSOR_TRANSACTION_ENGINE_ENABLED: 'true',
    SPONSOR_MAINNET_BROADCAST_ENABLED: 'true',
    SPONSOR_LIQUID_RESERVE_TRX: '2',
    SPONSOR_MAX_TX_FEE_SUN: '0',
    SPONSOR_STAKING_ENABLED: 'true',
    SPONSOR_MAX_AUTOMATIC_STAKE_TRX: '10',
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
    tronWebFactory: privateKey => { assert.equal(privateKey, null); return fakeTronWeb },
    signerAdapter: { address: SPONSOR, signTransaction: async tx => fakeTronWeb.trx.sign(tx) },
    fetchImpl,
  })
  return {
    engine, transaction,
    counts: () => ({ signedCount, broadcastCount }),
    markDurable: () => { durableTxId = true },
  }
}

test('legacy SPONSOR_MAINNET_PRIVATE_KEY environment values are ignored', async () => {
  const engine = createSponsorTransactionEngine({
    env: configuredEnv({ SPONSOR_MAINNET_PRIVATE_KEY: '1'.repeat(64) }),
  })
  const state = engine.readiness()
  assert.equal(state.signerMode, 'client-local-required')
  assert.equal(state.signerConfigured, false)
  assert.equal(state.broadcastAvailable, false)
  const result = await engine.execute({ operation: 'stake', resource: 'ENERGY', amountSun: '1000000', ownerAddress: OWNER })
  assert.equal(result.signed, false)
  assert.equal(result.broadcast, false)
  assert.equal(result.status, 'sponsor-engine-disabled-or-unconfigured')
})

test('engine requires an explicit signer adapter and never loads a server-side Sponsor private key', async () => {
  const engine = createSponsorTransactionEngine({ env: {} })
  const state = engine.readiness()
  assert.equal(state.broadcastAvailable, false)
  assert.equal(state.signerMode, 'client-local-required')
  assert.equal(state.signerConfigured, false)
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


test('configured stake cap blocks an amount above SPONSOR_MAX_AUTOMATIC_STAKE_TRX', async () => {
  const f = fixture()
  const result = await f.engine.execute({
    operation: 'stake', resource: 'ENERGY', amountSun: '11000000', ownerAddress: OWNER,
    onSigned: async () => assert.fail('stake above configured cap must not be signed'),
  })
  assert.equal(result.status, 'staking-disabled-or-amount-exceeds-configured-cap')
  assert.equal(f.counts().signedCount, 0)
  assert.equal(f.counts().broadcastCount, 0)
})

test('SPONSOR_STAKING_ENABLED=false blocks Stake 2.0 even when broadcast flags are true', async () => {
  const f = fixture({ envOverrides: { SPONSOR_STAKING_ENABLED: 'false' } })
  const result = await f.engine.execute({
    operation: 'stake', resource: 'ENERGY', amountSun: '1000000', ownerAddress: OWNER,
    onSigned: async () => assert.fail('disabled staking must not be signed'),
  })
  assert.equal(result.status, 'staking-disabled-or-amount-exceeds-configured-cap')
  assert.equal(f.counts().signedCount, 0)
})

test('Sponsor TRX top-up signs only a bounded transfer to the configured Owner and verifies solidified Mainnet state', async () => {
  const transfer = {
    txID: TXID,
    raw_data_hex: '02'.repeat(10),
    raw_data: {
      expiration: Date.now() + 60_000,
      contract: [{ type: 'TransferContract', parameter: { value: { owner_address: sponsorHex, to_address: ownerHex, amount: '1000000' } } }],
    },
  }
  let persisted = false
  let broadcasts = 0
  const fakeTronWeb = {
    address: { fromPrivateKey: () => SPONSOR, fromHex: value => value === ownerHex ? OWNER : SPONSOR },
    transactionBuilder: { sendTrx: async (to, amount, from) => {
      assert.equal(to, OWNER); assert.equal(amount, '1000000'); assert.equal(from, SPONSOR); return transfer
    } },
    trx: {
      getBalance: async () => 10_000_000n,
      getAccountResources: async () => ({ freeNetLimit: 600, freeNetUsed: 0, NetLimit: 0, NetUsed: 0 }),
      getChainParameters: async () => [{ key: 'getTransactionFee', value: 1000 }],
      sign: async tx => ({ ...tx, signature: ['signature'] }),
      sendRawTransaction: async () => { assert.equal(persisted, true); broadcasts++; return { result: true } },
    },
  }
  const fetchImpl = async url => ({
    ok: true,
    json: async () => url.endsWith('gettransactioninfobyid')
      ? { id: TXID, blockNumber: 789, receipt: { result: 'SUCCESS' } }
      : transfer,
  })
  const engine = createSponsorTransactionEngine({
    env: configuredEnv(),
    tronWebFactory: () => fakeTronWeb,
    fetchImpl,
  })
  const result = await engine.execute({
    operation: 'topup', resource: 'TRX', amountSun: '1000000', ownerAddress: OWNER,
    onSigned: async txid => { assert.equal(txid, TXID); persisted = true },
  })
  assert.equal(result.success, true)
  assert.equal(result.solidified, true)
  assert.equal(result.blockNumber, 789)
  assert.equal(broadcasts, 1)
})

test('Sponsor TRX top-up fails closed above the configured Owner funding cap', async () => {
  const f = fixture({ envOverrides: { SPONSOR_MAX_OWNER_TOPUP_TRX: '0.5' } })
  const result = await f.engine.execute({ operation: 'topup', resource: 'TRX', amountSun: '600000', ownerAddress: OWNER })
  assert.equal(result.status, 'owner-topup-disabled-or-amount-exceeds-configured-cap')
  assert.equal(result.signed, false)
  assert.equal(result.broadcast, false)
  assert.deepEqual(f.counts(), { signedCount: 0, broadcastCount: 0 })
})


function lifecycleFixture({ operation, amountSun, resource = 'ENERGY', transactionValue, account = {}, delegatedRows = [], withdrawable = '0', includeWithdrawAmount = true, builderName }) {
  let signed = 0
  let broadcast = 0
  let persisted = false
  const type = {
    undelegate: 'UnDelegateResourceContract',
    unstake: 'UnfreezeBalanceV2Contract',
    withdraw: 'WithdrawExpireUnfreezeContract',
  }[operation]
  const transaction = {
    txID: TXID,
    raw_data_hex: '03'.repeat(12),
    raw_data: {
      expiration: Date.now() + 60_000,
      contract: [{ type, parameter: { value: transactionValue } }],
    },
  }
  const fakeTronWeb = {
    address: {
      fromPrivateKey: () => SPONSOR,
      fromHex: value => value === ownerHex ? OWNER : SPONSOR,
    },
    transactionBuilder: {
      [builderName]: async (...args) => {
        if (operation === 'undelegate') assert.deepEqual(args.slice(0, 4), [amountSun, OWNER, resource, SPONSOR])
        if (operation === 'unstake') assert.deepEqual(args.slice(0, 3), [amountSun, resource, SPONSOR])
        if (operation === 'withdraw') assert.deepEqual(args.slice(0, 1), [SPONSOR])
        return transaction
      },
    },
    trx: {
      getBalance: async () => 10_000_000n,
      getAccountResources: async () => ({ freeNetLimit: 600, freeNetUsed: 0, NetLimit: 0, NetUsed: 0 }),
      getChainParameters: async () => [{ key: 'getTransactionFee', value: 1000 }],
      getDelegatedResourceV2: async () => delegatedRows,
      getAccount: async () => account,
      getAvailableUnfreezeCount: async () => ({ count: 32 }),
      getCanWithdrawUnfreezeAmount: async () => ({ amount: withdrawable }),
      sign: async tx => { signed += 1; return { ...tx, signature: ['signature'] } },
      sendRawTransaction: async () => { assert.equal(persisted, true); broadcast += 1; return { result: true } },
    },
  }
  const fetchImpl = async url => ({
    ok: true,
    json: async () => url.endsWith('gettransactioninfobyid')
      ? { id: TXID, blockNumber: 456, receipt: { result: 'SUCCESS' }, ...(operation === 'withdraw' && includeWithdrawAmount ? { withdraw_expire_amount: amountSun } : {}) }
      : { txID: TXID, raw_data: transaction.raw_data },
  })
  const engine = createSponsorTransactionEngine({ env: configuredEnv(), tronWebFactory: () => fakeTronWeb, fetchImpl })
  return {
    engine,
    counts: () => ({ signed, broadcast }),
    execute: () => engine.execute({
      operation, resource: operation === 'withdraw' ? 'TRX' : resource, amountSun, ownerAddress: OWNER,
      onSigned: async txid => { assert.equal(txid, TXID); persisted = true },
    }),
  }
}

test('undelegate reclaims only the requested confirmed Owner delegation', async () => {
  const amountSun = '1000000'
  const f = lifecycleFixture({
    operation: 'undelegate', amountSun, resource: 'ENERGY', builderName: 'undelegateResource',
    transactionValue: { owner_address: sponsorHex, receiver_address: ownerHex, resource: 1, balance: amountSun },
    delegatedRows: [{ frozen_balance_for_energy: '2000000' }],
  })
  const result = await f.execute()
  assert.equal(result.success, true)
  assert.equal(result.solidified, true)
  assert.equal(result.blockNumber, 456)
  assert.deepEqual(f.counts(), { signed: 1, broadcast: 1 })
})

test('unstake rejects amounts still delegated to the Owner before signing', async () => {
  const amountSun = '4000000'
  const f = lifecycleFixture({
    operation: 'unstake', amountSun, resource: 'ENERGY', builderName: 'unfreezeBalanceV2',
    transactionValue: { owner_address: sponsorHex, resource: 1, unfreeze_balance: amountSun },
    account: { frozenV2: [{ type: 'ENERGY', amount: '5000000' }] },
    delegatedRows: [{ frozen_balance_for_energy: '2000000' }],
  })
  const result = await f.execute()
  assert.equal(result.status, 'unstake-exceeds-unlocked-self-stake')
  assert.deepEqual(f.counts(), { signed: 0, broadcast: 0 })
})

test('unstake initiates the Stake 2.0 delay only for un-delegated self-stake', async () => {
  const amountSun = '3000000'
  const f = lifecycleFixture({
    operation: 'unstake', amountSun, resource: 'ENERGY', builderName: 'unfreezeBalanceV2',
    transactionValue: { owner_address: sponsorHex, resource: 1, unfreeze_balance: amountSun },
    account: { frozenV2: [{ type: 'ENERGY', amount: '5000000' }] },
    delegatedRows: [{ frozen_balance_for_energy: '2000000' }],
  })
  const result = await f.execute()
  assert.equal(result.success, true)
  assert.equal(result.solidified, true)
  assert.deepEqual(f.counts(), { signed: 1, broadcast: 1 })
})

test('withdraw requires the exact currently withdrawable matured unfreeze amount', async () => {
  const amountSun = '2000000'
  const f = lifecycleFixture({
    operation: 'withdraw', amountSun, builderName: 'withdrawExpireUnfreeze',
    transactionValue: { owner_address: sponsorHex }, withdrawable: amountSun,
  })
  const result = await f.execute()
  assert.equal(result.success, true)
  assert.equal(result.solidified, true)
  assert.deepEqual(f.counts(), { signed: 1, broadcast: 1 })
})


test('withdraw is not marked confirmed when the solidified receipt omits the actual withdrawal amount', async () => {
  const amountSun = '2000000'
  const f = lifecycleFixture({
    operation: 'withdraw', amountSun, builderName: 'withdrawExpireUnfreeze',
    transactionValue: { owner_address: sponsorHex }, withdrawable: amountSun,
    includeWithdrawAmount: false,
  })
  const result = await f.execute()
  assert.equal(result.success, false)
  assert.equal(result.solidified, false)
  assert.equal(result.status, 'solidified-withdraw-amount-unavailable')
  assert.deepEqual(f.counts(), { signed: 1, broadcast: 1 })
})

test('withdraw blocks when the matured amount changed after the user reviewed it', async () => {
  const f = lifecycleFixture({
    operation: 'withdraw', amountSun: '2000000', builderName: 'withdrawExpireUnfreeze',
    transactionValue: { owner_address: sponsorHex }, withdrawable: '3000000',
  })
  const result = await f.execute()
  assert.equal(result.status, 'withdraw-amount-changed-refresh-and-retry')
  assert.deepEqual(f.counts(), { signed: 0, broadcast: 0 })
})


test('external Sponsor signer adapter signs only the immutable prevalidated transaction body', async () => {
  const transaction = {
    txID: TXID,
    raw_data_hex: 'ab'.repeat(16),
    raw_data: {
      expiration: Date.now() + 60_000,
      contract: [{ type: 'FreezeBalanceV2Contract', parameter: { value: { owner_address: sponsorHex, resource: 1, frozen_balance: '1000000' } } }],
    },
  }
  let adapterCalls = 0
  let broadcastCalls = 0
  let persisted = false
  const adapter = {
    address: SPONSOR,
    async signTransaction(unsignedTransaction) {
      adapterCalls += 1
      assert.deepEqual(unsignedTransaction, transaction)
      return { ...unsignedTransaction, signature: ['hsm-signature'] }
    },
  }
  const fakeTronWeb = {
    address: { fromHex: () => SPONSOR },
    transactionBuilder: { freezeBalanceV2: async () => structuredClone(transaction) },
    trx: {
      getBalance: async () => 10_000_000n,
      getAccountResources: async () => ({ freeNetLimit: 600, freeNetUsed: 0, NetLimit: 0, NetUsed: 0 }),
      getChainParameters: async () => [{ key: 'getTransactionFee', value: 1000 }],
      sendRawTransaction: async signed => {
        broadcastCalls += 1
        assert.equal(persisted, true)
        assert.equal(signed.signature[0], 'hsm-signature')
        return { result: true, txid: TXID }
      },
    },
  }
  const engine = createSponsorTransactionEngine({
    env: configuredEnv({ SPONSOR_MAINNET_PRIVATE_KEY: undefined }),
    signerAdapter: adapter,
    tronWebFactory: privateKey => {
      assert.equal(privateKey, null, 'external adapter mode must not load an env private key')
      return fakeTronWeb
    },
    fetchImpl: async url => ({
      ok: true,
      json: async () => url.endsWith('gettransactioninfobyid')
        ? { id: TXID, blockNumber: 321, receipt: { result: 'SUCCESS' } }
        : { txID: TXID, raw_data: transaction.raw_data },
    }),
  })
  assert.equal(engine.readiness().signerMode, 'external-adapter')
  assert.equal(engine.readiness().configured, true)
  const result = await engine.execute({
    operation: 'stake', resource: 'ENERGY', amountSun: '1000000', ownerAddress: OWNER,
    onSigned: async txid => { assert.equal(txid, TXID); persisted = true },
  })
  assert.equal(result.success, true)
  assert.equal(adapterCalls, 1)
  assert.equal(broadcastCalls, 1)
})

test('external Sponsor signer address mismatch fails closed before signing or broadcast', async () => {
  let signCalls = 0
  let broadcastCalls = 0
  const engine = createSponsorTransactionEngine({
    env: configuredEnv({ SPONSOR_MAINNET_PRIVATE_KEY: undefined }),
    signerAdapter: { address: OWNER, signTransaction: async () => { signCalls += 1; throw new Error('must not sign') } },
    tronWebFactory: () => ({
      address: { fromHex: () => SPONSOR },
      trx: { sendRawTransaction: async () => { broadcastCalls += 1 } },
    }),
  })
  assert.equal(engine.readiness().configured, false)
  assert.equal(engine.readiness().broadcastAvailable, false)
  const result = await engine.execute({ operation: 'stake', resource: 'ENERGY', amountSun: '1000000', ownerAddress: OWNER })
  assert.equal(result.signed, false)
  assert.equal(result.broadcast, false)
  assert.equal(signCalls, 0)
  assert.equal(broadcastCalls, 0)
})

test('external Sponsor signer cannot mutate transaction bytes or intent before broadcast', async () => {
  const transaction = {
    txID: TXID,
    raw_data_hex: 'cd'.repeat(16),
    raw_data: {
      expiration: Date.now() + 60_000,
      contract: [{ type: 'FreezeBalanceV2Contract', parameter: { value: { owner_address: sponsorHex, resource: 1, frozen_balance: '1000000' } } }],
    },
  }
  let broadcastCalls = 0
  let persistenceCalls = 0
  const engine = createSponsorTransactionEngine({
    env: configuredEnv({ SPONSOR_MAINNET_PRIVATE_KEY: undefined }),
    signerAdapter: {
      address: SPONSOR,
      signTransaction: async unsigned => ({
        ...unsigned,
        raw_data_hex: 'ef'.repeat(16),
        signature: ['tampered-signature'],
      }),
    },
    tronWebFactory: () => ({
      address: { fromHex: () => SPONSOR },
      transactionBuilder: { freezeBalanceV2: async () => structuredClone(transaction) },
      trx: {
        getBalance: async () => 10_000_000n,
        getAccountResources: async () => ({ freeNetLimit: 600, freeNetUsed: 0, NetLimit: 0, NetUsed: 0 }),
        getChainParameters: async () => [{ key: 'getTransactionFee', value: 1000 }],
        sendRawTransaction: async () => { broadcastCalls += 1; return { result: true } },
      },
    }),
  })
  const result = await engine.execute({
    operation: 'stake', resource: 'ENERGY', amountSun: '1000000', ownerAddress: OWNER,
    onSigned: async () => { persistenceCalls += 1 },
  })
  assert.equal(result.status, 'signed-transaction-integrity-failed')
  assert.equal(result.signed, false)
  assert.equal(result.broadcast, false)
  assert.equal(persistenceCalls, 0)
  assert.equal(broadcastCalls, 0)
})

test('backend accepts only an exact locally signed Sponsor transaction with matching TRON permission', async () => {
  const transaction = {
    txID: TXID,
    raw_data_hex: '01'.repeat(20),
    raw_data: {
      expiration: Date.now() + 60_000,
      contract: [{ type: 'FreezeBalanceV2Contract', parameter: { value: { owner_address: sponsorHex, resource: 1, frozen_balance: '1000000' } } }],
    },
  }
  const transactionId = createHash('sha256').update(Buffer.from(transaction.raw_data_hex, 'hex')).digest('hex')
  transaction.txID = transactionId
  const unsignedTransaction = { ...transaction, signature: [] }
  const signedTransaction = { ...transaction, signature: ['b'.repeat(130)] }
  const fakeTronWeb = {
    address: { fromHex: value => value === sponsorHex ? SPONSOR : value === ownerHex ? OWNER : '', },
    isAddress: value => value === SPONSOR || value === OWNER,
    utils: {
      transaction: { txCheck: () => true },
      crypto: { ecRecover: () => sponsorHex },
    },
    trx: {
      getSignWeight: async () => ({
        result: {}, current_weight: 1,
        permission: { id: 0, threshold: 1, keys: [{ address: SPONSOR, weight: 1 }] },
        approved_list: [SPONSOR],
      }),
    },
  }
  const result = await verifySponsorSignedTransaction({
    tronWeb: fakeTronWeb, unsignedTransaction, signedTransaction,
    operation: 'stake', resource: 'ENERGY', amountSun: '1000000',
    sponsorAddress: SPONSOR, ownerAddress: OWNER,
  })
  assert.deepEqual(result, { verified: true, sponsorAddress: SPONSOR, ownerAddress: OWNER, transactionId })
})

port test from 'node:test'
import assert from 'node:assert/strict'
import { TronWeb } from 'tronweb'
import { createHash } from 'node:crypto'
import { createSponsorTransactionEngine, verifySponsorSignedTransaction } from '../sponsor-engine.mjs'

const SPONSOR = 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL'
const OWNER = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const TXID = 'a'.repeat(64)
const tronWeb = new TronWeb({ fullHost: 'https://api.trongrid.io' })
const sponsorHex = tronWeb.address.toHex(SPONSOR)
const ownerHex = tronWeb.address.toHex(OWNER)

function configuredEnv(overrides = {}) {
  return {
    SPONSOR_MAINNET_ADDRESS: SPONSOR,
    TRON_OWNER_ADDRESS: OWNER,
    SPONSOR_TRANSACTION_ENGINE_ENABLED: 'true',
    SPONSOR_MAINNET_BROADCAST_ENABLED: 'true',
    SPONSOR_LIQUID_RESERVE_TRX: '2',
    SPONSOR_MAX_TX_FEE_SUN: '0',
    SPONSOR_STAKING_ENABLED: 'true',
    SPONSOR_MAX_AUTOMATIC_STAKE_TRX: '10',
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
    tronWebFactory: privateKey => { assert.equal(privateKey, null); return fakeTronWeb },
    signerAdapter: { address: SPONSOR, signTransaction: async tx => fakeTronWeb.trx.sign(tx) },
    fetchImpl,
  })
  return {
    engine, transaction,
    counts: () => ({ signedCount, broadcastCount }),
    markDurable: () => { durableTxId = true },
  }
}

test('legacy SPONSOR_MAINNET_PRIVATE_KEY environment values are ignored', async () => {
  const engine = createSponsorTransactionEngine({
    env: configuredEnv({ SPONSOR_MAINNET_PRIVATE_KEY: '1'.repeat(64) }),
  })
  const state = engine.readiness()
  assert.equal(state.signerMode, 'client-local-required')
  assert.equal(state.signerConfigured, false)
  assert.equal(state.broadcastAvailable, false)
  const result = await engine.execute({ operation: 'stake', resource: 'ENERGY', amountSun: '1000000', ownerAddress: OWNER })
  assert.equal(result.signed, false)
  assert.equal(result.broadcast, false)
  assert.equal(result.status, 'sponsor-engine-disabled-or-unconfigured')
})

test('engine requires an explicit signer adapter and never loads a server-side Sponsor private key', async () => {
  const engine = createSponsorTransactionEngine({ env: {} })
  const state = engine.readiness()
  assert.equal(state.broadcastAvailable, false)
  assert.equal(state.signerMode, 'client-local-required')
  assert.equal(state.signerConfigured, false)
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


test('configured stake cap blocks an amount above SPONSOR_MAX_AUTOMATIC_STAKE_TRX', async () => {
  const f = fixture()
  const result = await f.engine.execute({
    operation: 'stake', resource: 'ENERGY', amountSun: '11000000', ownerAddress: OWNER,
    onSigned: async () => assert.fail('stake above configured cap must not be signed'),
  })
  assert.equal(result.status, 'staking-disabled-or-amount-exceeds-configured-cap')
  assert.equal(f.counts().signedCount, 0)
  assert.equal(f.counts().broadcastCount, 0)
})

test('SPONSOR_STAKING_ENABLED=false blocks Stake 2.0 even when broadcast flags are true', async () => {
  const f = fixture({ envOverrides: { SPONSOR_STAKING_ENABLED: 'false' } })
  const result = await f.engine.execute({
    operation: 'stake', resource: 'ENERGY', amountSun: '1000000', ownerAddress: OWNER,
    onSigned: async () => assert.fail('disabled staking must not be signed'),
  })
  assert.equal(result.status, 'staking-disabled-or-amount-exceeds-configured-cap')
  assert.equal(f.counts().signedCount, 0)
})

test('Sponsor TRX top-up signs only a bounded transfer to the configured Owner and verifies solidified Mainnet state', async () => {
  const transfer = {
    txID: TXID,
    raw_data_hex: '02'.repeat(10),
    raw_data: {
      expiration: Date.now() + 60_000,
      contract: [{ type: 'TransferContract', parameter: { value: { owner_address: sponsorHex, to_address: ownerHex, amount: '1000000' } } }],
    },
  }
  let persisted = false
  let broadcasts = 0
  const fakeTronWeb = {
    address: { fromPrivateKey: () => SPONSOR, fromHex: value => value === ownerHex ? OWNER : SPONSOR },
    transactionBuilder: { sendTrx: async (to, amount, from) => {
      assert.equal(to, OWNER); assert.equal(amount, '1000000'); assert.equal(from, SPONSOR); return transfer
    } },
    trx: {
      getBalance: async () => 10_000_000n,
      getAccountResources: async () => ({ freeNetLimit: 600, freeNetUsed: 0, NetLimit: 0, NetUsed: 0 }),
      getChainParameters: async () => [{ key: 'getTransactionFee', value: 1000 }],
      sign: async tx => ({ ...tx, signature: ['signature'] }),
      sendRawTransaction: async () => { assert.equal(persisted, true); broadcasts++; return { result: true } },
    },
  }
  const fetchImpl = async url => ({
    ok: true,
    json: async () => url.endsWith('gettransactioninfobyid')
      ? { id: TXID, blockNumber: 789, receipt: { result: 'SUCCESS' } }
      : transfer,
  })
  const engine = createSponsorTransactionEngine({
    env: configuredEnv(),
    tronWebFactory: () => fakeTronWeb,
    fetchImpl,
  })
  const result = await engine.execute({
    operation: 'topup', resource: 'TRX', amountSun: '1000000', ownerAddress: OWNER,
    onSigned: async txid => { assert.equal(txid, TXID); persisted = true },
  })
  assert.equal(result.success, true)
  assert.equal(result.solidified, true)
  assert.equal(result.blockNumber, 789)
  assert.equal(broadcasts, 1)
})

test('Sponsor TRX top-up fails closed above the configured Owner funding cap', async () => {
  const f = fixture({ envOverrides: { SPONSOR_MAX_OWNER_TOPUP_TRX: '0.5' } })
  const result = await f.engine.execute({ operation: 'topup', resource: 'TRX', amountSun: '600000', ownerAddress: OWNER })
  assert.equal(result.status, 'owner-topup-disabled-or-amount-exceeds-configured-cap')
  assert.equal(result.signed, false)
  assert.equal(result.broadcast, false)
  assert.deepEqual(f.counts(), { signedCount: 0, broadcastCount: 0 })
})


function lifecycleFixture({ operation, amountSun, resource = 'ENERGY', transactionValue, account = {}, delegatedRows = [], withdrawable = '0', includeWithdrawAmount = true, builderName }) {
  let signed = 0
  let broadcast = 0
  let persisted = false
  const type = {
    undelegate: 'UnDelegateResourceContract',
    unstake: 'UnfreezeBalanceV2Contract',
    withdraw: 'WithdrawExpireUnfreezeContract',
  }[operation]
  const transaction = {
    txID: TXID,
    raw_data_hex: '03'.repeat(12),
    raw_data: {
      expiration: Date.now() + 60_000,
      contract: [{ type, parameter: { value: transactionValue } }],
    },
  }
  const fakeTronWeb = {
    address: {
      fromPrivateKey: () => SPONSOR,
      fromHex: value => value === ownerHex ? OWNER : SPONSOR,
    },
    transactionBuilder: {
      [builderName]: async (...args) => {
        if (operation === 'undelegate') assert.deepEqual(args.slice(0, 4), [amountSun, OWNER, resource, SPONSOR])
        if (operation === 'unstake') assert.deepEqual(args.slice(0, 3), [amountSun, resource, SPONSOR])
        if (operation === 'withdraw') assert.deepEqual(args.slice(0, 1), [SPONSOR])
        return transaction
      },
    },
    trx: {
      getBalance: async () => 10_000_000n,
      getAccountResources: async () => ({ freeNetLimit: 600, freeNetUsed: 0, NetLimit: 0, NetUsed: 0 }),
      getChainParameters: async () => [{ key: 'getTransactionFee', value: 1000 }],
      getDelegatedResourceV2: async () => delegatedRows,
      getAccount: async () => account,
      getAvailableUnfreezeCount: async () => ({ count: 32 }),
      getCanWithdrawUnfreezeAmount: async () => ({ amount: withdrawable }),
      sign: async tx => { signed += 1; return { ...tx, signature: ['signature'] } },
      sendRawTransaction: async () => { assert.equal(persisted, true); broadcast += 1; return { result: true } },
    },
  }
  const fetchImpl = async url => ({
    ok: true,
    json: async () => url.endsWith('gettransactioninfobyid')
      ? { id: TXID, blockNumber: 456, receipt: { result: 'SUCCESS' }, ...(operation === 'withdraw' && includeWithdrawAmount ? { withdraw_expire_amount: amountSun } : {}) }
      : { txID: TXID, raw_data: transaction.raw_data },
  })
  const engine = createSponsorTransactionEngine({ env: configuredEnv(), tronWebFactory: () => fakeTronWeb, fetchImpl })
  return {
    engine,
    counts: () => ({ signed, broadcast }),
    execute: () => engine.execute({
      operation, resource: operation === 'withdraw' ? 'TRX' : resource, amountSun, ownerAddress: OWNER,
      onSigned: async txid => { assert.equal(txid, TXID); persisted = true },
    }),
  }
}

test('undelegate reclaims only the requested confirmed Owner delegation', async () => {
  const amountSun = '1000000'
  const f = lifecycleFixture({
    operation: 'undelegate', amountSun, resource: 'ENERGY', builderName: 'undelegateResource',
    transactionValue: { owner_address: sponsorHex, receiver_address: ownerHex, resource: 1, balance: amountSun },
    delegatedRows: [{ frozen_balance_for_energy: '2000000' }],
  })
  const result = await f.execute()
  assert.equal(result.success, true)
  assert.equal(result.solidified, true)
  assert.equal(result.blockNumber, 456)
  assert.deepEqual(f.counts(), { signed: 1, broadcast: 1 })
})

test('unstake rejects amounts still delegated to the Owner before signing', async () => {
  const amountSun = '4000000'
  const f = lifecycleFixture({
    operation: 'unstake', amountSun, resource: 'ENERGY', builderName: 'unfreezeBalanceV2',
    transactionValue: { owner_address: sponsorHex, resource: 1, unfreeze_balance: amountSun },
    account: { frozenV2: [{ type: 'ENERGY', amount: '5000000' }] },
    delegatedRows: [{ frozen_balance_for_energy: '2000000' }],
  })
  const result = await f.execute()
  assert.equal(result.status, 'unstake-exceeds-unlocked-self-stake')
  assert.deepEqual(f.counts(), { signed: 0, broadcast: 0 })
})

test('unstake initiates the Stake 2.0 delay only for un-delegated self-stake', async () => {
  const amountSun = '3000000'
  const f = lifecycleFixture({
    operation: 'unstake', amountSun, resource: 'ENERGY', builderName: 'unfreezeBalanceV2',
    transactionValue: { owner_address: sponsorHex, resource: 1, unfreeze_balance: amountSun },
    account: { frozenV2: [{ type: 'ENERGY', amount: '5000000' }] },
    delegatedRows: [{ frozen_balance_for_energy: '2000000' }],
  })
  const result = await f.execute()
  assert.equal(result.success, true)
  assert.equal(result.solidified, true)
  assert.deepEqual(f.counts(), { signed: 1, broadcast: 1 })
})

test('withdraw requires the exact currently withdrawable matured unfreeze amount', async () => {
  const amountSun = '2000000'
  const f = lifecycleFixture({
    operation: 'withdraw', amountSun, builderName: 'withdrawExpireUnfreeze',
    transactionValue: { owner_address: sponsorHex }, withdrawable: amountSun,
  })
  const result = await f.execute()
  assert.equal(result.success, true)
  assert.equal(result.solidified, true)
  assert.deepEqual(f.counts(), { signed: 1, broadcast: 1 })
})


test('withdraw is not marked confirmed when the solidified receipt omits the actual withdrawal amount', async () => {
  const amountSun = '2000000'
  const f = lifecycleFixture({
    operation: 'withdraw', amountSun, builderName: 'withdrawExpireUnfreeze',
    transactionValue: { owner_address: sponsorHex }, withdrawable: amountSun,
    includeWithdrawAmount: false,
  })
  const result = await f.execute()
  assert.equal(result.success, false)
  assert.equal(result.solidified, false)
  assert.equal(result.status, 'solidified-withdraw-amount-unavailable')
  assert.deepEqual(f.counts(), { signed: 1, broadcast: 1 })
})

test('withdraw blocks when the matured amount changed after the user reviewed it', async () => {
  const f = lifecycleFixture({
    operation: 'withdraw', amountSun: '2000000', builderName: 'withdrawExpireUnfreeze',
    transactionValue: { owner_address: sponsorHex }, withdrawable: '3000000',
  })
  const result = await f.execute()
  assert.equal(result.status, 'withdraw-amount-changed-refresh-and-retry')
  assert.deepEqual(f.counts(), { signed: 0, broadcast: 0 })
})


test('external Sponsor signer adapter signs only the immutable prevalidated transaction body', async () => {
  const transaction = {
    txID: TXID,
    raw_data_hex: 'ab'.repeat(16),
    raw_data: {
      expiration: Date.now() + 60_000,
      contract: [{ type: 'FreezeBalanceV2Contract', parameter: { value: { owner_address: sponsorHex, resource: 1, frozen_balance: '1000000' } } }],
    },
  }
  let adapterCalls = 0
  let broadcastCalls = 0
  let persisted = false
  const adapter = {
    address: SPONSOR,
    async signTransaction(unsignedTransaction) {
      adapterCalls += 1
      assert.deepEqual(unsignedTransaction, transaction)
      return { ...unsignedTransaction, signature: ['hsm-signature'] }
    },
  }
  const fakeTronWeb = {
    address: { fromHex: () => SPONSOR },
    transactionBuilder: { freezeBalanceV2: async () => structuredClone(transaction) },
    trx: {
      getBalance: async () => 10_000_000n,
      getAccountResources: async () => ({ freeNetLimit: 600, freeNetUsed: 0, NetLimit: 0, NetUsed: 0 }),
      getChainParameters: async () => [{ key: 'getTransactionFee', value: 1000 }],
      sendRawTransaction: async signed => {
        broadcastCalls += 1
        assert.equal(persisted, true)
        assert.equal(signed.signature[0], 'hsm-signature')
        return { result: true, txid: TXID }
      },
    },
  }
  const engine = createSponsorTransactionEngine({
    env: configuredEnv({ SPONSOR_MAINNET_PRIVATE_KEY: undefined }),
    signerAdapter: adapter,
    tronWebFactory: privateKey => {
      assert.equal(privateKey, null, 'external adapter mode must not load an env private key')
      return fakeTronWeb
    },
    fetchImpl: async url => ({
      ok: true,
      json: async () => url.endsWith('gettransactioninfobyid')
        ? { id: TXID, blockNumber: 321, receipt: { result: 'SUCCESS' } }
        : { txID: TXID, raw_data: transaction.raw_data },
    }),
  })
  assert.equal(engine.readiness().signerMode, 'external-adapter')
  assert.equal(engine.readiness().configured, true)
  const result = await engine.execute({
    operation: 'stake', resource: 'ENERGY', amountSun: '1000000', ownerAddress: OWNER,
    onSigned: async txid => { assert.equal(txid, TXID); persisted = true },
  })
  assert.equal(result.success, true)
  assert.equal(adapterCalls, 1)
  assert.equal(broadcastCalls, 1)
})

test('external Sponsor signer address mismatch fails closed before signing or broadcast', async () => {
  let signCalls = 0
  let broadcastCalls = 0
  const engine = createSponsorTransactionEngine({
    env: configuredEnv({ SPONSOR_MAINNET_PRIVATE_KEY: undefined }),
    signerAdapter: { address: OWNER, signTransaction: async () => { signCalls += 1; throw new Error('must not sign') } },
    tronWebFactory: () => ({
      address: { fromHex: () => SPONSOR },
      trx: { sendRawTransaction: async () => { broadcastCalls += 1 } },
    }),
  })
  assert.equal(engine.readiness().configured, false)
  assert.equal(engine.readiness().broadcastAvailable, false)
  const result = await engine.execute({ operation: 'stake', resource: 'ENERGY', amountSun: '1000000', ownerAddress: OWNER })
  assert.equal(result.signed, false)
  assert.equal(result.broadcast, false)
  assert.equal(signCalls, 0)
  assert.equal(broadcastCalls, 0)
})

test('external Sponsor signer cannot mutate transaction bytes or intent before broadcast', async () => {
  const transaction = {
    txID: TXID,
    raw_data_hex: 'cd'.repeat(16),
    raw_data: {
      expiration: Date.now() + 60_000,
      contract: [{ type: 'FreezeBalanceV2Contract', parameter: { value: { owner_address: sponsorHex, resource: 1, frozen_balance: '1000000' } } }],
    },
  }
  let broadcastCalls = 0
  let persistenceCalls = 0
  const engine = createSponsorTransactionEngine({
    env: configuredEnv({ SPONSOR_MAINNET_PRIVATE_KEY: undefined }),
    signerAdapter: {
      address: SPONSOR,
      signTransaction: async unsigned => ({
        ...unsigned,
        raw_data_hex: 'ef'.repeat(16),
        signature: ['tampered-signature'],
      }),
    },
    tronWebFactory: () => ({
      address: { fromHex: () => SPONSOR },
      transactionBuilder: { freezeBalanceV2: async () => structuredClone(transaction) },
      trx: {
        getBalance: async () => 10_000_000n,
        getAccountResources: async () => ({ freeNetLimit: 600, freeNetUsed: 0, NetLimit: 0, NetUsed: 0 }),
        getChainParameters: async () => [{ key: 'getTransactionFee', value: 1000 }],
        sendRawTransaction: async () => { broadcastCalls += 1; return { result: true } },
      },
    }),
  })
  const result = await engine.execute({
    operation: 'stake', resource: 'ENERGY', amountSun: '1000000', ownerAddress: OWNER,
    onSigned: async () => { persistenceCalls += 1 },
  })
  assert.equal(result.status, 'signed-transaction-integrity-failed')
  assert.equal(result.signed, false)
  assert.equal(result.broadcast, false)
  assert.equal(persistenceCalls, 0)
  assert.equal(broadcastCalls, 0)
})

test('backend accepts only an exact locally signed Sponsor transaction with matching TRON permission', async () => {
  const transaction = {
    txID: TXID,
    raw_data_hex: '01'.repeat(20),
    raw_data: {
      expiration: Date.now() + 60_000,
      contract: [{ type: 'FreezeBalanceV2Contract', parameter: { value: { owner_address: sponsorHex, resource: 1, frozen_balance: '1000000' } } }],
    },
  }
  const transactionId = createHash('sha256').update(Buffer.from(transaction.raw_data_hex, 'hex')).digest('hex')
  transaction.txID = transactionId
  const unsignedTransaction = { ...transaction, signature: [] }
  const signedTransaction = { ...transaction, signature: ['b'.repeat(130)] }
  const fakeTronWeb = {
    address: { fromHex: value => value === sponsorHex ? SPONSOR : value === ownerHex ? OWNER : '', },
    isAddress: value => value === SPONSOR || value === OWNER,
    utils: {
      transaction: { txCheck: () => true },
      crypto: { ecRecover: () => sponsorHex },
    },
    trx: {
      getSignWeight: async () => ({
        result: {}, current_weight: 1,
        permission: { id: 0, threshold: 1, keys: [{ address: SPONSOR, weight: 1 }] },
        approved_list: [SPONSOR],
      }),
    },
  }
  const result = await verifySponsorSignedTransaction({
    tronWeb: fakeTronWeb, unsignedTransaction, signedTransaction,
    operation: 'stake', resource: 'ENERGY', amountSun: '1000000',
    sponsorAddress: SPONSOR, ownerAddress: OWNER,
  })
  assert.deepEqual(result, { verified: true, sponsorAddress: SPONSOR, ownerAddress: OWNER, transactionId })
})

test('backend rejects altered Sponsor transaction bodies and a signature from another address', async () => {
  const transaction = {
    txID: TXID,
    raw_data_hex: '01'.repeat(20),
    raw_data: {
      expiration: Date.now() + 60_000,
      contract: [{ type: 'FreezeBalanceV2Contract', parameter: { value: { owner_address: sponsorHex, resource: 1, frozen_balance: '1000000' } } }],
    },
  }
  const unsignedTransaction = { ...transaction, signature: [] }
  const fakeTronWeb = {
    address: { fromHex: value => value === sponsorHex ? SPONSOR : '', },
    isAddress: value => value === SPONSOR,
    utils: { transaction: { txCheck: () => true }, crypto: { ecRecover: () => ownerHex } },
    trx: { getSignWeight: async () => ({ result: {}, current_weight: 1, permission: { id: 0, threshold: 1, keys: [{ address: SPONSOR, weight: 1 }] }, approved_list: [SPONSOR] }) },
  }
  await assert.rejects(verifySponsorSignedTransaction({
    tronWeb: fakeTronWeb, unsignedTransaction,
    signedTransaction: { ...transaction, raw_data_hex: '02'.repeat(20), signature: ['b'.repeat(130)] },
    operation: 'stake', resource: 'ENERGY', amountSun: '1000000', sponsorAddress: SPONSOR, ownerAddress: OWNER,
  }), /integrity|protobuf/)
  await assert.rejects(verifySponsorSignedTransaction({
    tronWeb: fakeTronWeb, unsignedTransaction,
    signedTransaction: { ...transaction, signature: ['b'.repeat(130)] },
    operation: 'stake', resource: 'ENERGY', amountSun: '1000000', sponsorAddress: SPONSOR, ownerAddress: OWNER,
  }), /signer/)
})
