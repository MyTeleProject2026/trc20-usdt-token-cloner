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


const treasuryAddress = 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL'
const treasuryHex = '41' + '4'.repeat(40)
const ownerPayoutToken = 'A'.repeat(43)

function createTreasuryIntegrationHarness({ usdtBalance = '50000000', trxBalance = '200000000' } = {}) {
  const addresses = new Map([
    [ownerAddress, ownerHex],
    [recipientAddress, recipientHex],
    [treasuryAddress, treasuryHex],
    [officialUsdt, usdtHex],
  ])
  const txidForPayout = 'c'.repeat(64)
  const state = { row: null, sends: 0, txIdWasPersistedBeforeBroadcast: false }
  const db = {
    async query(sql, params = []) {
      const q = sql.replace(/\s+/g, ' ').trim()
      if (q === 'SELECT 1' || q === 'BEGIN' || q === 'COMMIT' || q === 'ROLLBACK' || q.includes('pg_advisory_xact_lock')) return { rows: [] }
      if (q.includes('SELECT * FROM trc20_token_clone.treasury_withdrawal_requests WHERE idempotency_key = $1 FOR UPDATE')) {
        return { rows: state.row && state.row.idempotency_key === params[0] ? [state.row] : [] }
      }
      if (q.includes('COALESCE(SUM(amount_base_units)')) {
        const activeOnly = q.includes("status IN ('broadcasting','broadcast-accepted','broadcast-unknown')")
        const eligible = state.row && (activeOnly
          ? ['broadcasting', 'broadcast-accepted', 'broadcast-unknown'].includes(state.row.status)
          : state.row.status !== 'rejected')
        return { rows: [{ amount: eligible ? String(state.row.amount_base_units) : '0' }] }
      }
      if (q.startsWith('INSERT INTO trc20_token_clone.treasury_withdrawal_requests')) {
        const [key, owner, treasury, recipient, contract, amount] = params
        state.row = {
          id: 1, idempotency_key: key, owner_address: owner, treasury_address: treasury,
          recipient_address: recipient, token_contract: contract, amount_base_units: String(amount),
          status: 'broadcasting', transaction_hash: null, failure_code: null,
          created_at: new Date(), updated_at: new Date(),
        }
        return { rows: [state.row] }
      }
      if (q.startsWith('UPDATE trc20_token_clone.treasury_withdrawal_requests SET transaction_hash=$2')) {
        if (state.row) {
          state.row.transaction_hash = params[1]
          state.row.updated_at = new Date()
          return { rows: [{ id: state.row.id }] }
        }
        return { rows: [] }
      }
      if (q.startsWith("UPDATE trc20_token_clone.treasury_withdrawal_requests SET status='broadcast-accepted'")) {
        if (state.row) {
          state.row.status = 'broadcast-accepted'
          state.row.updated_at = new Date()
          return { rows: [state.row] }
        }
        return { rows: [] }
      }
      if (q.startsWith("UPDATE trc20_token_clone.treasury_withdrawal_requests SET status='broadcast-unknown'")) {
        if (state.row) {
          state.row.status = 'broadcast-unknown'
          state.row.failure_code = params[1] || 'broadcast-outcome-unknown'
          state.row.updated_at = new Date()
          return { rows: [] }
        }
        return { rows: [] }
      }
      if (q.startsWith("UPDATE trc20_token_clone.treasury_withdrawal_requests SET status='rejected'")) {
        if (state.row) {
          state.row.status = 'rejected'
          state.row.failure_code = 'transaction-build-or-sign-failed'
          return { rows: [] }
        }
        return { rows: [] }
      }
      if (q.includes('SELECT * FROM trc20_token_clone.treasury_withdrawal_requests WHERE idempotency_key = $1 AND owner_address = $2')) {
        return { rows: state.row && state.row.idempotency_key === params[0] && state.row.owner_address === params[1] ? [state.row] : [] }
      }
      return { rows: [] }
    },
    async connect() {
      return { query: this.query.bind(this), release() {} }
    },
  }
  const contract = {
    decimals: () => ({ call: async () => '6' }),
    symbol: () => ({ call: async () => 'USDT' }),
    balanceOf: () => ({ call: async () => usdtBalance }),
  }
  const tronWeb = {
    isAddress: value => addresses.has(value),
    address: {
      fromPrivateKey: () => treasuryAddress,
      toHex: value => addresses.get(value) || '',
    },
    contract: () => ({ at: async () => contract }),
    trx: {
      getBalance: async () => trxBalance,
      sign: async transaction => ({ ...transaction, signature: ['mock-signature'] }),
      sendRawTransaction: async transaction => {
        state.sends += 1
        state.txIdWasPersistedBeforeBroadcast = state.row?.transaction_hash === txidForPayout
          && transaction?.txID === txidForPayout
        return { result: true, txid: txidForPayout }
      },
    },
    transactionBuilder: {
      triggerSmartContract: async (_contract, _method, _options, parameters, sender) => {
        const destination = String(parameters[0].value)
        const amount = BigInt(String(parameters[1].value)).toString(16).padStart(64, '0')
        const destinationHex = (addresses.get(destination) || '').slice(2).padStart(64, '0')
        return {
          result: { result: true },
          transaction: {
            txID: txidForPayout,
            raw_data: {
              contract: [{
                type: 'TriggerSmartContract',
                parameter: { value: {
                  owner_address: addresses.get(sender),
                  contract_address: addresses.get(officialUsdt),
                  data: 'a9059cbb' + destinationHex + amount,
                } },
              }],
            },
          },
        }
      },
    },
  }
  const env = {
    DATABASE_URL: 'postgres://test-only',
    TREASURY_WITHDRAWALS_ENABLED: 'true',
    TREASURY_SIGNER_MODE: 'env-hot-wallet',
    TREASURY_OWNER_ADDRESS: ownerAddress,
    TREASURY_ADDRESS: treasuryAddress,
    TREASURY_PRIVATE_KEY: 'b'.repeat(64),
    TREASURY_MAX_PAYOUT_USDT: '10',
    TREASURY_DAILY_LIMIT_USDT: '20',
    TREASURY_FEE_LIMIT_SUN: '50000000',
    TREASURY_MIN_TRX_RESERVE: '5',
  }
  const app = express()
  app.use(express.json())
  app.use('/api/treasury', createTreasuryWithdrawalsRouter({
    env,
    sessionLookup: async () => ({ success: true, session: {
      address: ownerAddress, network: 'mainnet', origin: 'https://owner.example',
    } }),
    tronWebFactory: () => tronWeb,
    readOnlyTronWebFactory: () => tronWeb,
    databaseProvider: () => db,
    prepareDatabase: async () => {},
  }))
  return { app, db, state, env, txidForPayout }
}

