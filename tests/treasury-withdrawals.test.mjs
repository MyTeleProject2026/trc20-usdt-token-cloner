import test from 'node:test'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { assertTreasuryPayoutTransactionIntent, createTreasuryWithdrawalsRouter, parsePositiveDecimal, verifyTreasuryTransferEvidence } from '../server/routes/treasury-withdrawals.mjs'

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


const treasuryAddress = 'T' + 'A'.repeat(33)
const recipientAddress = 'T' + 'B'.repeat(33)
const txid = 'a'.repeat(64)
const amountBaseUnits = '12345000'
const addressHex = new Map([
  [treasuryAddress, '41' + '11'.repeat(20)],
  [recipientAddress, '41' + '22'.repeat(20)],
  ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', '41' + '33'.repeat(20)],
])
const fakeTronWeb = { address: { toHex: (address) => addressHex.get(address) || '' } }

function validEvidence({ receiptResult = 'SUCCESS', amount = amountBaseUnits, recipient = recipientAddress } = {}) {
  const recipientHex = addressHex.get(recipient).slice(2)
  const data = 'a9059cbb' + recipientHex.padStart(64, '0')
    + BigInt(amount).toString(16).padStart(64, '0')
  return {
    transaction: {
      txID: txid,
      raw_data: { contract: [{
        type: 'TriggerSmartContract',
        parameter: { value: {
          owner_address: addressHex.get(treasuryAddress),
          contract_address: addressHex.get('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'),
          data,
        } },
      }] },
    },
    transactionInfo: { id: txid, blockNumber: 12345, receipt: receiptResult ? { result: receiptResult } : {} },
  }
}

function verify(input = validEvidence()) {
  return verifyTreasuryTransferEvidence(fakeTronWeb, {
    ...input,
    transactionHash: txid,
    treasuryAddress,
    recipientAddress,
    amountBaseUnits,
  })
}

test('treasury receipt verifier confirms only the exact official-USDT transfer and successful solidified receipt', () => {
  assert.deepEqual(verify(), {
    verified: true,
    status: 'confirmed',
    reason: 'confirmed-solidified-successful-receipt',
    blockNumber: 12345,
  })
})

test('treasury receipt verifier rejects a different recipient, amount, sender, or token contract', () => {
  assert.equal(verify(validEvidence({ recipient: treasuryAddress })).status, 'verification-mismatch')
  assert.equal(verify(validEvidence({ amount: '12345001' })).status, 'verification-mismatch')

  const wrongSender = validEvidence()
  wrongSender.transaction.raw_data.contract[0].parameter.value.owner_address = '41' + '44'.repeat(20)
  assert.equal(verify(wrongSender).reason, 'sender-or-token-contract-mismatch')

  const wrongContract = validEvidence()
  wrongContract.transaction.raw_data.contract[0].parameter.value.contract_address = '41' + '55'.repeat(20)
  assert.equal(verify(wrongContract).reason, 'sender-or-token-contract-mismatch')
})

test('treasury receipt verifier reports failed contract execution as failed, not received USDT', () => {
  assert.deepEqual(verify(validEvidence({ receiptResult: 'REVERT' })), {
    verified: true,
    status: 'failed',
    reason: 'confirmed-solidified-failed-receipt',
    blockNumber: 12345,
  })
})

test('treasury receipt verifier leaves missing receipt evidence pending', () => {
  const evidence = validEvidence({ receiptResult: null })
  assert.equal(verify(evidence).status, 'awaiting-confirmed-receipt')
  assert.equal(verify(evidence).verified, false)
})

test('treasury receipt verifier rejects a transaction hash that does not match the returned transaction', () => {
  const evidence = validEvidence()
  evidence.transaction.txID = 'b'.repeat(64)
  assert.equal(verify(evidence).verified, false)
})


