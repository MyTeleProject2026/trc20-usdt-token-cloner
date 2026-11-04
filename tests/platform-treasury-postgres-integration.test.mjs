import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import express from 'express'
import pg from 'pg'
import { createPlatformTreasuryRouter } from '../server/routes/platform-treasury-withdrawals.mjs'

const { Pool } = pg
const enabled = process.env.SPONSOR_PG_INTEGRATION === '1'
const databaseUrl = process.env.DATABASE_URL || ''
const owner = 'T' + 'A'.repeat(33)
const treasury = 'T' + 'B'.repeat(33)
const recipient = 'T' + 'C'.repeat(33)
const officialUsdt = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const origin = 'https://owner.example'
const bearer = 'B'.repeat(43)

function assertDedicatedTestDatabase(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('Platform treasury PostgreSQL integration requires a valid DATABASE_URL')
  }
  const databaseName = decodeURIComponent(parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname)
  if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) || databaseName !== 'sponsor_test') {
    throw new Error('Refusing platform treasury integration tests unless DATABASE_URL targets the local dedicated sponsor_test database')
  }
}

if (enabled) assertDedicatedTestDatabase(databaseUrl)

function createTestTronWeb() {
  const hexByAddress = new Map([
    [owner, '41' + '1'.repeat(40)],
    [treasury, '41' + '2'.repeat(40)],
    [recipient, '41' + '3'.repeat(40)],
    [officialUsdt, '41' + '4'.repeat(40)],
  ])
  const addressByHex = new Map([...hexByAddress].map(([address, hex]) => [hex, address]))
  const tronWeb = {
    isAddress: () => true,
    address: {
      toHex: (address) => hexByAddress.get(address) || '',
      fromHex: (hex) => addressByHex.get(String(hex).replace(/^0x/i, '')) || '',
    },
    contract: () => ({
      decimals: () => ({ call: async () => 6 }),
      symbol: () => ({ call: async () => 'USDT' }),
      balanceOf: () => ({ call: async () => '1000000000' }),
    }),
    trx: {
      getBalance: async () => '10000000000',
      getChainParameters: async () => [{ key: 'getEnergyFee', value: 420 }],
    },
    transactionBuilder: {
      triggerConstantContract: async () => ({
        result: { result: true },
        energy_used: 10000,
        transaction: { ret: [{ contractRet: 'SUCCESS' }] },
      }),
      estimateEnergy: async () => ({ result: { result: true }, energy_required: 10000 }),
      triggerSmartContract: async (_contract, _method, _options, parameters, from) => {
        const receiver = String(parameters[0].value)
        const amount = String(parameters[1].value)
        const receiverHex = hexByAddress.get(receiver)
        const senderHex = hexByAddress.get(from)
        const contractHex = hexByAddress.get(officialUsdt)
        const data = 'a9059cbb'
          + receiverHex.slice(2).padStart(64, '0')
          + BigInt(amount).toString(16).padStart(64, '0')
        const rawData = {
          contract: [{
            type: 'TriggerSmartContract',
            parameter: { value: { owner_address: senderHex, contract_address: contractHex, data } },
          }],
          timestamp: Date.now(),
          expiration: Date.now() + 120000,
        }
        const rawDataHex = Buffer.from(JSON.stringify(rawData), 'utf8').toString('hex')
        const txID = createHash('sha256').update(Buffer.from(rawDataHex, 'hex')).digest('hex')
        return { result: { result: true }, transaction: { txID, raw_data_hex: rawDataHex, raw_data: rawData } }
      },
    },
  }
  return tronWeb
}

function startApp(pool) {
  const app = express()
  app.use(express.json())
  app.use('/api/treasury', createPlatformTreasuryRouter({
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      OWNER_WALLET_ADDRESS: owner,
      TREASURY_OWNER_ADDRESS: owner,
      PLATFORM_TREASURY_ADDRESS: treasury,
      PLATFORM_TREASURY_MAX_PAYOUT_USDT: '50',
      PLATFORM_TREASURY_DAILY_LIMIT_USDT: '200',
      PLATFORM_TREASURY_MAX_FEE_SUN: '50000000',
      PLATFORM_TREASURY_SELF_CUSTODY_ENABLED: 'true',
    },
    sessionLookup: async ({ origin: requestOrigin }) => ({
      success: true,
      session: { address: owner, network: 'mainnet', origin: requestOrigin },
    }),
    tronWebFactory: createTestTronWeb,
    poolFactory: () => pool,
    isValidAddress: () => true,
  }))
  const server = createServer(app)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
      })
    })
  })
}

