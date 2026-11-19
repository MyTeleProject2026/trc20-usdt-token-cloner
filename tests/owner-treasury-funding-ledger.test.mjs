import test from 'node:test'
import assert from 'node:assert/strict'
import { createOwnerTreasuryFundingLedgerRouter, calculateTreasuryAvailableBaseUnits } from '../server/routes/owner-treasury-funding-ledger.mjs'

const ownerAddress = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const treasuryAddress = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
const senderAddress = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const transactionHash = 'a'.repeat(64)
const tokenContract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const origin = 'https://tron-transfer.integration.test'
const ownerToken = 'o'.repeat(43)

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this },
    setHeader(name, value) { this.headers[name] = value },
    json(value) { this.body = value; return this },
  }
}

function request({ token = ownerToken, network = 'mainnet', body = {} } = {}) {
  return {
    query: { network },
    body,
    headers: { origin, authorization: token ? 'Bearer ' + token : '' },
  }
}

function routeHandler(router, path, method) {
  const layer = router.stack.find((item) => item.route?.path === path && item.route.methods?.[method])
  assert.ok(layer, method.toUpperCase() + ' ' + path + ' is registered')
  return layer.route.stack[0].handle
}

function fundingSnapshot(balanceBaseUnits = '75000000') {
  return {
    onChainBalanceRead: true,
    network: 'mainnet',
    sponsorAddress: treasuryAddress,
    native: { status: 'verified', balanceSun: '12000000', balanceTRX: '12' },
    tokens: [{
      asset: 'USDT',
      tokenContract,
      status: 'verified',
      decimals: 6,
      balanceBaseUnits,
    }],
  }
}

function fakeDatabase({ insertRowCount = 1, existing = null } = {}) {
  const calls = []
  const db = {
    calls,
    async query(sql, values = []) {
      calls.push({ sql, values })
      if (sql.startsWith('INSERT INTO trc20_token_clone.owner_treasury_verified_inflows')) {
        return { rowCount: insertRowCount, rows: insertRowCount ? [{ id: 1 }] : [] }
      }
      if (sql.includes('FROM trc20_token_clone.owner_treasury_verified_inflows WHERE transaction_hash')) {
        return { rowCount: existing ? 1 : 0, rows: existing ? [existing] : [] }
      }
      if (sql.includes('FROM trc20_token_clone.owner_treasury_verified_inflows') && sql.includes('ORDER BY created_at')) {
        return { rowCount: 0, rows: [] }
      }
      if (sql.includes('SUM(amount_base_units)') && sql.includes('owner_treasury_verified_inflows')) {
        return { rowCount: 1, rows: [{ total: '125000000' }] }
      }
      if (sql.includes('SUM(amount_base_units)') && sql.includes('sponsor_direct_payouts')) {
        return { rowCount: 1, rows: [{ reserved: '25000000' }] }
      }
      return { rowCount: 0, rows: [] }
    },
  }
  return db
}

function makeRouter({ db = fakeDatabase(), verification = null, ownerSession = true, funding = fundingSnapshot() } = {}) {
  return {
    db,
    router: createOwnerTreasuryFundingLedgerRouter({
      env: {
        TREASURY_OWNER_ADDRESS: ownerAddress,
        TREASURY_MAINNET_ADDRESS: treasuryAddress,
        FRONTEND_ORIGIN: origin,
      },
      getSession: async ({ tokenHash, origin: receivedOrigin }) => {
        assert.match(tokenHash, /^[0-9a-f]{64}$/)
        assert.equal(receivedOrigin, origin)
        return ownerSession
          ? { success: true, session: { address: ownerAddress, network: 'mainnet', origin } }
          : { success: true, session: null }
      },
      getDatabase: () => db,
      readFunding: async (network) => {
        assert.equal(network, 'mainnet')
        return funding
      },
      verifyTransfer: async (_env, input) => {
        assert.deepEqual(input, {
          transactionHash,
          from: senderAddress,
          to: treasuryAddress,
          amountBaseUnits: '25000000',
        })
        return verification || { verified: false, status: 'awaiting-solidified-receipt' }
      },
      isValidAddress: (value) => [ownerAddress, treasuryAddress, senderAddress].includes(value),
      now: () => Date.parse('2026-11-06T00:00:00.000Z'),
    }),
  }
}

test('treasury available balance subtracts live reservations and never becomes negative', () => {
  assert.equal(calculateTreasuryAvailableBaseUnits('100000000', '25000000'), '75000000')
  assert.equal(calculateTreasuryAvailableBaseUnits('1000000', '1000000'), '0')
  assert.equal(calculateTreasuryAvailableBaseUnits('1000000', '2000000'), '0')
  assert.throws(() => calculateTreasuryAvailableBaseUnits('-1', '0'))
  assert.throws(() => calculateTreasuryAvailableBaseUnits('1.5', '0'))
})

