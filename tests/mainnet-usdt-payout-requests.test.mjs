import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import {
  OFFICIAL_TRON_MAINNET_USDT,
  buildTreasuryPayoutRequestMessage,
  parseUsdtAmountBaseUnits,
  isPayoutRequestExpiryValid,
} from '../src/treasury-payout-request-auth.mjs'
import { createMainnetUsdtPayoutRequestRouter } from '../server/routes/mainnet-usdt-payout-requests.mjs'

const requesterAddress = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const recipientAddress = 'TTGhREx2pDSxFX555NWz1YwGpiBVPvQA7e'
const sessionToken = 'S'.repeat(43)
const reviewToken = 'treasury-review-token-test-only-0123456789'
const signature = '0x' + 'a'.repeat(130)
const fixedNow = 1_800_000_000_000
const origin = 'https://trc20-usdt-token-cloner.onrender.com'
const idempotencyKey = 'mainnet-usdt-request-key-000001'

function createMemoryStore() {
  const rows = new Map()
  return {
    rows,
    async createRequest(input) {
      const existing = rows.get(input.idempotencyKey)
      if (existing) {
        const same = existing.requesterAddress === input.requesterAddress
          && existing.recipientAddress === input.recipientAddress
          && existing.amountBaseUnits === input.amountBaseUnits
        return same
          ? { success: true, duplicate: true, request: existing }
          : { success: false, reason: 'idempotency-key-conflict' }
      }
      const request = {
        id: String(rows.size + 1),
        idempotencyKey: input.idempotencyKey,
        network: 'mainnet',
        asset: 'Tether USDT',
        tokenContract: OFFICIAL_TRON_MAINNET_USDT,
        decimals: 6,
        requesterAddress: input.requesterAddress,
        recipientAddress: input.recipientAddress,
        amountBaseUnits: input.amountBaseUnits,
        status: 'pending-organization-review',
        createdAt: new Date(fixedNow).toISOString(),
        expiresAt: input.requestExpiresAt,
      }
      rows.set(input.idempotencyKey, request)
      return { success: true, duplicate: false, request }
    },
    async findRequest(key, address) {
      const request = rows.get(key)
      return request?.requesterAddress === address
        ? { success: true, request }
        : { success: false, reason: 'request-not-found' }
    },
    async listRequests({ limit }) {
      return { success: true, requests: [...rows.values()].slice(0, limit) }
    },
  }
}

function validEnv(overrides = {}) {
  return {
    OWNER_WALLET_ADDRESS: requesterAddress,
    TREASURY_OWNER_ADDRESS: requesterAddress,
    TREASURY_PAYOUT_REVIEW_API_TOKEN: reviewToken,
    ...overrides,
  }
}

function sessionLookup({ address = requesterAddress, network = 'mainnet' } = {}) {
  return async ({ origin: suppliedOrigin }) => ({
    success: true,
    session: { address, network, origin: suppliedOrigin },
  })
}

function body(overrides = {}) {
  return {
    idempotencyKey,
    recipientAddress,
    amountUsdt: '12.500001',
    requestExpiresAt: fixedNow + 60_000,
    ownerRequestSignature: signature,
    ...overrides,
  }
}

function userHeaders() {
  return {
    origin,
    authorization: 'Bearer ' + sessionToken,
    'content-type': 'application/json',
  }
}

async function serve(t, router) {
  const app = express()
  app.use(express.json())
  app.use('/api/treasury', router)
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  return 'http://127.0.0.1:' + server.address().port + '/api/treasury'
}

function createRouter(options = {}) {
  const store = options.store || createMemoryStore()
  const seenMessages = []
  const router = createMainnetUsdtPayoutRequestRouter({
    env: validEnv(options.env),
    store,
    sessionLookup: options.sessionLookup || sessionLookup(),
    now: () => fixedNow,
    messageVerifier: async (message, suppliedSignature, expectedAddress) => {
      seenMessages.push(message)
      return suppliedSignature === signature
        && expectedAddress === requesterAddress
        && message.includes('Network: TRON Mainnet')
        && message.includes('Token contract: ' + OFFICIAL_TRON_MAINNET_USDT)
        && message.includes('Purpose: request independent organization review only.')
    },
  })
  return { router, store, seenMessages }
}