async function stopServer(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

async function ownerRequest(baseUrl, path, init = {}) {
  return fetch(baseUrl + path, {
    ...init,
    headers: {
      Origin: origin,
      Authorization: 'Bearer ' + bearer,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  })
}

test('PostgreSQL persists self-custody withdrawal replay and browser-refresh recovery under concurrent prepare requests', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async (t) => {
  assertDedicatedTestDatabase(databaseUrl)
  const pool = new Pool({ connectionString: databaseUrl, max: 4 })
  const requestKey = randomUUID()
  let appServer

  try {
    const dbIdentity = await pool.query('SELECT current_database() AS name')
    assert.equal(dbIdentity.rows[0].name, 'sponsor_test', 'integration test must only touch the isolated sponsor_test database')

    const app = await startApp(pool)
    appServer = app.server

    const makePrepareRequest = (amountUsdt = '1.25') => ownerRequest(app.baseUrl, '/api/treasury/self-custody/prepare', {
      method: 'POST',
      body: JSON.stringify({ requestKey, recipientAddress: recipient, amountUsdt }),
    })
    const [firstResponse, concurrentResponse] = await Promise.all([
      makePrepareRequest(),
      makePrepareRequest(),
    ])
    const [first, concurrent] = await Promise.all([firstResponse.json(), concurrentResponse.json()])

    assert.ok([201, 200].includes(firstResponse.status), JSON.stringify(first))
    assert.ok([201, 200].includes(concurrentResponse.status), JSON.stringify(concurrent))
    assert.equal(first.success, true)
    assert.equal(concurrent.success, true)
    assert.equal(first.intent.intentId, concurrent.intent.intentId, 'concurrent retries must return the same persisted intent')
    assert.ok(first.unsignedTransaction?.txID)
    assert.equal(concurrent.unsignedTransaction.txID, first.unsignedTransaction.txID)

    const persisted = await pool.query(
      'SELECT intent_id::text, request_key, status, amount_base_units::text FROM trc20_token_clone.platform_treasury_withdrawals WHERE owner_address=$1 AND request_key=$2',
      [owner, requestKey],
    )
    assert.equal(persisted.rowCount, 1, 'one and only one reservation must exist for concurrent same-key requests')
    assert.equal(persisted.rows[0].intent_id, first.intent.intentId)
    assert.equal(persisted.rows[0].status, 'prepared')
    assert.equal(persisted.rows[0].amount_base_units, '1250000')

    const replayResponse = await makePrepareRequest()
    const replay = await replayResponse.json()
    assert.equal(replayResponse.status, 200)
    assert.equal(replay.intent.intentId, first.intent.intentId)

    const changedDetailsResponse = await makePrepareRequest('1.26')
    const changedDetails = await changedDetailsResponse.json()
    assert.equal(changedDetailsResponse.status, 409)
    assert.equal(changedDetails.error, 'withdrawal-request-key-reused-with-different-details')

    const anotherRequestResponse = await ownerRequest(app.baseUrl, '/api/treasury/self-custody/prepare', {
      method: 'POST',
      body: JSON.stringify({
        requestKey: randomUUID(),
        recipientAddress: recipient,
        amountUsdt: '2',
      }),
    })
    const anotherRequest = await anotherRequestResponse.json()
    assert.equal(anotherRequestResponse.status, 409)
    assert.equal(anotherRequest.error, 'withdrawal-already-outstanding')
    assert.equal(anotherRequest.intentId, first.intent.intentId)

    const historyResponse = await ownerRequest(app.baseUrl, '/api/treasury/self-custody/withdrawals?limit=20')
    const history = await historyResponse.json()
    assert.equal(historyResponse.status, 200)
    assert.equal(history.hasOutstandingWithdrawal, true)
    const recovered = history.withdrawals.find((item) => item.intent.intentId === first.intent.intentId)
    assert.ok(recovered, 'history endpoint must return the saved intent')
    assert.equal(recovered.intent.status, 'prepared')
    assert.equal(recovered.unsignedTransaction.txID, first.unsignedTransaction.txID)

    // Simulate a backend process restart: create a fresh router instance over
    // the same PostgreSQL database and recover the exact same prepared request.
    await stopServer(appServer)
    appServer = null
    const restartedApp = await startApp(pool)
    appServer = restartedApp.server
    const restartedHistoryResponse = await ownerRequest(restartedApp.baseUrl, '/api/treasury/self-custody/withdrawals?limit=20')
    const restartedHistory = await restartedHistoryResponse.json()
    assert.equal(restartedHistoryResponse.status, 200)
    assert.equal(restartedHistory.hasOutstandingWithdrawal, true)
    const afterRestart = restartedHistory.withdrawals.find((item) => item.intent.intentId === first.intent.intentId)
    assert.ok(afterRestart)
    assert.equal(afterRestart.intent.intentId, recovered.intent.intentId)
    assert.equal(afterRestart.unsignedTransaction.txID, recovered.unsignedTransaction.txID)

    const invalidLimitResponse = await ownerRequest(restartedApp.baseUrl, '/api/treasury/self-custody/withdrawals?limit=1000')
    assert.equal(invalidLimitResponse.status, 400)
    assert.equal((await invalidLimitResponse.json()).error, 'invalid-withdrawal-history-limit')
  } finally {
    if (appServer) await stopServer(appServer).catch(() => {})
    await pool.query(
      'DELETE FROM trc20_token_clone.platform_treasury_withdrawals WHERE owner_address=$1 AND request_key=$2',
      [owner, requestKey],
    ).catch(() => {})
    await pool.end()
  }
})
