import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import {
  createPlatformTreasuryRouter,
  parseUsdtAmount,
  platformTreasuryConfiguration,
  validateSignedSelfCustodyTransaction,
  hasSufficientTronPermissionWeight,
} from '../server/routes/platform-treasury-withdrawals.mjs'

const owner = 'T' + 'A'.repeat(33)
const treasury = 'T' + 'B'.repeat(33)
const recipient = 'T' + 'C'.repeat(33)
const token = 'T' + 'D'.repeat(33)

function baseEnv(overrides = {}) {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://example.invalid/test',
    OWNER_WALLET_ADDRESS: owner,
    TREASURY_OWNER_ADDRESS: owner,
    PLATFORM_TREASURY_ADDRESS: treasury,
    PLATFORM_TREASURY_MAX_PAYOUT_USDT: '25',
    PLATFORM_TREASURY_DAILY_LIMIT_USDT: '100',
    PLATFORM_TREASURY_MAX_FEE_SUN: '50000000',
    PLATFORM_TREASURY_SELF_CUSTODY_ENABLED: 'false',
    ...overrides,
  }
}

test('USDT amount parser accepts exact six-decimal base-unit values', () => {
  assert.equal(parseUsdtAmount('1'), '1000000')
  assert.equal(parseUsdtAmount('0.000001'), '1')
  assert.equal(parseUsdtAmount('12.340500'), '12340500')
})

test('USDT amount parser rejects zero, excess decimals, exponent notation and malformed strings', () => {
  for (const value of ['0', '0.0000001', '-1', '+1', '1e3', '01', '.5', '1.', '', ' 1']) {
    assert.equal(parseUsdtAmount(value), null, value)
  }
})

test('configuration supports a separate empty identity wallet and separately controlled treasury address', () => {
  const config = platformTreasuryConfiguration(baseEnv(), () => true)
  assert.equal(config.configurationComplete, true)
  assert.equal(config.enabled, false)
  assert.equal(config.ownerAddress, owner)
  assert.equal(config.treasuryAddress, treasury)
  assert.notEqual(config.ownerAddress, config.treasuryAddress)
})

test('configuration rejects identity-owner mismatch and missing payout limits', () => {
  const mismatch = platformTreasuryConfiguration(baseEnv({
    TREASURY_OWNER_ADDRESS: treasury,
  }), () => true)
  assert.equal(mismatch.configurationComplete, false)
  assert.ok(mismatch.missing.some((item) => item.includes('TREASURY_OWNER_ADDRESS')))

  const missingLimits = platformTreasuryConfiguration(baseEnv({
    PLATFORM_TREASURY_MAX_PAYOUT_USDT: '',
    PLATFORM_TREASURY_DAILY_LIMIT_USDT: '',
  }), () => true)
  assert.equal(missingLimits.configurationComplete, false)
  assert.ok(missingLimits.missing.includes('PLATFORM_TREASURY_MAX_PAYOUT_USDT'))

  const numericOrdering = platformTreasuryConfiguration(baseEnv({
    PLATFORM_TREASURY_MAX_PAYOUT_USDT: '9',
    PLATFORM_TREASURY_DAILY_LIMIT_USDT: '10',
  }), () => true)
  assert.equal(numericOrdering.configurationComplete, true)

  const insufficientDailyLimit = platformTreasuryConfiguration(baseEnv({
    PLATFORM_TREASURY_MAX_PAYOUT_USDT: '25',
    PLATFORM_TREASURY_DAILY_LIMIT_USDT: '10',
  }), () => true)
  assert.equal(insufficientDailyLimit.configurationComplete, false)
})