const realOwnerAddress = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const realTreasuryAddress = 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL'
const realRecipientAddress = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
const officialUsdtAddress = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const payoutTxRawHex = '01020304'
const payoutTxId = createHash('sha256').update(Buffer.from(payoutTxRawHex, 'hex')).digest('hex')

function createPayoutTestHarness({ usdtBalance = '50000000', trxBalance = '200000000' } = {}) {
  const addresses = new Map([
    [realOwnerAddress, '41' + '11'.repeat(20)],
    [realTreasuryAddress, '41' + '44'.repeat(20)],
    [realRecipientAddress, '41' + '22'.repeat(20)],
    [officialUsdtAddress, '41' + '33'.repeat(20)],
  ])
  const state = { row: null, sends: 0, txIdWasPersistedBeforeBroadcast: false }
  const db = {
    async query(sql, params = []) {
      const q = sql.replace(/\s+/g, ' ').trim()
      if (['SELECT 1', 'BEGIN', 'COMMIT', 'ROLLBACK'].includes(q) || q.includes('pg_advisory_xact_lock')) return { rows: [] }
      if (q.includes('SELECT * FROM trc20_token_clone.treasury_withdrawal_requests WHERE idempotency_key = $1 FOR UPDATE')) {
        return { rows: state.row && state.row.idempotency_key === params[0] ? [state.row] : [] }
      }
      if (q === 'SELECT * FROM trc20_token_clone.treasury_withdrawal_requests WHERE idempotency_key = $1') {
        return { rows: state.row && state.row.idempotency_key === params[0] ? [state.row] : [] }
      }
      if (q.includes("WHERE treasury_address = $1 AND status IN ('broadcasting','broadcast-accepted','broadcast-unknown')")) {
        return { rows: state.row && state.row.treasury_address === params[0]
          && ['broadcasting', 'broadcast-accepted', 'broadcast-unknown'].includes(state.row.status) ? [state.row] : [] }
      }
      if (q.includes("WHERE owner_address = $1 AND status IN ('broadcasting','broadcast-accepted','broadcast-unknown')")) {
        return { rows: state.row && state.row.owner_address === params[0]
          && ['broadcasting', 'broadcast-accepted', 'broadcast-unknown'].includes(state.row.status) ? [state.row] : [] }
      }
      if (q.includes('COALESCE(SUM(amount_base_units)')) return { rows: [{ amount: '0' }] }
      if (q.startsWith('INSERT INTO trc20_token_clone.treasury_withdrawal_requests')) {
        const [key, owner, treasury, recipient, token, amount] = params
        state.row = {
          id: 1, idempotency_key: key, owner_address: owner, treasury_address: treasury,
          recipient_address: recipient, token_contract: token, amount_base_units: String(amount),
          status: 'broadcasting', transaction_hash: null, failure_code: null,
          created_at: new Date(), updated_at: new Date(),
        }
        return { rows: [state.row] }
      }
      if (q.startsWith('UPDATE trc20_token_clone.treasury_withdrawal_requests SET transaction_hash=$2')) {
        state.row.transaction_hash = params[1]
        state.row.updated_at = new Date()
        return { rows: [{ id: state.row.id }] }
      }
      if (q.startsWith("UPDATE trc20_token_clone.treasury_withdrawal_requests SET status='broadcast-accepted'")) {
        state.row.status = 'broadcast-accepted'
        state.row.updated_at = new Date()
        return { rows: [state.row] }
      }
      if (q.startsWith("UPDATE trc20_token_clone.treasury_withdrawal_requests SET status='broadcast-unknown'")) {
        state.row.status = 'broadcast-unknown'
        state.row.failure_code = params[1] || 'broadcast-outcome-unknown'
        return { rows: [] }
      }
      if (q.startsWith("UPDATE trc20_token_clone.treasury_withdrawal_requests SET status='rejected'")) {
        state.row.status = 'rejected'
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
      fromPrivateKey: () => realTreasuryAddress,
      toHex: value => addresses.get(value) || '',
    },
    contract: () => ({ at: async () => contract }),
    trx: {
      getBalance: async () => trxBalance,
      sign: async transaction => ({ ...transaction, signature: ['mock-signature'] }),
      sendRawTransaction: async transaction => {
        state.sends += 1
        state.txIdWasPersistedBeforeBroadcast = state.row?.transaction_hash === payoutTxId
          && transaction?.txID === payoutTxId
        return { result: true, txid: payoutTxId }
      },
    },
    transactionBuilder: {
      triggerSmartContract: async (_contract, _method, _options, parameters, sender) => {
        const recipient = String(parameters[0].value)
        const amount = BigInt(String(parameters[1].value)).toString(16).padStart(64, '0')
        const recipientHex = addresses.get(recipient).slice(2).padStart(64, '0')
        return {
          result: { result: true },
          transaction: {
            txID: payoutTxId,
            raw_data_hex: payoutTxRawHex,
            raw_data: { contract: [{
              type: 'TriggerSmartContract',
              parameter: { value: {
                owner_address: addresses.get(sender),
                contract_address: addresses.get(officialUsdtAddress),
                data: 'a9059cbb' + recipientHex + amount,
              } },
            }] },
          },
        }
      },
    },
  }
  const env = {
    DATABASE_URL: 'postgres://test-only',
    TREASURY_WITHDRAWALS_ENABLED: 'true',
    TREASURY_SIGNER_MODE: 'env-hot-wallet',
    TREASURY_OWNER_ADDRESS: realOwnerAddress,
    TREASURY_ADDRESS: realTreasuryAddress,
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
      address: realOwnerAddress, network: 'mainnet', origin: 'https://owner.example',
    } }),
    tronWebFactory: () => tronWeb,
    readOnlyTronWebFactory: () => tronWeb,
    databaseProvider: () => db,
    prepareDatabase: async () => {},
  }))
  return { app, state, txid: payoutTxId }
}

