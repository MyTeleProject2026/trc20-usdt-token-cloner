import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import express from 'express'
import { createServer } from 'node:http'
import { createMainnetDirectSponsorRequestRouter, OFFICIAL_MAINNET_USDT_CONTRACT } from '../server/routes/mainnet-direct-sponsor-requests.mjs'

const requester = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const otherRequester = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const recipient = 'TTGhREx2pDSxFX555NWz1YwGpiBVPvQA7e'
const sponsorAddress = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
const feeSponsorAddress = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const sponsorOrgRef = 'SPONSOR-ORG-DIRECT-2026'
const sponsorAgreementRef = 'SPONSOR-AGREEMENT-DIRECT-2026'
const sponsorAgreementSha256 = 'a'.repeat(64)
const approvalNonce = 'c'.repeat(64)
const approvalSignature = '0x' + 'b'.repeat(130)
const approvalEnv = {
  SPONSOR_ASSET_MAINNET_ADDRESS: sponsorAddress,
  SPONSOR_MAINNET_DIRECT_ORGANIZATION_REFERENCE: sponsorOrgRef,
  SPONSOR_MAINNET_DIRECT_AGREEMENT_REFERENCE: sponsorAgreementRef,
  SPONSOR_MAINNET_DIRECT_AGREEMENT_SHA256: sponsorAgreementSha256,
  SPONSOR_MAINNET_DIRECT_MAX_PAYOUT_USDT_BASE_UNITS: '250000000',
  SPONSOR_APPROVED_AGREEMENT_REFERENCES: [
    [sponsorAgreementRef, sponsorOrgRef, 'mainnet', sponsorAddress, 'asset-grant', 'USDT', OFFICIAL_MAINNET_USDT_CONTRACT].join('|'),
  ].join(';'),
}
const token = 'A'.repeat(43)
const adminToken = 'admin-token-for-mainnet-sponsor-review-only-012345'
const key = 'mainnet-direct-usdt-request-000001'

function makeStore() {
  const rows = new Map()
  const challenges = new Map()
  const approvals = new Map()
  return {
    rows,
    async createRequest(input) {
      const old = rows.get(input.idempotencyKey)
      if (old) {
        const same = old.requesterAddress === input.requesterAddress
          && old.recipientAddress === input.recipientAddress
          && old.tokenContract === input.tokenContract
          && old.amountBaseUnits === input.amountBaseUnits
          && old.decimals === input.decimals
        return same ? { success: true, duplicate: true, request: old }
          : { success: false, reason: 'idempotency-key-conflict' }
      }
      const request = {
        id: String(rows.size + 1),
        idempotencyKey: input.idempotencyKey,
        requesterAddress: input.requesterAddress,
        recipientAddress: input.recipientAddress,
        network: 'mainnet',
        asset: 'USDT',
        tokenContract: input.tokenContract,
        amountBaseUnits: input.amountBaseUnits,
        decimals: input.decimals,
        status: 'pending-sponsor-review',
        createdAt: new Date().toISOString(),
      }
      rows.set(input.idempotencyKey, request)
      return { success: true, duplicate: false, request }
    },
    async findRequest(requestKey, address) {
      const row = rows.get(requestKey)
      if (!row || row.requesterAddress !== address) return { success: false, reason: 'request-not-found' }
      return { success: true, request: row, sponsorApproval: approvals.get(requestKey) || null }
    },
    async findRequestForSponsor(requestKey) {
      const row = rows.get(requestKey)
      return row ? { success: true, request: row } : { success: false, reason: 'request-not-found' }
    },
    async listRequests() {
      return {
        success: true,
        requests: [...rows.values()].map(({ requesterAddress, ...row }) => ({ ...row, requesterAddress })),
      }
    },
    async createApprovalChallenge(input) {
      const request = rows.get(input.idempotencyKey)
      if (!request) return { success: false, reason: 'request-not-found-or-not-reviewable' }
      const active = approvals.get(input.idempotencyKey)
      if (active && Date.parse(active.expiresAt) > Date.parse(input.issuedAt)) {
        return { success: false, reason: 'request-already-has-active-sponsor-approval' }
      }
      const opened = [...challenges.values()].some(item =>
        item.idempotencyKey === input.idempotencyKey && !item.consumed
        && Date.parse(item.expiresAt) > Date.parse(input.issuedAt))
      if (opened) return { success: false, reason: 'approval-challenge-already-open' }
      const challenge = {
        ...input,
        requestId: request.id,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
        consumed: false,
      }
      challenges.set(input.nonceHash, challenge)
      return { success: true, challengeId: input.challengeId, request }
    },
    async consumeApprovalChallenge({ nonceHash, sponsorAddress: signer, origin, nowMs }) {
      const challenge = challenges.get(nonceHash)
      if (!challenge || challenge.consumed || challenge.sponsorAddress !== signer
        || challenge.origin !== origin || Date.parse(challenge.expiresAt) <= nowMs) {
        return { success: false, reason: 'approval-challenge-invalid-expired-or-replayed' }
      }
      challenge.consumed = true
      const request = rows.get(challenge.idempotencyKey)
      return {
        success: true,
        challenge: {
          challengeId: challenge.challengeId,
          sponsorAddress: challenge.sponsorAddress,
          origin: challenge.origin,
          messageSha256: challenge.messageSha256,
          requestSnapshotSha256: challenge.requestSnapshotSha256,
          organizationReference: challenge.policy.organizationReference,
          agreementReference: challenge.policy.agreementReference,
          agreementSha256: challenge.policy.agreementDocumentSha256,
          issuedAt: challenge.issuedAt,
          expiresAt: challenge.expiresAt,
          consumedAt: new Date(nowMs).toISOString(),
          requestId: challenge.requestId,
        },
        request,
      }
    },
    async recordSponsorApproval(input) {
      const old = approvals.get(input.challengeId)
      if (old && Date.parse(old.expiresAt) > Date.parse(input.approvedAt)) {
        return { success: false, reason: 'request-already-has-active-sponsor-approval' }
      }
      const approval = {
        id: String(approvals.size + 1),
        requestId: input.requestId,
        sponsorAddress: input.sponsorAddress,
        organizationReference: input.organizationReference,
        agreementReference: input.agreementReference,
        agreementSha256: input.agreementSha256,
        messageSha256: input.messageSha256,
        approvedAt: input.approvedAt,
        expiresAt: input.expiresAt,
      }
      approvals.set(rows.get([...rows.keys()].find(key => rows.get(key).id === input.requestId))?.idempotencyKey, approval)
      approvals.set(input.challengeId, approval)
      return { success: true, approval }
    },
    async listSponsorReviewQueue() {
      return {
        success: true,
        requests: [...rows.entries()].map(([key, request]) => ({
          ...request,
          sponsorApproval: approvals.get(key)
            ? { status: Date.parse(approvals.get(key).expiresAt) > Date.now() ? 'approved-active' : 'approved-expired', ...approvals.get(key) }
            : { status: 'not-approved' },
        })),
      }
    },
  }
}

