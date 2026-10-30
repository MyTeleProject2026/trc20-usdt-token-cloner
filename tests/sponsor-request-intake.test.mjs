import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { createSponsorRequestIntakeRouter } from '../server/routes/sponsor-request-intake.mjs'

const requesterAddress = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const recipientAddress = 'TTGhREx2pDSxFX555NWz1YwGpiBVPvQA7e'
const tokenContract = 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj'
const sessionToken = 'S'.repeat(43)
const adminToken = 'admin-token-for-test-only-0123456789'

function createMemoryStore() {
  const rows = new Map()
  function same(row, input) {
    return row.requesterAddress === input.requesterAddress
      && row.network === input.network
      && row.recipientAddress === input.recipientAddress
      && row.asset === input.asset
      && row.tokenContract === input.tokenContract
      && row.amountBaseUnits === input.amountBaseUnits
      && row.decimals === input.decimals
  }
  return {
    rows,
    async createRequest(input) {
      const existing = rows.get(input.idempotencyKey)
      if (existing) return same(existing, input)
        ? { success: true, duplicate: true, request: existing }
        : { success: false, reason: 'idempotency-key-conflict' }
      const request = {
        id: String(rows.size + 1),
        idempotencyKey: input.idempotencyKey,
        requesterAddress: input.requesterAddress,
        network: input.network,
        recipientAddress: input.recipientAddress,
        asset: input.asset,
        tokenContract: input.tokenContract,
        amountBaseUnits: input.amountBaseUnits,
        decimals: input.decimals,
        status: 'pending-organization-review',
        createdAt: new Date('2026-10-30T00:00:00.000Z').toISOString(),
      }
      rows.set(input.idempotencyKey, request)
      return { success: true, duplicate: false, request }
    },
    async findRequest(key, address, network) {
      const request = rows.get(key)
      return request && request.requesterAddress === address && request.network === network
        ? { success: true, request }
        : { success: false, reason: 'request-not-found' }
    },
    async listRequests({ network, limit }) {
      return {
        success: true,
        requests: [...rows.values()]
          .filter((row) => !network || row.network === network)
          .slice(0, limit),
      }
    },
  }
}

async function serve(t, router) {
  const app = express()
  app.use(express.json())
  app.use('/api/tron', router)
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  return `http://127.0.0.1:${server.address().port}/api/tron`
}

function sessionLookup() {
  return async ({ origin }) => ({
    success: true,
    session: {
      address: requesterAddress,
      network: 'nile',
      origin,
    },
  })
}

function requestBody(overrides = {}) {
  return {
    idempotencyKey: 'request-key-000000000000000001',
    network: 'nile',
    recipientAddress,
    asset: 'TRX',
    amountBaseUnits: '2500000',
    decimals: 6,
    ...overrides,
  }
}

function userHeaders() {
  return {
    origin: 'https://owner.example',
    authorization: 'Bearer ' + sessionToken,
    'content-type': 'application/json',
  }
}

test('request intake requires a live testnet wallet session', async (t) => {
  const store = createMemoryStore()
  const base = await serve(t, createSponsorRequestIntakeRouter({
    env: { SPONSOR_USDT_NILE_CONTRACTS: tokenContract },
    store,
    sessionLookup: async () => ({ success: true, session: null }),
  }))
  const response = await fetch(base + '/sponsorship/requests', {
    method: 'POST',
    headers: { origin: 'https://owner.example', 'content-type': 'application/json' },
    body: JSON.stringify(requestBody()),
  })
  assert.equal(response.status, 401)
  assert.equal((await response.json()).error, 'wallet-session-required')
  assert.equal(store.rows.size, 0)
})