test('treasury transaction intent guard requires the exact sender, official contract, recipient, and amount', () => {
  const addresses = new Map([
    [realTreasuryAddress, '41' + '44'.repeat(20)],
    [realRecipientAddress, '41' + '22'.repeat(20)],
    [officialUsdtAddress, '41' + '33'.repeat(20)],
  ])
  const tronWeb = { address: { toHex: value => addresses.get(value) || '' } }
  const data = 'a9059cbb' + addresses.get(realRecipientAddress).slice(2).padStart(64, '0')
    + BigInt(amountBaseUnits).toString(16).padStart(64, '0')
  const transaction = {
    txID: payoutTxId,
    raw_data_hex: payoutTxRawHex,
    raw_data: { contract: [{
      type: 'TriggerSmartContract',
      parameter: { value: {
        owner_address: addresses.get(realTreasuryAddress),
        contract_address: addresses.get(officialUsdtAddress),
        data,
      } },
    }] },
  }
  assert.equal(assertTreasuryPayoutTransactionIntent(tronWeb, transaction, {
    treasuryAddress: realTreasuryAddress,
    recipientAddress: realRecipientAddress,
    amountBaseUnits,
  }), true)
  assert.throws(() => assertTreasuryPayoutTransactionIntent(tronWeb, {
    ...transaction,
    raw_data: { contract: [{ ...transaction.raw_data.contract[0], parameter: { value: {
      ...transaction.raw_data.contract[0].parameter.value, data: data.slice(0, -1) + '0',
    } } }] },
  }, {
    treasuryAddress: realTreasuryAddress,
    recipientAddress: realRecipientAddress,
    amountBaseUnits,
  }), /recipient or amount/)
  assert.throws(() => assertTreasuryPayoutTransactionIntent(tronWeb, {
    ...transaction, raw_data: { contract: [...transaction.raw_data.contract, transaction.raw_data.contract[0]] },
  }, {
    treasuryAddress: realTreasuryAddress, recipientAddress: realRecipientAddress, amountBaseUnits,
  }), /malformed/)
})