function sessionLookup

function sessionLookup(address = requester, network = 'mainnet') {
  return async ({ tokenHash, origin }) => {
    assert.match(tokenHash, /^[0-9a-f]{64}$/)
    return {
      success: true,
      session: { address, network, origin, expiresAt: Date.now() + 60_000 },
    }
  }
}

async function serve(t, router) {
  const app = express()
  app.use(express.json({ limit: '32kb' }))
  app.use('/api/tron', router)
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  return `http://127.0.0.1:${server.address().port}/api/tron`
}

function headers(origin = 'https://trc20-usdt-token-cloner.onrender.com') {
  return { origin, authorization: 'Bearer ' + token, 'content-type': 'application/json' }
}

function requestBody(overrides = {}) {
  return {
    idempotencyKey: key,
    recipientAddress: recipient,
    tokenContract: OFFICIAL_MAINNET_USDT_CONTRACT,
    amountBaseUnits: '12500000',
    decimals: 6,
    ...overrides,
  }
}

test('Mainnet request requires a Mainnet authenticated wallet identity', async (t) => {
  const base = await serve(t, createMainnetDirectSponsorRequestRouter({
    env: {},
    store: makeStore(),
    sessionLookup: sessionLookup(requester, 'nile'),
  }))
  const response = await fetch(base + '/sponsorship/mainnet-direct/requests', {
    method: 'POST', headers: headers(), body: JSON.stringify(requestBody()),
  })
  assert.equal(response.status, 403)
  assert.equal((await response.json()).error, 'mainnet-wallet-session-required')
})

test('Mainnet direct request persists exact official USDT recipient and amount without creating a payout', async (t) => {
  const store = makeStore()
  const base = await serve(t, createMainnetDirectSponsorRequestRouter({
    env: {},
    store,
    sessionLookup: sessionLookup(),
  }))
  const response = await fetch(base + '/sponsorship/mainnet-direct/requests', {
    method: 'POST', headers: headers(), body: JSON.stringify(requestBody()),
  })
  const payload = await response.json()
  assert.equal(response.status, 201)
  assert.equal(payload.status, 'pending-sponsor-review')
  assert.equal(payload.request.network, 'mainnet')
  assert.equal(payload.request.asset, 'USDT')
  assert.equal(payload.request.tokenContract, OFFICIAL_MAINNET_USDT_CONTRACT)
  assert.equal(payload.request.amountBaseUnits, '12500000')
  assert.equal(payload.request.decimals, 6)
  assert.equal(payload.sponsorApproved, false)
  assert.equal(payload.budgetReserved, false)
  assert.equal(payload.signingIntentCreated, false)
  assert.equal(payload.canSubmitSponsoredTransfer, false)
  assert.equal(payload.transactionBroadcast, false)
  assert.equal(payload.unpaidFallbackToUserFunds, false)
})