test('owner funding ledger requires the configured Mainnet owner session', async () => {
  const { router } = makeRouter({ ownerSession: false })
  const handler = routeHandler(router, '/funding-ledger', 'get')
  const response = responseRecorder()
  await handler(request(), response)
  assert.equal(response.statusCode, 401)
  assert.equal(response.body.error, 'owner-session-invalid-or-expired')
  assert.equal(response.body.submissionEnabled, false)
})

test('owner funding ledger reports verified on-chain balance less active payout reservations', async () => {
  const { router } = makeRouter()
  const handler = routeHandler(router, '/funding-ledger', 'get')
  const response = responseRecorder()
  await handler(request(), response)
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.status, 'verified-mainnet-treasury-funding-ledger')
  assert.equal(response.body.onChainBalanceBaseUnits, '75000000')
  assert.equal(response.body.reservedBaseUnits, '25000000')
  assert.equal(response.body.availableBaseUnits, '50000000')
  assert.equal(response.body.totalVerifiedInboundBaseUnits, '125000000')
  assert.equal(response.body.fundingVerified, true)
  assert.equal(response.body.payoutSubmissionEnabled, false)
})

test('funding ledger fails closed if current on-chain balance cannot be verified', async () => {
  const { router } = makeRouter({ funding: { onChainBalanceRead: false, network: 'mainnet', sponsorAddress: treasuryAddress } })
  const handler = routeHandler(router, '/funding-ledger', 'get')
  const response = responseRecorder()
  await handler(request(), response)
  assert.equal(response.statusCode, 503)
  assert.equal(response.body.error, 'treasury-on-chain-balance-unavailable')
  assert.equal(response.body.submissionEnabled, false)
})

test('an unconfirmed incoming transfer is never credited to the treasury ledger', async () => {
  const db = fakeDatabase()
  const { router } = makeRouter({ db })
  const handler = routeHandler(router, '/funding-ledger/deposits/verify', 'post')
  const response = responseRecorder()
  await handler(request({
    body: { network: 'mainnet', transactionHash, fromAddress: senderAddress, amount: '25' },
  }), response)
  assert.equal(response.statusCode, 409)
  assert.equal(response.body.credited, false)
  assert.equal(db.calls.some((call) => call.sql.startsWith('INSERT INTO')), false)
})

test('an exact solidified Mainnet USDT inflow is recorded once with event-level idempotency', async () => {
  const db = fakeDatabase()
  const verified = {
    verified: true,
    transactionHash,
    contract: tokenContract,
    from: senderAddress,
    to: treasuryAddress,
    amountBaseUnits: '25000000',
    blockNumber: 123456,
    logIndex: 2,
  }
  const { router } = makeRouter({ db, verification: verified })
  const handler = routeHandler(router, '/funding-ledger/deposits/verify', 'post')
  const response = responseRecorder()
  await handler(request({
    body: { network: 'mainnet', transactionHash, fromAddress: senderAddress, amount: '25' },
  }), response)
  assert.equal(response.statusCode, 201)
  assert.equal(response.body.success, true)
  assert.equal(response.body.credited, true)
  assert.equal(response.body.duplicate, false)
  assert.equal(response.body.entry.tokenContract, tokenContract)
  assert.equal(response.body.entry.amountBaseUnits, '25000000')
  assert.equal(db.calls.filter((call) => call.sql.startsWith('INSERT INTO trc20_token_clone.owner_treasury_verified_inflows')).length, 1)
})

test('a replayed exact deposit event is returned as already recorded, not credited twice', async () => {
  const existing = {
    transaction_hash: transactionHash,
    log_index: 2,
    from_address: senderAddress,
    treasury_address: treasuryAddress,
    amount_base_units: '25000000',
    block_number: 123456,
  }
  const db = fakeDatabase({ insertRowCount: 0, existing })
  const verified = {
    verified: true,
    transactionHash,
    contract: tokenContract,
    from: senderAddress,
    to: treasuryAddress,
    amountBaseUnits: '25000000',
    blockNumber: 123456,
    logIndex: 2,
  }
  const { router } = makeRouter({ db, verification: verified })
  const handler = routeHandler(router, '/funding-ledger/deposits/verify', 'post')
  const response = responseRecorder()
  await handler(request({
    body: { network: 'mainnet', transactionHash, fromAddress: senderAddress, amount: '25' },
  }), response)
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.credited, true)
  assert.equal(response.body.duplicate, true)
})

test('deposit verification rejects self-transfers and malformed amounts before provider calls', async () => {
  const db = fakeDatabase()
  const { router } = makeRouter({ db })
  const handler = routeHandler(router, '/funding-ledger/deposits/verify', 'post')
  const self = responseRecorder()
  await handler(request({
    body: { network: 'mainnet', transactionHash, fromAddress: treasuryAddress, amount: '25' },
  }), self)
  assert.equal(self.statusCode, 400)
  assert.equal(self.body.credited, false)
  const malformed = responseRecorder()
  await handler(request({
    body: { network: 'mainnet', transactionHash, fromAddress: senderAddress, amount: '1e6' },
  }), malformed)
  assert.equal(malformed.statusCode, 400)
  assert.equal(db.calls.some((call) => call.sql.startsWith('INSERT INTO')), false)
})