test('USDT amount parsing is fixed to six decimals and rejects invalid precision and zero', () => {
  assert.equal(parseUsdtAmountBaseUnits('12.5'), '12500000')
  assert.equal(parseUsdtAmountBaseUnits('0.000001'), '1')
  assert.throws(() => parseUsdtAmountBaseUnits('0'), /greater than zero/)
  assert.throws(() => parseUsdtAmountBaseUnits('1.0000001'), /six decimal/)
  assert.throws(() => parseUsdtAmountBaseUnits('1e3'), /six decimal/)
  assert.throws(() => parseUsdtAmountBaseUnits('01'), /six decimal/)
})

test('request signature is domain-separated and explicitly review-only', () => {
  const message = buildTreasuryPayoutRequestMessage({
    origin,
    requesterAddress,
    recipientAddress,
    amountBaseUnits: '12500000',
    idempotencyKey,
    requestExpiresAt: fixedNow + 60_000,
  })
  assert.match(message, /TRON Mainnet/)
  assert.match(message, new RegExp(OFFICIAL_TRON_MAINNET_USDT))
  assert.match(message, /request independent organization review only/)
  assert.match(message, /does not authorize, sign, create, or broadcast/)
  assert.equal(isPayoutRequestExpiryValid(fixedNow + 60_000, fixedNow), true)
  assert.equal(isPayoutRequestExpiryValid(fixedNow + 121_000, fixedNow), false)
})

test('request requires configured unified owner and an authenticated Mainnet wallet session', async (t) => {
  const { router, store } = createRouter({
    sessionLookup: async () => ({ success: true, session: null }),
  })
  const baseUrl = await serve(t, router)
  const response = await fetch(baseUrl + '/payout-requests', {
    method: 'POST',
    headers: userHeaders(),
    body: JSON.stringify(body()),
  })
  assert.equal(response.status, 401)
  assert.equal((await response.json()).error, 'invalid-or-expired-owner-session')
  assert.equal(store.rows.size, 0)
})

test('request rejects a testnet session and never accepts Nile/Shasta', async (t) => {
  const { router, store } = createRouter({
    sessionLookup: sessionLookup({ network: 'nile' }),
  })
  const baseUrl = await serve(t, router)
  const response = await fetch(baseUrl + '/payout-requests', {
    method: 'POST',
    headers: userHeaders(),
    body: JSON.stringify(body()),
  })
  assert.equal(response.status, 403)
  assert.equal((await response.json()).error, 'treasury-owner-only')
  assert.equal(store.rows.size, 0)
})

test('request rejects a split owner configuration', async (t) => {
  const { router, store } = createRouter({
    env: { OWNER_WALLET_ADDRESS: recipientAddress },
  })
  const baseUrl = await serve(t, router)
  const response = await fetch(baseUrl + '/payout-requests', {
    method: 'POST',
    headers: userHeaders(),
    body: JSON.stringify(body()),
  })
  assert.equal(response.status, 503)
  assert.equal((await response.json()).error, 'unified-owner-address-configuration-required')
  assert.equal(store.rows.size, 0)
})

test('request accepts only six-decimal official Tether USDT on TRON Mainnet and stores a review-only record', async (t) => {
  const { router, store, seenMessages } = createRouter()
  const baseUrl = await serve(t, router)
  const response = await fetch(baseUrl + '/payout-requests', {
    method: 'POST',
    headers: userHeaders(),
    body: JSON.stringify(body()),
  })
  const payload = await response.json()
  assert.equal(response.status, 201)
  assert.equal(payload.success, true)
  assert.equal(payload.status, 'pending-organization-review')
  assert.equal(payload.request.network, 'mainnet')
  assert.equal(payload.request.asset, 'Tether USDT')
  assert.equal(payload.request.tokenContract, OFFICIAL_TRON_MAINNET_USDT)
  assert.equal(payload.request.decimals, 6)
  assert.equal(payload.request.amountBaseUnits, '12500001')
  assert.equal(payload.payoutAuthorized, false)
  assert.equal(payload.transferSubmissionEnabled, false)
  assert.equal(payload.providerSubmissionAttempted, false)
  assert.equal(payload.transactionCreated, false)
  assert.equal(payload.transactionBroadcast, false)
  assert.equal(store.rows.size, 1)
  assert.equal(seenMessages.length, 1)
})

