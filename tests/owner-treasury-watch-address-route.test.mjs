import test from 'node:test'
import assert from 'node:assert/strict'
import { createOwnerTreasuryFundingLedgerRouter } from '../server/routes/owner-treasury-funding-ledger.mjs'

const ownerAddress = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const treasuryAddress = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
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

function routeHandler(router, path, method) {
  const layer = router.stack.find((item) => item.route?.path === path && item.route.methods?.[method])
  assert.ok(layer, method.toUpperCase() + ' ' + path + ' is registered')
  return layer.route.stack[0].handle
}

function makeRouter({ ownerSession = true, readWatchAddresses = async () => ({ network: 'mainnet', addresses: [] }) } = {}) {
  let databaseCalls = 0
  let observerCalls = 0
  const router = createOwnerTreasuryFundingLedgerRouter({
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
    getDatabase: () => { databaseCalls += 1; return null },
    readWatchAddresses: async () => { observerCalls += 1; return readWatchAddresses() },
    isValidAddress: (value) => [ownerAddress, treasuryAddress].includes(value),
  })
  return { router, get databaseCalls() { return databaseCalls }, get observerCalls() { return observerCalls } }
}

function request(network = 'mainnet') {
  return {
    query: { network },
    headers: { origin, authorization: 'Bearer ' + ownerToken },
  }
}

test('watch-address endpoint is owner-session protected and mainnet-only', async () => {
  const unauthenticated = makeRouter({ ownerSession: false })
  const denied = responseRecorder()
  await routeHandler(unauthenticated.router, '/funding-ledger/watch-addresses', 'get')(request(), denied)
  assert.equal(denied.statusCode, 401)
  assert.equal(unauthenticated.observerCalls, 0)

  const wrongNetwork = makeRouter()
  const rejected = responseRecorder()
  await routeHandler(wrongNetwork.router, '/funding-ledger/watch-addresses', 'get')(request('nile'), rejected)
  assert.equal(rejected.statusCode, 400)
  assert.equal(wrongNetwork.observerCalls, 0)
})

test('watch-address endpoint returns observations but never reads or mutates treasury accounting', async () => {
  const payload = {
    network: 'mainnet',
    tokenContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    decimals: 6,
    ownershipVerified: false,
    ledgerMutationPerformed: false,
    spendableBalanceImpact: 'none',
    payoutSubmissionEnabled: false,
    addresses: [
      { address: 'TU3kjFuhtEo42tsCBtfYUAZxoqQ4yuSLQ5', ownershipStatus: 'not-verified', observations: [] },
      { address: 'THPvaUhoh2Qn2y9THCZML3H815hhFhn5YC', ownershipStatus: 'not-verified', observations: [] },
    ],
  }
  const instance = makeRouter({ readWatchAddresses: async () => payload })
  const res = responseRecorder()
  await routeHandler(instance.router, '/funding-ledger/watch-addresses', 'get')(request(), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.status, 'read-only-external-address-observations')
  assert.equal(res.body.ownershipVerified, false)
  assert.equal(res.body.ledgerMutationPerformed, false)
  assert.equal(res.body.spendableBalanceImpact, 'none')
  assert.equal(res.body.payoutSubmissionEnabled, false)
  assert.equal(res.body.addresses.length, 2)
  assert.equal(instance.databaseCalls, 0)
  assert.equal(instance.observerCalls, 1)
  assert.equal(Object.hasOwn(res.body, 'availableBaseUnits'), false)
  assert.equal(Object.hasOwn(res.body, 'availableForPayout'), false)
  assert.equal(Object.hasOwn(res.body, 'fundingVerified'), false)
})

test('observer failures fail closed and do not touch accounting storage', async () => {
  const instance = makeRouter({ readWatchAddresses: async () => { throw new Error('provider unavailable') } })
  const res = responseRecorder()
  await routeHandler(instance.router, '/funding-ledger/watch-addresses', 'get')(request(), res)
  assert.equal(res.statusCode, 503)
  assert.equal(res.body.spendableBalanceImpact, 'none')
  assert.equal(res.body.ledgerMutationPerformed, false)
  assert.equal(instance.databaseCalls, 0)
})