test('treasury payout signs from the separate funded treasury and persists the txid before broadcast', async (t) => {
  const harness = createPayoutTestHarness()
  const server = createServer(harness.app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const endpoint = `http://127.0.0.1:${server.address().port}/api/treasury/withdrawals`
  const headers = {
    origin: 'https://owner.example',
    authorization: 'Bearer ' + 'A'.repeat(43),
    'content-type': 'application/json',
  }
  const request = {
    recipientAddress: realRecipientAddress, amountUsdt: '1.25',
    idempotencyKey: 'withdrawal-integration-test-00001',
  }
  const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(request) })
  const payload = await response.json()
  assert.equal(response.status, 202)
  assert.equal(payload.status, 'broadcast-accepted')
  assert.equal(payload.withdrawal.treasuryAddress, realTreasuryAddress)
  assert.equal(payload.withdrawal.transactionHash, harness.txid)
  assert.equal(harness.state.txIdWasPersistedBeforeBroadcast, true)
  assert.equal(harness.state.sends, 1)

  const duplicate = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(request) })
  assert.equal(duplicate.status, 200)
  assert.equal((await duplicate.json()).duplicate, true)
  assert.equal(harness.state.sends, 1)

  const pendingResponse = await fetch(endpoint.replace('/withdrawals', '/withdrawals/pending'), { headers: {
    origin: 'https://owner.example', authorization: headers.authorization,
  } })
  const pendingPayload = await pendingResponse.json()
  assert.equal(pendingResponse.status, 200)
  assert.equal(pendingPayload.withdrawal.idempotencyKey, request.idempotencyKey)

  const overlapping = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({
    recipientAddress: realRecipientAddress, amountUsdt: '0.5',
    idempotencyKey: 'withdrawal-second-pending-payout-0001',
  }) })
  assert.equal(overlapping.status, 409)
  assert.equal((await overlapping.json()).error, 'pending-withdrawal-requires-reconciliation')
  assert.equal(harness.state.sends, 1)

  const conflict = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({
    ...request, recipientAddress: realOwnerAddress,
  }) })
  assert.equal(conflict.status, 409)
  assert.equal((await conflict.json()).error, 'idempotency-key-conflict')
  assert.equal(harness.state.sends, 1)
})

test('treasury payout fails closed when on-chain USDT balance is insufficient', async (t) => {
  const harness = createPayoutTestHarness({ usdtBalance: '0' })
  const server = createServer(harness.app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/treasury/withdrawals`, {
    method: 'POST',
    headers: {
      origin: 'https://owner.example',
      authorization: 'Bearer ' + 'A'.repeat(43),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      recipientAddress: realRecipientAddress,
      amountUsdt: '1.25',
      idempotencyKey: 'withdrawal-insufficient-funds-001',
    }),
  })
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error, 'treasury-usdt-insufficient')
  assert.equal(harness.state.sends, 0)
  assert.equal(harness.state.row, null)
})

test('owner payout readiness remains disabled without the minimum TRX reserve configuration', async (t) => {
  const app = express()
  app.use(express.json())
  app.use('/api/treasury', createTreasuryWithdrawalsRouter({
    env: { TREASURY_OWNER_ADDRESS: realOwnerAddress },
    sessionLookup: async () => ({ success: true, session: {
      address: realOwnerAddress, network: 'mainnet', origin: 'https://owner.example',
    } }),
    databaseProvider: () => ({ query: async () => ({ rows: [] }) }),
    prepareDatabase: async () => {},
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/treasury/withdrawals/readiness`, {
    headers: { origin: 'https://owner.example', authorization: 'Bearer ' + 'A'.repeat(43) },
  })
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.withdrawalsEnabled, false)
  assert.ok(payload.configuration.missing.includes('TREASURY_MIN_TRX_RESERVE'))
})
