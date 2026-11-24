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
async function signAndSubmitLocally(engine, localWallet, input) {
  const prepared = await engine.prepare(input)
  if (!prepared.success) return prepared
  const signedTransaction = await localWallet.trx.sign(prepared.transaction)
  return engine.submitSigned({
    preparedTransaction: prepared.transaction,
    signedTransaction,
    ...input,
  })
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
    address: {
      fromPrivateKey: () => SPONSOR,
      fromHex: value => value === sponsorHex ? SPONSOR : value === ownerHex ? OWNER : '',
      toHex: value => value === SPONSOR ? sponsorHex : value === OWNER ? ownerHex : '',
    },
    isAddress: value => value === SPONSOR || value === OWNER,
    utils: { transaction: { txCheck: () => true }, crypto: { ecRecover: () => sponsorHex } },
    transactionBuilder: { freezeBalanceV2: async () => transaction },
    trx: {
      getBalance: async () => balance,
      getAccountResources: async () => ({ freeNetLimit: bandwidth, freeNetUsed: 0, NetLimit: 0, NetUsed: 0 }),
      getChainParameters: async () => [{ key: 'getTransactionFee', value: 1000 }],
      sign: async tx => { signedCount += 1; return { ...tx, signature: ['b'.repeat(130)] } },
      getSignWeight: async () => ({ result: {}, current_weight: 1, permission: { id: 0, threshold: 1, keys: [{ address: SPONSOR, weight: 1 }] }, approved_list: [SPONSOR] }),
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
    tronWebFactory: (...args) => { assert.equal(args.length, 0, 'server TronWeb factory must never receive private-key material'); return fakeTronWeb },
    fetchImpl,
  })
  const testEngine = Object.freeze({
    ...engine,
    execute: input => signAndSubmitLocally(engine, fakeTronWeb, input),
  })
  return {
    engine: testEngine, transaction,
    counts: () => ({ signedCount, broadcastCount }),
    markDurable: () => { durableTxId = true },
  }
}

test('Sponsor engine uses the local vault only and ignores server private-key configuration', () => {
  const engine = createSponsorTransactionEngine({
    env: configuredEnv({ SPONSOR_MAINNET_PRIVATE_KEY: '1'.repeat(64) }),
  })
  const state = engine.readiness()
  assert.equal(state.signerMode, 'client-local-vault')
  assert.equal(state.signerConfigured, false)
  assert.equal(state.serverSignerConfigured, false)
  assert.equal(state.clientSigningAvailable, true)
  assert.equal(typeof engine.execute, 'undefined')
})

test('Sponsor engine requires explicit, distinct Owner and Sponsor Mainnet addresses', () => {
  const missingOwner = createSponsorTransactionEngine({ env: { SPONSOR_MAINNET_ADDRESS: SPONSOR } })
  assert.equal(missingOwner.readiness().ownerAddressValid, false)
  assert.equal(missingOwner.readiness().clientSigningAvailable, false)
  const sameWallet = createSponsorTransactionEngine({
    env: configuredEnv({ TRON_OWNER_ADDRESS: SPONSOR }),
  })
  assert.equal(sameWallet.readiness().addressesIndependent, false)
  assert.equal(sameWallet.readiness().clientSigningAvailable, false)
})

test('client-local preparation returns an unsigned exact transaction without signing or broadcasting', async () => {
  const f = fixture()
  const result = await f.engine.prepare({ operation: 'stake', resource: 'ENERGY', amountSun: '1000000', ownerAddress: OWNER })
  assert.equal(result.success, true)
  assert.equal(result.status, 'prepared')
  assert.equal(result.sponsorAddress, SPONSOR)
  assert.equal(result.transaction.txID, TXID)
  assert.equal(Array.isArray(result.transaction.signature), false)
  assert.deepEqual(f.counts(), { signedCount: 0, broadcastCount: 0 })
})