test('same idempotency key returns the original request; changed recipient/amount conflicts', async (t) => {
  const store = makeStore()
  const base = await serve(t, createMainnetDirectSponsorRequestRouter({
    env: {},
    store,
    sessionLookup: sessionLookup(),
  }))
  const first = await fetch(base + '/sponsorship/mainnet-direct/requests', {
    method: 'POST', headers: headers(), body: JSON.stringify(requestBody()),
  })
  assert.equal(first.status, 201)
  const duplicate = await fetch(base + '/sponsorship/mainnet-direct/requests', {
    method: 'POST', headers: headers(), body: JSON.stringify(requestBody()),
  })
  assert.equal(duplicate.status, 200)
  assert.equal((await duplicate.json()).duplicate, true)
  const conflict = await fetch(base + '/sponsorship/mainnet-direct/requests', {
    method: 'POST', headers: headers(), body: JSON.stringify(requestBody({ amountBaseUnits: '15000000' })),
  })
  assert.equal(conflict.status, 409)
  assert.equal((await conflict.json()).error, 'idempotency-key-conflict')
})

test('Mainnet request validates official contract, decimals, amount and recipient', async (t) => {
  const base = await serve(t, createMainnetDirectSponsorRequestRouter({
    env: {},
    store: makeStore(),
    sessionLookup: sessionLookup(),
  }))
  const cases = [
    [{ tokenContract: recipient }, 400],
    [{ decimals: 18 }, 400],
    [{ amountBaseUnits: '0' }, 400],
    [{ amountBaseUnits: '1.5' }, 400],
    [{ recipientAddress: requester }, 400],
    [{ unexpected: 'field' }, 400],
  ]
  for (const [overrides, expected] of cases) {
    const response = await fetch(base + '/sponsorship/mainnet-direct/requests', {
      method: 'POST', headers: headers(), body: JSON.stringify(requestBody(overrides)),
    })
    assert.equal(response.status, expected)
  }
})

test('request lookup is requester-scoped and returns no transaction or signature claims', async (t) => {
  const store = makeStore()
  const base = await serve(t, createMainnetDirectSponsorRequestRouter({
    env: {},
    store,
    sessionLookup: async ({ tokenHash, origin }) => ({
      success: true,
      session: {
        address: origin === 'https://other.example' ? otherRequester : requester,
        network: 'mainnet', origin, expiresAt: Date.now() + 60_000,
      },
    }),
  }))
  const created = await fetch(base + '/sponsorship/mainnet-direct/requests', {
    method: 'POST', headers: headers(), body: JSON.stringify(requestBody()),
  })
  assert.equal(created.status, 201)
  const found = await fetch(base + '/sponsorship/mainnet-direct/requests/' + key, { headers: headers() })
  assert.equal(found.status, 200)
  const payload = await found.json()
  assert.equal(payload.request.status, 'pending-sponsor-review')
  assert.equal(payload.transactionBroadcast, false)
  const denied = await fetch(base + '/sponsorship/mainnet-direct/requests/' + key, {
    headers: headers('https://other.example'),
  })
  assert.equal(denied.status, 404)
})

test('sponsor review queue requires server-only admin token and remains review-only', async (t) => {
  const store = makeStore()
  const base = await serve(t, createMainnetDirectSponsorRequestRouter({
    env: { SPONSOR_ADMIN_API_TOKEN: adminToken },
    store,
    sessionLookup: sessionLookup(),
  }))
  const created = await fetch(base + '/sponsorship/mainnet-direct/requests', {
    method: 'POST', headers: headers(), body: JSON.stringify(requestBody()),
  })
  assert.equal(created.status, 201)
  const denied = await fetch(base + '/sponsorship/mainnet-direct/requests')
  assert.equal(denied.status, 401)
  const allowed = await fetch(base + '/sponsorship/mainnet-direct/requests?limit=20', {
    headers: { authorization: 'Bearer ' + adminToken },
  })
  const payload = await allowed.json()
  assert.equal(allowed.status, 200)
  assert.equal(payload.count, 1)
  assert.equal(payload.requests[0].requesterAddress, requester)
  assert.equal(payload.sponsorApprovalEnabled, false)
  assert.equal(payload.canSubmitSponsoredTransfer, false)
  assert.equal(payload.transactionBroadcast, false)
})

test('Mainnet direct sponsor request router is mounted under the TRON API', async () => {
  const source = await readFile(new URL('../server/index.mjs', import.meta.url), 'utf8')
  assert.match(source, /import mainnetDirectSponsorRequestRoutes from '\.\/routes\/mainnet-direct-sponsor-requests\.mjs'/)
  assert.match(source, /app\.use\('\/api\/tron', mainnetDirectSponsorRequestRoutes\)/)
})
