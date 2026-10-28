import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { assertTreasuryPayoutTransactionIntent, classifyConfirmedPayoutReceipt, createTreasuryWithdrawalsRouter, parsePositiveDecimal } from '../server/routes/treasury-withdrawals.mjs'

test('USDT decimal parser converts exact six-decimal amounts to base units', () => {
  assert.equal(parsePositiveDecimal('1'), 1_000_000n)
  assert.equal(parsePositiveDecimal('0.000001'), 1n)
  assert.equal(parsePositiveDecimal('12.340500'), 12_340_500n)
})

test('USDT decimal parser rejects zero, excess precision, exponent notation and malformed input', () => {
  for (const value of ['0', '0.0000001', '-1', '+1', '1e3', '01', '.5', '1.', '', ' 1']) {
    assert.equal(parsePositiveDecimal(value), null, value)
  }
})

test('treasury endpoint requires an authenticated owner session before touching treasury configuration', async (t) => {
  const app = express()
  app.use(express.json())
  app.use('/api/treasury', createTreasuryWithdrawalsRouter({
    env: {},
    sessionLookup: async () => ({ success: true, session: null }),
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const address = server.address()
  const response = await fetch(`http://127.0.0.1:${address.port}/api/treasury/withdrawals/readiness`, {
    headers: { origin: 'https://owner.example' },
  })
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { success: false, error: 'owner-auth-required' })
})


const ownerAddress = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const recipientAddress = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
const officialUsdt = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const txid = 'a'.repeat(64)
const ownerHex = '41' + '1'.repeat(40)
const recipientHex = '41' + '2'.repeat(40)
const usdtHex = '41' + '3'.repeat(40)

function payoutTronWeb() {
  const addresses = new Map([
    [ownerAddress, ownerHex],
    [recipientAddress, recipientHex],
    [officialUsdt, usdtHex],
  ])
  return {
    isAddress: value => addresses.has(value),
    address: {
      toHex: value => addresses.get(value) || '',
    },
  }
}

function payoutTransaction({ recipient = recipientHex, owner = ownerHex, contract = usdtHex, amount = '1250000', id = txid, extraContract = false } = {}) {
  const data = 'a9059cbb'
    + (recipient.startsWith('41') ? recipient.slice(2) : recipient).padStart(64, '0')
    + BigInt(amount).toString(16).padStart(64, '0')
  const operation = {
    type: 'TriggerSmartContract',
    parameter: { value: { owner_address: owner, contract_address: contract, data } },
  }
  return { txID: id, raw_data: { contract: extraContract ? [operation, operation] : [operation] } }
}

test('treasury transaction guard accepts only the exact official-USDT transfer intent', () => {
  const tronWeb = payoutTronWeb()
  assert.equal(assertTreasuryPayoutTransactionIntent(tronWeb, payoutTransaction(), {
    treasuryAddress: ownerAddress,
    recipientAddress,
    amountBaseUnits: '1250000',
  }), true)
  assert.throws(() => assertTreasuryPayoutTransactionIntent(tronWeb, payoutTransaction({ amount: '1250001' }), {
    treasuryAddress: ownerAddress, recipientAddress, amountBaseUnits: '1250000',
  }), /recipient or amount/)
  assert.throws(() => assertTreasuryPayoutTransactionIntent(tronWeb, payoutTransaction({ owner: '41' + '4'.repeat(40) }), {
    treasuryAddress: ownerAddress, recipientAddress, amountBaseUnits: '1250000',
  }), /sender or token contract/)
  assert.throws(() => assertTreasuryPayoutTransactionIntent(tronWeb, payoutTransaction({ contract: '41' + '5'.repeat(40) }), {
    treasuryAddress: ownerAddress, recipientAddress, amountBaseUnits: '1250000',
  }), /sender or token contract/)
  assert.throws(() => assertTreasuryPayoutTransactionIntent(tronWeb, payoutTransaction({ extraContract: true }), {
    treasuryAddress: ownerAddress, recipientAddress, amountBaseUnits: '1250000',
  }), /malformed/)
})

test('treasury receipt verification requires matching confirmed transaction and explicit success evidence', () => {
  const tronWeb = payoutTronWeb()
  const record = {
    transaction_hash: txid,
    treasury_address: ownerAddress,
    recipient_address: recipientAddress,
    token_contract: officialUsdt,
    amount_base_units: '1250000',
  }
  const confirmed = { ...payoutTransaction(), ret: [{ contractRet: 'SUCCESS' }] }
  assert.equal(classifyConfirmedPayoutReceipt(tronWeb, record, confirmed, {}), 'confirmed')
  assert.equal(classifyConfirmedPayoutReceipt(tronWeb, record, {
    ...payoutTransaction(), ret: [{ contractRet: 'OUT_OF_ENERGY' }],
  }, {}), 'failed')
  assert.equal(classifyConfirmedPayoutReceipt(tronWeb, record, payoutTransaction(), {}), null)
  assert.equal(classifyConfirmedPayoutReceipt(tronWeb, record, payoutTransaction({ id: 'b'.repeat(64) }), {
    receipt: { result: 'SUCCESS' },
  }), null)
  assert.equal(classifyConfirmedPayoutReceipt(tronWeb, record, payoutTransaction({ recipient: '41' + '9'.repeat(40) }), {
    receipt: { result: 'SUCCESS' },
  }), null)
})

test('treasury endpoint rejects a validly signed session for a non-owner address', async (t) => {
  const app = express()
  app.use(express.json())
  app.use('/api/treasury', createTreasuryWithdrawalsRouter({
    env: { TREASURY_OWNER_ADDRESS: ownerAddress },
    sessionLookup: async () => ({
      success: true,
      session: { address: recipientAddress, network: 'mainnet', origin: 'https://owner.example' },
    }),
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const address = server.address()
  const response = await fetch(\`http://127.0.0.1:\${address.port}/api/treasury/withdrawals/readiness\`, {
    headers: { origin: 'https://owner.example', authorization: 'Bearer ' + 'A'.repeat(43) },
  })
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { success: false, error: 'treasury-owner-only' })
})

test('treasury readiness stays disabled when required payout limits or TRX reserve are missing', async (t) => {
  const app = express()
  app.use(express.json())
  app.use('/api/treasury', createTreasuryWithdrawalsRouter({
    env: { TREASURY_OWNER_ADDRESS: ownerAddress },
    sessionLookup: async () => ({
      success: true,
      session: { address: ownerAddress, network: 'mainnet', origin: 'https://owner.example' },
    }),
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const address = server.address()
  const response = await fetch(\`http://127.0.0.1:\${address.port}/api/treasury/withdrawals/readiness\`, {
    headers: { origin: 'https://owner.example', authorization: 'Bearer ' + 'A'.repeat(43) },
  })
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.withdrawalsEnabled, false)
  assert.ok(payload.configuration.missing.includes('TREASURY_MIN_TRX_RESERVE'))
})