test('request intake is testnet-scoped and binds the request to the authenticated wallet network', async (t) => {
  const store = createMemoryStore()
  const base = await serve(t, createSponsorRequestIntakeRouter({
    env: { SPONSOR_USDT_NILE_CONTRACTS: tokenContract },
    store,
    sessionLookup: sessionLookup(),
  }))
  const response = await fetch(base + '/sponsorship/requests', {
    method: 'POST',
    headers: userHeaders(),
    body: JSON.stringify(requestBody({ network: 'mainnet' })),
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error, 'invalid-testnet-sponsor-request')
  assert.equal(store.rows.size, 0)
})

test('request intake rejects testnet TRC-20 contracts instead of representing them as genuine Tether USDT', async (t) => {
  const store = createMemoryStore()
  const base = await serve(t, createSponsorRequestIntakeRouter({
    env: { SPONSOR_USDT_NILE_CONTRACTS: tokenContract },
    store,
    sessionLookup: sessionLookup(),
  }))
  const response = await fetch(base + '/sponsorship/requests', {
    method: 'POST',
    headers: userHeaders(),
    body: JSON.stringify(requestBody({ asset: 'TRC20', tokenContract: requesterAddress })),
  })
  assert.equal(response.status, 422)
  assert.equal((await response.json()).error, 'official-usdt-mainnet-only')
  assert.equal(store.rows.size, 0)
})


test('request intake rejects both configured USDT-like and VTRC testnet contracts', async (t) => {
  const store = createMemoryStore()
  const base = await serve(t, createSponsorRequestIntakeRouter({
    env: {
      SPONSOR_USDT_NILE_CONTRACTS: tokenContract,
      SPONSOR_VTRC_NILE_CONTRACTS: tokenContract,
    },
    store,
    sessionLookup: sessionLookup(),
  }))
  for (const contractSource of ['USDT', 'VTRC']) {
    const response = await fetch(base + '/sponsorship/requests', {
      method: 'POST',
      headers: userHeaders(),
      body: JSON.stringify(requestBody({
        asset: 'TRC20',
        tokenContract,
        idempotencyKey: `reject-${contractSource}-request-00000000000001`,
      })),
    })
    assert.equal(response.status, 422)
    assert.equal((await response.json()).error, 'official-usdt-mainnet-only')
  }
  assert.equal(store.rows.size, 0)
})

test('request intake persists an authenticated native-TRX testnet request without approving or submitting a transfer', async (t) => {
  const store = createMemoryStore()
  const base = await serve(t, createSponsorRequestIntakeRouter({
    env: { SPONSOR_USDT_NILE_CONTRACTS: tokenContract },
    store,
    sessionLookup: sessionLookup(),
  }))
  const response = await fetch(base + '/sponsorship/requests', {
    method: 'POST',
    headers: userHeaders(),
    body: JSON.stringify(requestBody()),
  })
  const payload = await response.json()
  assert.equal(response.status, 201)
  assert.equal(payload.success, true)
  assert.equal(payload.status, 'pending-organization-review')
  assert.equal(payload.request.requesterAddress, requesterAddress)
  assert.equal(payload.request.recipientAddress, recipientAddress)
  assert.equal(payload.request.asset, 'TRX')
  assert.equal(payload.request.tokenContract, null)
  assert.equal(payload.request.amountBaseUnits, '2500000')
  assert.equal(payload.payoutAuthorized, false)
  assert.equal(payload.canSubmitSponsoredTransfer, false)
  assert.equal(payload.submissionEnabled, false)
  assert.equal(payload.providerSubmissionAttempted, false)
  assert.equal(payload.transactionBroadcast, false)
  assert.equal(JSON.stringify(payload).includes(sessionToken), false)
  assert.equal(store.rows.size, 1)
})

test('request idempotency returns the same request and rejects a conflicting reuse', async (t) => {
  const store = createMemoryStore()
  const base = await serve(t, createSponsorRequestIntakeRouter({
    env: { SPONSOR_USDT_NILE_CONTRACTS: tokenContract },
    store,
    sessionLookup: sessionLookup(),
  }))
  const first = await fetch(base + '/sponsorship/requests', {
    method: 'POST', headers: userHeaders(), body: JSON.stringify(requestBody()),
  })
  assert.equal(first.status, 201)
  const duplicate = await fetch(base + '/sponsorship/requests', {
    method: 'POST', headers: userHeaders(), body: JSON.stringify(requestBody()),
  })
  assert.equal(duplicate.status, 200)
  assert.equal((await duplicate.json()).duplicate, true)
  const conflict = await fetch(base + '/sponsorship/requests', {
    method: 'POST', headers: userHeaders(), body: JSON.stringify(requestBody({ amountBaseUnits: '2500001' })),
  })
  assert.equal(conflict.status, 409)
  assert.equal((await conflict.json()).error, 'idempotency-key-conflict')
  assert.equal(store.rows.size, 1)
})

test('requester can retrieve only their own testnet request', async (t) => {
  const store = createMemoryStore()
  const base = await serve(t, createSponsorRequestIntakeRouter({
    env: { SPONSOR_USDT_NILE_CONTRACTS: tokenContract },
    store,
    sessionLookup: sessionLookup(),
  }))
  await fetch(base + '/sponsorship/requests', {
    method: 'POST', headers: userHeaders(), body: JSON.stringify(requestBody()),
  })
  const found = await fetch(base + '/sponsorship/requests/request-key-000000000000000001', { headers: userHeaders() })
  assert.equal(found.status, 200)
  assert.equal((await found.json()).request.status, 'pending-organization-review')
  const denied = await serve(t, createSponsorRequestIntakeRouter({
    env: { SPONSOR_USDT_NILE_CONTRACTS: tokenContract },
    store,
    sessionLookup: async ({ origin }) => ({
      success: true,
      session: { address: recipientAddress, network: 'nile', origin },
    }),
  }))
  const notOwner = await fetch(denied + '/sponsorship/requests/request-key-000000000000000001', {
    headers: userHeaders(),
  })
  assert.equal(notOwner.status, 404)
})

test('sponsor organization queue requires the server-only admin token and stays non-executable', async (t) => {
  const store = createMemoryStore()
  store.rows.set('key-000000000000000000000001', {
    id: '1', idempotencyKey: 'key-000000000000000000000001',
    requesterAddress, network: 'nile', recipientAddress,
    asset: 'TRX', tokenContract: null, amountBaseUnits: '5000000', decimals: 6,
    status: 'pending-organization-review', createdAt: '2026-10-30T00:00:00.000Z',
  })
  const base = await serve(t, createSponsorRequestIntakeRouter({
    env: { SPONSOR_ADMIN_API_TOKEN: adminToken },
    store,
    sessionLookup: sessionLookup(),
  }))
  const denied = await fetch(base + '/sponsorship/requests?network=nile')
  assert.equal(denied.status, 401)
  const allowed = await fetch(base + '/sponsorship/requests?network=nile', {
    headers: { authorization: 'Bearer ' + adminToken },
  })
  const payload = await allowed.json()
  assert.equal(allowed.status, 200)
  assert.equal(payload.count, 1)
  assert.equal(payload.requests[0].status, 'pending-organization-review')
  assert.equal(payload.submissionEnabled, false)
  assert.equal(payload.providerSubmissionAttempted, false)
  assert.equal(payload.transactionBroadcast, false)
})