test('owner payout uses the separate funded treasury, persists the signed txid before broadcast, and is idempotent', async (t) => {
  const harness = createTreasuryIntegrationHarness()
  const server = createServer(harness.app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const endpoint = \`http://127.0.0.1:\${server.address().port}/api/treasury/withdrawals\`
  const headers = {
    origin: 'https://owner.example',
    authorization: 'Bearer ' + ownerPayoutToken,
    'content-type': 'application/json',
  }
  const request = {
    recipientAddress,
    amountUsdt: '1.25',
    idempotencyKey: 'withdrawal-integration-test-00001',
  }
  const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(request) })
  const payload = await response.json()
  assert.equal(response.status, 202)
  assert.equal(payload.status, 'broadcast-accepted')
  assert.equal(payload.withdrawal.treasuryAddress, treasuryAddress)
  assert.equal(payload.withdrawal.transactionHash, harness.txidForPayout)
  assert.equal(harness.state.row.owner_address, ownerAddress)
  assert.notEqual(harness.state.row.owner_address, harness.state.row.treasury_address)
  assert.equal(harness.state.txIdWasPersistedBeforeBroadcast, true)
  assert.equal(harness.state.sends, 1)

  const duplicate = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(request) })
  const duplicatePayload = await duplicate.json()
  assert.equal(duplicate.status, 200)
  assert.equal(duplicatePayload.duplicate, true)
  assert.equal(harness.state.sends, 1)

  const conflict = await fetch(endpoint, {
    method: 'POST', headers,
    body: JSON.stringify({ ...request, recipientAddress: ownerAddress }),
  })
  assert.equal(conflict.status, 409)
  assert.equal((await conflict.json()).error, 'idempotency-key-conflict')
  assert.equal(harness.state.sends, 1)
})

test('treasury payout refuses to broadcast when real on-chain USDT is insufficient', async (t) => {
  const harness = createTreasuryIntegrationHarness({ usdtBalance: '0' })
  const server = createServer(harness.app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const response = await fetch(\`http://127.0.0.1:\${server.address().port}/api/treasury/withdrawals\`, {
    method: 'POST',
    headers: {
      origin: 'https://owner.example',
      authorization: 'Bearer ' + ownerPayoutToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      recipientAddress, amountUsdt: '1.25', idempotencyKey: 'withdrawal-insufficient-funds-001',
    }),
  })
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error, 'treasury-usdt-insufficient')
  assert.equal(harness.state.sends, 0)
  assert.equal(harness.state.row, null)
})