test('request rejects arbitrary token contracts, VTRC fields, and extra execution flags', async (t) => {
  const { router, store } = createRouter()
  const baseUrl = await serve(t, router)
  for (const extra of [
    { tokenContract: recipientAddress },
    { asset: 'VTRC' },
    { network: 'nile' },
    { execute: true },
    { fireblocksApiKey: 'fake' },
  ]) {
    const response = await fetch(baseUrl + '/payout-requests', {
      method: 'POST',
      headers: userHeaders(),
      body: JSON.stringify(body(extra)),
    })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error, 'unexpected-request-fields')
  }
  assert.equal(store.rows.size, 0)
})

test('request rejects invalid owner signatures and expired signatures', async (t) => {
  const invalidSignature = createRouter()
  const invalidBase = await serve(t, invalidSignature.router)
  const rejected = await fetch(invalidBase + '/payout-requests', {
    method: 'POST',
    headers: userHeaders(),
    body: JSON.stringify(body({ ownerRequestSignature: '0x' + 'b'.repeat(130) })),
  })
  assert.equal(rejected.status, 403)
  assert.equal((await rejected.json()).error, 'owner-request-signature-invalid')

  const expired = createRouter()
  const expiredBase = await serve(t, expired.router)
  const stale = await fetch(expiredBase + '/payout-requests', {
    method: 'POST',
    headers: userHeaders(),
    body: JSON.stringify(body({ requestExpiresAt: fixedNow - 1 })),
  })
  assert.equal(stale.status, 401)
  assert.equal((await stale.json()).error, 'payout-request-signature-expired-or-outside-window')
})

test('idempotency returns the same exact request and rejects conflicting key reuse', async (t) => {
  const { router, store } = createRouter()
  const baseUrl = await serve(t, router)
  const first = await fetch(baseUrl + '/payout-requests', {
    method: 'POST', headers: userHeaders(), body: JSON.stringify(body()),
  })
  assert.equal(first.status, 201)
  const duplicate = await fetch(baseUrl + '/payout-requests', {
    method: 'POST', headers: userHeaders(), body: JSON.stringify(body()),
  })
  assert.equal(duplicate.status, 200)
  assert.equal((await duplicate.json()).duplicate, true)
  const conflict = await fetch(baseUrl + '/payout-requests', {
    method: 'POST', headers: userHeaders(), body: JSON.stringify(body({ amountUsdt: '12.500002' })),
  })
  assert.equal(conflict.status, 409)
  assert.equal((await conflict.json()).error, 'idempotency-key-conflict')
  assert.equal(store.rows.size, 1)
})

test('requester can retrieve only their own payout request', async (t) => {
  const { router } = createRouter()
  const baseUrl = await serve(t, router)
  await fetch(baseUrl + '/payout-requests', {
    method: 'POST', headers: userHeaders(), body: JSON.stringify(body()),
  })
  const response = await fetch(baseUrl + '/payout-requests/' + idempotencyKey, { headers: userHeaders() })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).request.tokenContract, OFFICIAL_TRON_MAINNET_USDT)

  const otherRequester = createRouter({
    sessionLookup: sessionLookup({ address: recipientAddress }),
  })
  const otherBase = await serve(t, otherRequester.router)
  const notOwner = await fetch(otherBase + '/payout-requests/' + idempotencyKey, { headers: userHeaders() })
  assert.equal(notOwner.status, 403)
})

test('organization review queue uses a separate server-only token and cannot approve or broadcast', async (t) => {
  const { router, store } = createRouter()
  const baseUrl = await serve(t, router)
  await fetch(baseUrl + '/payout-requests', {
    method: 'POST', headers: userHeaders(), body: JSON.stringify(body()),
  })

  const denied = await fetch(baseUrl + '/payout-requests')
  assert.equal(denied.status, 401)
  const allowed = await fetch(baseUrl + '/payout-requests?limit=50', {
    headers: { authorization: 'Bearer ' + reviewToken },
  })
  const payload = await allowed.json()
  assert.equal(allowed.status, 200)
  assert.equal(payload.network, 'mainnet')
  assert.equal(payload.asset, 'official-tether-usdt-trc20')
  assert.equal(payload.count, 1)
  assert.equal(payload.requests[0].tokenContract, OFFICIAL_TRON_MAINNET_USDT)
  assert.equal(payload.transferSubmissionEnabled, false)
  assert.equal(payload.providerSubmissionAttempted, false)
  assert.equal(payload.transactionBroadcast, false)
  assert.equal(store.rows.size, 1)
})