function makeTransferFixture() {
  const fromHex = '41' + '1'.repeat(40)
  const toHex = '41' + '2'.repeat(40)
  const contractHex = '41' + '3'.repeat(40)
  const addressByHex = { [fromHex]: owner, [toHex]: recipient, [contractHex]: token }
  const hexByAddress = { [owner]: fromHex, [recipient]: toHex, [token]: contractHex }
  const tronWeb = {
    isAddress: () => true,
    address: {
      toHex: (address) => hexByAddress[address],
      fromHex: (hex) => addressByHex[String(hex).replace(/^0x/i, '')] || owner,
    },
  }
  const amountBaseUnits = '12345000'
  const receiverBytes = toHex.slice(2)
  const data = 'a9059cbb' + receiverBytes.padStart(64, '0')
    + BigInt(amountBaseUnits).toString(16).padStart(64, '0')
  const rawDataHex = '01'
  const txID = createHash('sha256').update(Buffer.from(rawDataHex, 'hex')).digest('hex')
  const unsignedTransaction = {
    txID,
    raw_data_hex: rawDataHex,
    raw_data: {
      contract: [{
        type: 'TriggerSmartContract',
        parameter: { value: { owner_address: fromHex, contract_address: contractHex, data } },
      }],
    },
  }
  const signedTransaction = { ...unsignedTransaction, signature: ['a'.repeat(130)] }
  return { tronWeb, amountBaseUnits, unsignedTransaction, signedTransaction }
}


test('TRON signature weight must satisfy the account permission threshold for the exact transaction', () => {
  const txid = 'a'.repeat(64)
  assert.equal(hasSufficientTronPermissionWeight({
    result: {},
    permission: { threshold: 2 },
    current_weight: 2,
    transaction: { txid },
  }, txid), true)

  assert.equal(hasSufficientTronPermissionWeight({
    result: {},
    permission: { threshold: 2 },
    current_weight: 2,
    transaction: { txID: txid },
  }, txid), true)

  assert.equal(hasSufficientTronPermissionWeight({
    result: {},
    permission: { threshold: 2 },
    current_weight: 1,
    transaction: { txid },
  }, txid), false)

  assert.equal(hasSufficientTronPermissionWeight({
    result: { code: 'NOT_ENOUGH_PERMISSION' },
    permission: { threshold: 1 },
    current_weight: 1,
    transaction: { txid },
  }, txid), false)

  assert.equal(hasSufficientTronPermissionWeight({
    result: {},
    permission: { threshold: 1 },
    current_weight: 1,
    transaction: { txid: 'b'.repeat(64) },
  }, txid), false)
})

test('signed self-custody transaction must exactly match the stored transfer intent', () => {
  const fixture = makeTransferFixture()
  assert.equal(validateSignedSelfCustodyTransaction(fixture.tronWeb, {
    unsignedTransaction: fixture.unsignedTransaction,
    signedTransaction: fixture.signedTransaction,
    treasuryAddress: owner,
    recipientAddress: recipient,
    amountBaseUnits: fixture.amountBaseUnits,
    tokenContract: token,
  }), true)

  const changedRecipient = {
    ...fixture.signedTransaction,
    raw_data: {
      contract: [{
        type: 'TriggerSmartContract',
        parameter: {
          value: {
            ...fixture.signedTransaction.raw_data.contract[0].parameter.value,
            data: 'a9059cbb' + '4'.repeat(64) + BigInt(fixture.amountBaseUnits).toString(16).padStart(64, '0'),
          },
        },
      }],
    },
  }
  assert.equal(validateSignedSelfCustodyTransaction(fixture.tronWeb, {
    unsignedTransaction: fixture.unsignedTransaction,
    signedTransaction: changedRecipient,
    treasuryAddress: owner,
    recipientAddress: recipient,
    amountBaseUnits: fixture.amountBaseUnits,
    tokenContract: token,
  }), false)

  assert.equal(validateSignedSelfCustodyTransaction(fixture.tronWeb, {
    unsignedTransaction: fixture.unsignedTransaction,
    signedTransaction: { ...fixture.signedTransaction, signature: [] },
    treasuryAddress: owner,
    recipientAddress: recipient,
    amountBaseUnits: fixture.amountBaseUnits,
    tokenContract: token,
  }), false)

  assert.equal(validateSignedSelfCustodyTransaction(fixture.tronWeb, {
    unsignedTransaction: fixture.unsignedTransaction,
    signedTransaction: { ...fixture.signedTransaction, privateKey: 'must-not-be-forwarded' },
    treasuryAddress: owner,
    recipientAddress: recipient,
    amountBaseUnits: fixture.amountBaseUnits,
    tokenContract: token,
  }), false)
})