test('client-local submit verifies Sponsor permission and persists the exact signed payload before broadcasting', async () => {
  const rawDataHex = '0a02c25122085c685c92bf035e7240988c89d0f72d'
  const txid = createHash('sha256').update(Buffer.from(rawDataHex, 'hex')).digest('hex')
  const transaction = {
    txID: txid, raw_data_hex: rawDataHex,
    raw_data: {
      expiration: Date.now() + 60_000,
      contract: [{ type: 'FreezeBalanceV2Contract', parameter: { value: { owner_address: sponsorHex, resource: 1, frozen_balance: '1000000' } } }],
    },
  }
  let persisted = false
  let broadcasts = 0
  const fakeTronWeb = {
    address: { fromHex: () => SPONSOR, toHex: () => sponsorHex },
    isAddress: value => value === SPONSOR,
    utils: { transaction: { txCheck: () => true }, crypto: { ecRecover: () => sponsorHex } },
    trx: {
      getBalance: async () => 10_000_000n,
      getAccountResources: async () => ({ freeNetLimit: 600, freeNetUsed: 0, NetLimit: 0, NetUsed: 0 }),
      getChainParameters: async () => [{ key: 'getTransactionFee', value: 1000 }],
      getSignWeight: async () => ({ approved_list: [SPONSOR], permission: { id: 0, threshold: 1, keys: [{ address: SPONSOR, weight: 1 }] }, current_weight: 1, result: {} }),
      sendRawTransaction: async () => { assert.equal(persisted, true); broadcasts++; return { result: true } },
    },
  }
  const engine = createSponsorTransactionEngine({
    env: configuredEnv(), tronWebFactory: () => fakeTronWeb,
    fetchImpl: async url => ({
      ok: true,
      json: async () => url.endsWith('gettransactioninfobyid')
        ? { id: txid, blockNumber: 987, receipt: { result: 'SUCCESS' } }
        : { txID: txid, raw_data: transaction.raw_data },
    }),
  })
  const result = await engine.submitSigned({
    preparedTransaction: transaction,
    signedTransaction: { ...transaction, signature: ['b'.repeat(130)] },
    operation: 'stake', resource: 'ENERGY', amountSun: '1000000', ownerAddress: OWNER,
    onSigned: async id => { assert.equal(id, txid); persisted = true },
  })
  assert.equal(result.success, true)
  assert.equal(result.solidified, true)
  assert.equal(result.blockNumber, 987)
  assert.equal(broadcasts, 1)
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
    address: {
      fromPrivateKey: () => SPONSOR,
      fromHex: value => value === ownerHex ? OWNER : SPONSOR,
      toHex: value => value === SPONSOR ? sponsorHex : value === OWNER ? ownerHex : '',
    },
    isAddress: value => value === SPONSOR || value === OWNER,
    utils: { transaction: { txCheck: () => true }, crypto: { ecRecover: () => sponsorHex } },
    transactionBuilder: { sendTrx: async (to, amount, from) => {
      assert.equal(to, OWNER); assert.equal(amount, '1000000'); assert.equal(from, SPONSOR); return transfer
    } },
    trx: {
      getBalance: async () => 10_000_000n,
      getAccountResources: async () => ({ freeNetLimit: 600, freeNetUsed: 0, NetLimit: 0, NetUsed: 0 }),
      getChainParameters: async () => [{ key: 'getTransactionFee', value: 1000 }],
      sign: async tx => ({ ...tx, signature: ['b'.repeat(130)] }),
      getSignWeight: async () => ({ result: {}, current_weight: 1, permission: { id: 0, threshold: 1, keys: [{ address: SPONSOR, weight: 1 }] }, approved_list: [SPONSOR] }),
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
  const result = await signAndSubmitLocally(engine, fakeTronWeb, {
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
  assert.equal(result.success, false)
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
      toHex: value => value === SPONSOR ? sponsorHex : value === OWNER ? ownerHex : '',
    },
    isAddress: value => value === SPONSOR || value === OWNER,
    utils: { transaction: { txCheck: () => true }, crypto: { ecRecover: () => sponsorHex } },
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
      sign: async tx => { signed += 1; return { ...tx, signature: ['b'.repeat(130)] } },
      getSignWeight: async () => ({ result: {}, current_weight: 1, permission: { id: 0, threshold: 1, keys: [{ address: SPONSOR, weight: 1 }] }, approved_list: [SPONSOR] }),
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
    execute: () => signAndSubmitLocally(engine, fakeTronWeb, {
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
  assert.equal(result.status, 'unstake-exceeds-unlocked-self-stake-or-no-slots')
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
    address: { fromHex: value => value === sponsorHex ? SPONSOR : value === ownerHex ? OWNER : '', toHex: value => value === SPONSOR ? sponsorHex : value === OWNER ? ownerHex : '' },
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

test('Sponsor engine never broadcasts when durable signed-transaction persistence fails', async () => {
  const f = fixture()
  const result = await f.engine.execute({
    operation: 'stake', resource: 'ENERGY', amountSun: '1000000', ownerAddress: OWNER,
    onSigned: async () => { throw new Error('durable-signed-payload-write-failed') },
  })
  assert.equal(result.success, false)
  assert.equal(result.broadcast, false)
  assert.equal(f.counts().signedCount, 1, 'local signing may occur before the persistence attempt')
  assert.equal(f.counts().broadcastCount, 0, 'broadcast must never happen when persistence fails')
})