test('readiness reports missing treasury settings after authenticating the owner identity', async (t) => {
  const app = express()
  app.use(express.json())
  let databaseFactoryCalls = 0
  app.use('/api/treasury', createPlatformTreasuryRouter({
    env: baseEnv({ PLATFORM_TREASURY_ADDRESS: '' }),
    isValidAddress: () => true,
    sessionLookup: async ({ origin }) => ({
      success: true,
      session: { address: owner, network: 'mainnet', origin },
    }),
    poolFactory: () => { databaseFactoryCalls += 1; return null },
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const url = 'http://127.0.0.1:' + server.address().port + '/api/treasury/self-custody/readiness'
  const response = await fetch(url, {
    headers: {
      origin: 'https://owner.example',
      authorization: 'Bearer ' + 'A'.repeat(43),
    },
  })
  const payload = await response.json()
  assert.equal(response.status, 200)
  assert.equal(payload.success, true)
  assert.equal(payload.configurationComplete, false)
  assert.equal(payload.executionEnabled, false)
  assert.ok(payload.missing.includes('PLATFORM_TREASURY_ADDRESS'))
  assert.equal(databaseFactoryCalls, 0)
})

test('self-custody prepare remains off unless its explicit server-side feature flag is enabled', async (t) => {
  const app = express()
  app.use(express.json())
  let databaseFactoryCalls = 0
  app.use('/api/treasury', createPlatformTreasuryRouter({
    env: baseEnv(),
    isValidAddress: () => true,
    sessionLookup: async ({ origin }) => ({
      success: true,
      session: { address: owner, network: 'mainnet', origin },
    }),
    poolFactory: () => { databaseFactoryCalls += 1; return null },
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const url = 'http://127.0.0.1:' + server.address().port + '/api/treasury/self-custody/prepare'
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      origin: 'https://owner.example',
      authorization: 'Bearer ' + 'A'.repeat(43),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ recipientAddress: recipient, amountUsdt: '1' }),
  })
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { success: false, error: 'self-custody-execution-disabled' })
  assert.equal(databaseFactoryCalls, 0)
})

test('self-custody request rejects private-key fields and other unrecognized input', async (t) => {
  const app = express()
  app.use(express.json())
  app.use('/api/treasury', createPlatformTreasuryRouter({
    env: baseEnv({ PLATFORM_TREASURY_SELF_CUSTODY_ENABLED: 'true' }),
    isValidAddress: () => true,
    sessionLookup: async ({ origin }) => ({
      success: true,
      session: { address: owner, network: 'mainnet', origin },
    }),
    poolFactory: () => null,
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const url = 'http://127.0.0.1:' + server.address().port + '/api/treasury/self-custody/prepare'
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      origin: 'https://owner.example',
      authorization: 'Bearer ' + 'A'.repeat(43),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ recipientAddress: recipient, amountUsdt: '1', privateKey: 'must-never-be-accepted' }),
  })
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { success: false, error: 'invalid-withdrawal-request' })
})

test('self-custody prepare rejects missing or malformed idempotency request keys', async (t) => {
  const app = express()
  app.use(express.json())
  app.use('/api/treasury', createPlatformTreasuryRouter({
    env: baseEnv({ PLATFORM_TREASURY_SELF_CUSTODY_ENABLED: 'true' }),
    isValidAddress: () => true,
    sessionLookup: async ({ origin }) => ({
      success: true,
      session: { address: owner, network: 'mainnet', origin },
    }),
    poolFactory: () => { throw new Error('database must not be reached for invalid request keys') },
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const url = 'http://127.0.0.1:' + server.address().port + '/api/treasury/self-custody/prepare'
  for (const requestKey of [undefined, 'not-a-uuid', '11111111-1111-1111-1111-111111111111']) {
    const body = { recipientAddress: recipient, amountUsdt: '1', ...(requestKey ? { requestKey } : {}) }
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        origin: 'https://owner.example',
        authorization: 'Bearer ' + 'A'.repeat(43),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { success: false, error: 'invalid-withdrawal-request' })
  }
})
