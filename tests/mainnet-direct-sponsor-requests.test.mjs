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
const feeSponsorAddress = otherRequester
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
const feeOrgRef = 'SPONSOR-FEE-ORG-DIRECT-2026'
const feeAgreementRef = 'SPONSOR-FEE-AGREEMENT-DIRECT-2026'
const feeAgreementSha256 = 'd'.repeat(64)
const feeApprovalEnv = {
  ...approvalEnv,
  SPONSOR_FEE_MAINNET_ADDRESS: feeSponsorAddress,
  SPONSOR_MAINNET_DIRECT_FEE_ORGANIZATION_REFERENCE: feeOrgRef,
  SPONSOR_MAINNET_DIRECT_FEE_AGREEMENT_REFERENCE: feeAgreementRef,
  SPONSOR_MAINNET_DIRECT_FEE_AGREEMENT_SHA256: feeAgreementSha256,
  SPONSOR_MAINNET_DIRECT_MAX_FEE_SUN: '50000000',
  SPONSOR_APPROVED_AGREEMENT_REFERENCES: [
    [sponsorAgreementRef, sponsorOrgRef, 'mainnet', sponsorAddress, 'asset-grant', 'USDT', OFFICIAL_MAINNET_USDT_CONTRACT].join('|'),
    [feeAgreementRef, feeOrgRef, 'mainnet', feeSponsorAddress, 'network-fee', 'TRX', '-'].join('|'),
  ].join(';'),
}
const token = 'A'.repeat(43)
const adminToken = 'admin-token-for-mainnet-sponsor-review-only-012345'
const key = 'mainnet-direct-usdt-request-000001'

function makeStore() {
  const rows = new Map()
  const challenges = new Map()
  const approvals = new Map()
  const feeChallenges = new Map()
  const feeApprovals = new Map()
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
      const principal = approvals.get(requestKey) || null
      const fee = feeApprovals.get(requestKey) || null
      const withStatus = (approval) => approval
        ? { ...approval, status: Date.parse(approval.expiresAt) > Date.now() ? 'approved-active' : 'approved-expired' }
        : { status: 'not-approved' }
      return { success: true, request: row, sponsorApproval: withStatus(principal), feeSponsorApproval: withStatus(fee) }
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
      const requestKey = [...rows.entries()].find(([, request]) => request.id === input.requestId)?.[0]
      if (!requestKey) return { success: false, reason: 'request-no-longer-reviewable' }
      const old = approvals.get(requestKey)
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
      approvals.set(requestKey, approval)
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
    async createFeeApprovalChallenge(input) {
      const request = rows.get(input.idempotencyKey)
      const principal = approvals.get(input.idempotencyKey)
      if (!request || !principal || Date.parse(principal.expiresAt) <= Date.parse(input.issuedAt)) {
        return { success: false, reason: 'active-asset-principal-approval-required-before-fee-approval' }
      }
      const oldFee = feeApprovals.get(input.idempotencyKey)
      if (oldFee && Date.parse(oldFee.expiresAt) > Date.parse(input.issuedAt)) {
        return { success: false, reason: 'request-already-has-active-fee-sponsor-approval' }
      }
      const open = [...feeChallenges.values()].some(item => item.idempotencyKey === input.idempotencyKey
        && !item.consumed && Date.parse(item.expiresAt) > Date.parse(input.issuedAt))
      if (open) return { success: false, reason: 'fee-approval-challenge-already-open' }
      feeChallenges.set(input.nonceHash, { ...input, consumed: false, principalApprovalId: principal.id })
      return { success: true, challengeId: input.challengeId, request, principalApprovalId: principal.id }
    },
    async consumeFeeApprovalChallenge({ nonceHash, sponsorAddress: signer, origin, nowMs }) {
      const challenge = feeChallenges.get(nonceHash)
      if (!challenge || challenge.consumed || challenge.sponsorAddress !== signer || challenge.origin !== origin
        || Date.parse(challenge.expiresAt) <= nowMs) {
        return { success: false, reason: 'fee-approval-challenge-invalid-expired-or-replayed' }
      }
      const request = rows.get(challenge.idempotencyKey)
      const principal = approvals.get(challenge.idempotencyKey)
      if (!request || !principal || principal.id !== challenge.principalApprovalId || Date.parse(principal.expiresAt) <= nowMs) {
        return { success: false, reason: 'active-asset-principal-approval-no-longer-valid' }
      }
      challenge.consumed = true
      return {
        success: true,
        challenge: {
          challengeId: challenge.challengeId,
          sponsorAddress: challenge.sponsorAddress,
          origin: challenge.origin,
          messageSha256: challenge.messageSha256,
          requestSnapshotSha256: challenge.requestSnapshotSha256,
          organizationReference: challenge.feePolicy.organizationReference,
          agreementReference: challenge.feePolicy.agreementReference,
          agreementSha256: challenge.feePolicy.agreementDocumentSha256,
          maxFeeSun: challenge.feePolicy.maxFeeSun,
          issuedAt: challenge.issuedAt,
          expiresAt: challenge.expiresAt,
          consumedAt: new Date(nowMs).toISOString(),
          requestId: request.id,
          principalApprovalId: principal.id,
        },
        request,
      }
    },
    async recordFeeSponsorApproval(input) {
      const requestKey = [...rows.entries()].find(([, row]) => row.id === input.requestId)?.[0]
      const principal = requestKey ? approvals.get(requestKey) : null
      if (!principal || principal.id !== input.principalApprovalId || Date.parse(principal.expiresAt) <= Date.parse(input.approvedAt)) {
        return { success: false, reason: 'active-asset-principal-approval-required' }
      }
      const previous = feeApprovals.get(requestKey)
      if (previous && Date.parse(previous.expiresAt) > Date.parse(input.approvedAt)) {
        return { success: false, reason: 'request-already-has-active-fee-sponsor-approval' }
      }
      const challenge = [...feeChallenges.values()].find(item => item.challengeId === input.challengeId)
      if (!challenge?.consumed) return { success: false, reason: 'fee-approval-challenge-not-consumed' }
      const approval = {
        id: String(feeApprovals.size + 1),
        requestId: input.requestId,
        principalApprovalId: input.principalApprovalId,
        sponsorAddress: input.sponsorAddress,
        organizationReference: input.organizationReference,
        agreementReference: input.agreementReference,
        agreementSha256: input.agreementSha256,
        messageSha256: input.messageSha256,
        maxFeeSun: input.maxFeeSun,
        approvedAt: input.approvedAt,
        expiresAt: input.expiresAt,
      }
      feeApprovals.set(requestKey, approval)
      return { success: true, approval }
    },
    async listFeeSponsorReviewQueue() {
      return {
        success: true,
        requests: [...rows.entries()].map(([key, request]) => ({
          ...request,
          sponsorApproval: approvals.get(key) ? { status: Date.parse(approvals.get(key).expiresAt) > Date.now() ? 'approved-active' : 'approved-expired' } : { status: 'not-approved' },
          feeSponsorApproval: feeApprovals.get(key) ? { status: Date.parse(feeApprovals.get(key).expiresAt) > Date.now() ? 'approved-active' : 'approved-expired', ...feeApprovals.get(key) } : { status: 'not-approved' },
        })),
      }
    },
  }
}

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

function fundedSponsorRoleSnapshot() {
  return {
    success: true,
    checkedAt: new Date().toISOString(),
    configuredAddressesDistinct: true,
    roles: {
      networkFeeSponsor: {
        address: feeSponsorAddress,
        onChainBalanceRead: true,
        native: { status: 'verified', balanceSun: '100000000' },
        resourceStatus: { resourceRead: true },
      },
      assetPrincipalSponsor: {
        address: sponsorAddress,
        onChainBalanceRead: true,
        tokenBalancesComplete: true,
        tokens: [{
          asset: 'USDT',
          tokenContract: OFFICIAL_MAINNET_USDT_CONTRACT,
          status: 'verified',
          decimals: 6,
          balanceBaseUnits: '500000000',
        }],
      },
    },
    feeSponsorDelegationToPrincipal: {
      success: true,
      transactionAuditVerified: true,
      auditedResourceTypes: ['ENERGY', 'BANDWIDTH'],
      activeEnergyStakeSun: '1000000',
      activeBandwidthStakeSun: '1000000',
    },
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


test('only the configured Mainnet asset-principal sponsor wallet can open its review queue', async (t) => {
  let roleReads = 0
  const base = await serve(t, createMainnetDirectSponsorRequestRouter({
    env: approvalEnv,
    store: makeStore(),
    sessionLookup: sessionLookup(requester),
    readSponsorRoles: async () => { roleReads += 1; return fundedSponsorRoleSnapshot() },
  }))
  const response = await fetch(base + '/sponsorship/mainnet-direct/review-queue', { headers: headers() })
  assert.equal(response.status, 403)
  assert.equal((await response.json()).error, 'wallet-is-not-the-configured-mainnet-asset-principal-sponsor')
  assert.equal(roleReads, 0)
})

test('Mainnet sponsor approval requires an exact agreement scope and all organization policy references', async (t) => {
  const store = makeStore()
  const base = await serve(t, createMainnetDirectSponsorRequestRouter({
    env: { ...approvalEnv, SPONSOR_APPROVED_AGREEMENT_REFERENCES: '' },
    store,
    sessionLookup: sessionLookup(sponsorAddress),
    readSponsorRoles: async () => fundedSponsorRoleSnapshot(),
  }))
  const response = await fetch(base + '/sponsorship/mainnet-direct/review-queue', {
    headers: headers(),
  })
  assert.equal(response.status, 503)
  assert.equal((await response.json()).error, 'mainnet-direct-sponsor-approval-policy-not-configured')
})

test('sponsor signs one exact request message and approval never enables transaction execution', async (t) => {
  const store = makeStore()
  const requesterBase = await serve(t, createMainnetDirectSponsorRequestRouter({
    env: approvalEnv, store, sessionLookup: sessionLookup(requester),
  }))
  const created = await fetch(requesterBase + '/sponsorship/mainnet-direct/requests', {
    method: 'POST', headers: headers(), body: JSON.stringify(requestBody()),
  })
  assert.equal(created.status, 201)

  let verifiedMessage = ''
  const nowMs = Date.now()
  const base = await serve(t, createMainnetDirectSponsorRequestRouter({
    env: approvalEnv,
    store,
    sessionLookup: sessionLookup(sponsorAddress),
    readSponsorRoles: async () => ({ ...fundedSponsorRoleSnapshot(), checkedAt: new Date(nowMs).toISOString() }),
    now: () => nowMs,
    nonceFactory: () => approvalNonce,
    verifySponsorMessage: async (message, signature) => {
      verifiedMessage = message
      assert.equal(signature, approvalSignature)
      return sponsorAddress
    },
  }))
  const queue = await fetch(base + '/sponsorship/mainnet-direct/review-queue', {
    headers: { authorization: 'Bearer ' + token },
  })
  assert.equal(queue.status, 200)
  assert.equal((await queue.json()).count, 1)

  const challengeResponse = await fetch(base + '/sponsorship/mainnet-direct/requests/' + key + '/approval-challenge', {
    method: 'POST', headers: headers(),
  })
  const challenge = await challengeResponse.json()
  assert.equal(challengeResponse.status, 201)
  assert.equal(challenge.sponsorApprovalRecorded, false)
  assert.equal(challenge.request.recipientAddress, recipient)
  assert.match(challenge.message, new RegExp(sponsorAgreementRef))
  assert.match(challenge.message, new RegExp(sponsorAddress))
  assert.match(challenge.message, new RegExp(recipient))
  assert.match(challenge.message, /Amount in base units \(6 decimals\): 12500000/)
  assert.match(challenge.message, /This is a request-specific sponsor approval signature/)
  assert.match(challenge.message, /It does not approve network fees/)
  assert.doesNotMatch(challenge.message, /private key|seed phrase/i)

  const approvedResponse = await fetch(base + '/sponsorship/mainnet-direct/requests/' + key + '/approve', {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ nonce: challenge.nonce, signature: approvalSignature }),
  })
  const approved = await approvedResponse.json()
  assert.equal(approvedResponse.status, 200)
  assert.equal(approved.status, 'sponsor-approved-principal-only')
  assert.equal(approved.sponsorApproved, true)
  assert.equal(approved.sponsorApproval.sponsorAddress, sponsorAddress)
  assert.equal(approved.sponsorApproval.agreementReference, sponsorAgreementRef)
  assert.equal(approved.feeSponsorApproval, false)
  assert.equal(approved.budgetReserved, false)
  assert.equal(approved.signingIntentCreated, false)
  assert.equal(approved.canCreateSigningIntent, false)
  assert.equal(approved.canSubmitSponsoredTransfer, false)
  assert.equal(approved.transactionBroadcast, false)
  assert.equal(approved.unpaidFallbackToUserFunds, false)
  assert.equal(verifiedMessage, challenge.message)

  const replay = await fetch(base + '/sponsorship/mainnet-direct/requests/' + key + '/approve', {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ nonce: challenge.nonce, signature: approvalSignature }),
  })
  assert.equal(replay.status, 409)

  const sponsorQueue = await fetch(base + '/sponsorship/mainnet-direct/review-queue', {
    headers: { authorization: 'Bearer ' + token },
  })
  const queuePayload = await sponsorQueue.json()
  assert.equal(queuePayload.requests[0].sponsorApproval.status, 'approved-active')
  assert.equal(queuePayload.canSubmitSponsoredTransfer, false)
})

test('Mainnet sponsor approval refuses a stale or insufficient sponsor funding snapshot', async (t) => {
  const store = makeStore()
  const requesterBase = await serve(t, createMainnetDirectSponsorRequestRouter({
    env: approvalEnv, store, sessionLookup: sessionLookup(requester),
  }))
  await fetch(requesterBase + '/sponsorship/mainnet-direct/requests', {
    method: 'POST', headers: headers(), body: JSON.stringify(requestBody()),
  })
  const base = await serve(t, createMainnetDirectSponsorRequestRouter({
    env: approvalEnv,
    store,
    sessionLookup: sessionLookup(sponsorAddress),
    readSponsorRoles: async () => ({
      ...fundedSponsorRoleSnapshot(),
      roles: {
        ...fundedSponsorRoleSnapshot().roles,
        assetPrincipalSponsor: {
          ...fundedSponsorRoleSnapshot().roles.assetPrincipalSponsor,
          tokens: [{
            asset: 'USDT', tokenContract: OFFICIAL_MAINNET_USDT_CONTRACT,
            status: 'verified', decimals: 6, balanceBaseUnits: '1',
          }],
        },
      },
    }),
  }))
  const response = await fetch(base + '/sponsorship/mainnet-direct/requests/' + key + '/approval-challenge', {
    method: 'POST', headers: headers(),
  })
  assert.equal(response.status, 409)
  const payload = await response.json()
  assert.equal(payload.error, 'mainnet-sponsor-funding-preflight-blocked')
  assert.ok(payload.blockers.includes('official-mainnet-usdt-sponsor-balance-does-not-cover-request'))
  assert.equal(payload.canSubmitSponsoredTransfer, false)
})

test('principal sponsor approval requires independently verified positive TRX in the separate fee sponsor', async (t) => {
  const store = makeStore()
  const requesterBase = await serve(t, createMainnetDirectSponsorRequestRouter({
    env: approvalEnv, store, sessionLookup: sessionLookup(requester),
  }))
  await fetch(requesterBase + '/sponsorship/mainnet-direct/requests', {
    method: 'POST', headers: headers(), body: JSON.stringify(requestBody()),
  })
  const base = await serve(t, createMainnetDirectSponsorRequestRouter({
    env: approvalEnv,
    store,
    sessionLookup: sessionLookup(sponsorAddress),
    readSponsorRoles: async () => {
      const snapshot = fundedSponsorRoleSnapshot()
      snapshot.roles.networkFeeSponsor.native.balanceSun = '0'
      return snapshot
    },
  }))
  const response = await fetch(base + '/sponsorship/mainnet-direct/requests/' + key + '/approval-challenge', {
    method: 'POST', headers: headers(),
  })
  assert.equal(response.status, 409)
  const payload = await response.json()
  assert.equal(payload.error, 'mainnet-sponsor-funding-preflight-blocked')
  assert.ok(payload.blockers.includes('mainnet-network-fee-sponsor-positive-trx-and-resources-not-verified'))
  assert.equal(payload.canSubmitSponsoredTransfer, false)
})

test('invalid sponsor approval signatures consume the challenge and cannot be replayed', async (t) => {
  const store = makeStore()
  const requesterBase = await serve(t, createMainnetDirectSponsorRequestRouter({
    env: approvalEnv, store, sessionLookup: sessionLookup(requester),
  }))
  await fetch(requesterBase + '/sponsorship/mainnet-direct/requests', {
    method: 'POST', headers: headers(), body: JSON.stringify(requestBody()),
  })
  const base = await serve(t, createMainnetDirectSponsorRequestRouter({
    env: approvalEnv, store, sessionLookup: sessionLookup(sponsorAddress),
    readSponsorRoles: async () => fundedSponsorRoleSnapshot(),
    nonceFactory: () => approvalNonce,
    verifySponsorMessage: async () => feeSponsorAddress,
  }))
  const challengeResponse = await fetch(base + '/sponsorship/mainnet-direct/requests/' + key + '/approval-challenge', {
    method: 'POST', headers: headers(),
  })
  const challenge = await challengeResponse.json()
  const denied = await fetch(base + '/sponsorship/mainnet-direct/requests/' + key + '/approve', {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ nonce: challenge.nonce, signature: approvalSignature }),
  })
  assert.equal(denied.status, 401)
  assert.equal((await denied.json()).challengeConsumed, true)
  const replay = await fetch(base + '/sponsorship/mainnet-direct/requests/' + key + '/approve', {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ nonce: challenge.nonce, signature: approvalSignature }),
  })
  assert.equal(replay.status, 409)
})

test('Mainnet sponsor approval cannot exceed the signed sponsor cap or accept an unapproved org scope', async (t) => {
  const noScopeEnv = { ...approvalEnv, SPONSOR_APPROVED_AGREEMENT_REFERENCES: '' }
  const base = await serve(t, createMainnetDirectSponsorRequestRouter({
    env: noScopeEnv, store: makeStore(), sessionLookup: sessionLookup(sponsorAddress),
  }))
  const response = await fetch(base + '/sponsorship/mainnet-direct/review-queue', {
    headers: { authorization: 'Bearer ' + token },
  })
  assert.equal(response.status, 503)
  assert.ok((await response.json()).requiredEnvironment.includes('SPONSOR_APPROVED_AGREEMENT_REFERENCES (exact Mainnet USDT asset-principal scope)'))
})


test('fee sponsor cannot approve fees before the asset-principal sponsor has an active approval', async (t) => {
  const store = makeStore()
  const requesterBase = await serve(t, createMainnetDirectSponsorRequestRouter({
    env: feeApprovalEnv, store, sessionLookup: sessionLookup(requester),
  }))
  await fetch(requesterBase + '/sponsorship/mainnet-direct/requests', {
    method: 'POST', headers: headers(), body: JSON.stringify(requestBody()),
  })
  const feeBase = await serve(t, createMainnetDirectSponsorRequestRouter({
    env: feeApprovalEnv,
    store,
    sessionLookup: sessionLookup(feeSponsorAddress),
    readSponsorRoles: async () => fundedSponsorRoleSnapshot(),
  }))
  const response = await fetch(feeBase + '/sponsorship/mainnet-direct/requests/' + key + '/fee-approval-challenge', {
    method: 'POST', headers: headers(),
  })
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error, 'active-asset-principal-approval-required-before-fee-approval')
})

test('distinct fee sponsor signs a separate request-bound network-fee approval after principal approval', async (t) => {
  const store = makeStore()
  const requesterBase = await serve(t, createMainnetDirectSponsorRequestRouter({
    env: feeApprovalEnv, store, sessionLookup: sessionLookup(requester),
  }))
  const created = await fetch(requesterBase + '/sponsorship/mainnet-direct/requests', {
    method: 'POST', headers: headers(), body: JSON.stringify(requestBody()),
  })
  assert.equal(created.status, 201)

  const principalBase = await serve(t, createMainnetDirectSponsorRequestRouter({
    env: feeApprovalEnv,
    store,
    sessionLookup: sessionLookup(sponsorAddress),
    readSponsorRoles: async () => fundedSponsorRoleSnapshot(),
    nonceFactory: () => approvalNonce,
    verifySponsorMessage: async (_message, signature) => {
      assert.equal(signature, approvalSignature)
      return sponsorAddress
    },
  }))
  const principalChallengeResponse = await fetch(principalBase + '/sponsorship/mainnet-direct/requests/' + key + '/approval-challenge', {
    method: 'POST', headers: headers(),
  })
  const principalChallenge = await principalChallengeResponse.json()
  assert.equal(principalChallengeResponse.status, 201)
  const principalApprovalResponse = await fetch(principalBase + '/sponsorship/mainnet-direct/requests/' + key + '/approve', {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ nonce: principalChallenge.nonce, signature: approvalSignature }),
  })
  assert.equal(principalApprovalResponse.status, 200)

  const feeNonce = 'e'.repeat(64)
  let verifiedFeeMessage = ''
  const feeBase = await serve(t, createMainnetDirectSponsorRequestRouter({
    env: feeApprovalEnv,
    store,
    sessionLookup: sessionLookup(feeSponsorAddress),
    readSponsorRoles: async () => fundedSponsorRoleSnapshot(),
    nonceFactory: () => feeNonce,
    verifySponsorMessage: async (message, signature) => {
      verifiedFeeMessage = message
      assert.equal(signature, approvalSignature)
      return feeSponsorAddress
    },
  }))
  const feeQueueResponse = await fetch(feeBase + '/sponsorship/mainnet-direct/fee-review-queue', {
    headers: headers(),
  })
  const feeQueue = await feeQueueResponse.json()
  assert.equal(feeQueueResponse.status, 200)
  assert.equal(feeQueue.count, 1)
  assert.equal(feeQueue.requests[0].sponsorApproval.status, 'approved-active')
  assert.equal(feeQueue.requests[0].feeSponsorApproval.status, 'not-approved')
  assert.equal(feeQueue.canSubmitSponsoredTransfer, false)

  const challengeResponse = await fetch(feeBase + '/sponsorship/mainnet-direct/requests/' + key + '/fee-approval-challenge', {
    method: 'POST', headers: headers(),
  })
  const challenge = await challengeResponse.json()
  assert.equal(challengeResponse.status, 201)
  assert.equal(challenge.maxFeeSun, '50000000')
  assert.equal(challenge.resourceBudgetReserved, false)
  assert.equal(challenge.signingIntentCreated, false)
  assert.match(challenge.message, new RegExp(feeAgreementRef))
  assert.match(challenge.message, new RegExp(feeSponsorAddress))
  assert.match(challenge.message, new RegExp(sponsorAddress))
  assert.match(challenge.message, new RegExp(recipient))
  assert.match(challenge.message, /Maximum approved network-fee budget in SUN: 50000000/)
  assert.match(challenge.message, /not a TRON transaction signature/)
  assert.match(challenge.message, /does not transfer TRX, delegate Energy\/Bandwidth/)

  const approvalResponse = await fetch(feeBase + '/sponsorship/mainnet-direct/requests/' + key + '/approve-fees', {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ nonce: challenge.nonce, signature: approvalSignature }),
  })
  const approval = await approvalResponse.json()
  assert.equal(approvalResponse.status, 200)
  assert.equal(approval.status, 'fee-sponsor-approved-network-fees-only')
  assert.equal(approval.feeSponsorApproved, true)
  assert.equal(approval.feeSponsorApproval.sponsorAddress, feeSponsorAddress)
  assert.equal(approval.feeSponsorApproval.maxFeeSun, '50000000')
  assert.equal(approval.budgetReserved, false)
  assert.equal(approval.resourceBudgetReserved, false)
  assert.equal(approval.signingIntentCreated, false)
  assert.equal(approval.canCreateSigningIntent, false)
  assert.equal(approval.canSubmitSponsoredTransfer, false)
  assert.equal(approval.transactionBroadcast, false)
  assert.equal(approval.unpaidFallbackToUserFunds, false)
  assert.equal(verifiedFeeMessage, challenge.message)

  const replay = await fetch(feeBase + '/sponsorship/mainnet-direct/requests/' + key + '/approve-fees', {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ nonce: challenge.nonce, signature: approvalSignature }),
  })
  assert.equal(replay.status, 409)
  const statusResponse = await fetch(requesterBase + '/sponsorship/mainnet-direct/requests/' + key, {
    headers: headers(),
  })
  const statusPayload = await statusResponse.json()
  assert.equal(statusPayload.sponsorApproved, true)
  assert.equal(statusPayload.feeSponsorApproved, true)
  assert.equal(statusPayload.canSubmitSponsoredTransfer, false)
})

test('fee sponsor approval rejects the same wallet and missing fee-resource audit evidence', async (t) => {
  const store = makeStore()
  const requesterBase = await serve(t, createMainnetDirectSponsorRequestRouter({
    env: feeApprovalEnv, store, sessionLookup: sessionLookup(requester),
  }))
  await fetch(requesterBase + '/sponsorship/mainnet-direct/requests', {
    method: 'POST', headers: headers(), body: JSON.stringify(requestBody()),
  })
  const principalBase = await serve(t, createMainnetDirectSponsorRequestRouter({
    env: feeApprovalEnv, store, sessionLookup: sessionLookup(sponsorAddress),
    readSponsorRoles: async () => fundedSponsorRoleSnapshot(),
    nonceFactory: () => approvalNonce,
    verifySponsorMessage: async () => sponsorAddress,
  }))
  const pc = await fetch(principalBase + '/sponsorship/mainnet-direct/requests/' + key + '/approval-challenge', { method: 'POST', headers: headers() })
  const principalChallenge = await pc.json()
  await fetch(principalBase + '/sponsorship/mainnet-direct/requests/' + key + '/approve', {
    method: 'POST', headers: headers(), body: JSON.stringify({ nonce: principalChallenge.nonce, signature: approvalSignature }),
  })
  const feeBase = await serve(t, createMainnetDirectSponsorRequestRouter({
    env: {
      ...feeApprovalEnv,
      SPONSOR_FEE_MAINNET_ADDRESS: sponsorAddress,
      SPONSOR_APPROVED_AGREEMENT_REFERENCES: [
        [sponsorAgreementRef, sponsorOrgRef, 'mainnet', sponsorAddress, 'asset-grant', 'USDT', OFFICIAL_MAINNET_USDT_CONTRACT].join('|'),
        [feeAgreementRef, feeOrgRef, 'mainnet', sponsorAddress, 'network-fee', 'TRX', '-'].join('|'),
      ].join(';'),
    },
    store,
    sessionLookup: sessionLookup(sponsorAddress),
    readSponsorRoles: async () => fundedSponsorRoleSnapshot(),
  }))
  const sameWallet = await fetch(feeBase + '/sponsorship/mainnet-direct/fee-review-queue', { headers: headers() })
  assert.equal(sameWallet.status, 409)
  assert.equal((await sameWallet.json()).error, 'fee-and-asset-sponsor-wallets-must-be-distinct')

  const badAuditBase = await serve(t, createMainnetDirectSponsorRequestRouter({
    env: feeApprovalEnv,
    store,
    sessionLookup: sessionLookup(feeSponsorAddress),
    readSponsorRoles: async () => {
      const snapshot = fundedSponsorRoleSnapshot()
      snapshot.feeSponsorDelegationToPrincipal.transactionAuditVerified = false
      return snapshot
    },
    nonceFactory: () => 'f'.repeat(64),
  }))
  const badAudit = await fetch(badAuditBase + '/sponsorship/mainnet-direct/requests/' + key + '/fee-approval-challenge', {
    method: 'POST', headers: headers(),
  })
  assert.equal(badAudit.status, 409)
  assert.ok((await badAudit.json()).blockers.includes('fee-sponsor-energy-and-bandwidth-delegation-audit-not-verified'))

  const lowTrxBase = await serve(t, createMainnetDirectSponsorRequestRouter({
    env: feeApprovalEnv,
    store,
    sessionLookup: sessionLookup(feeSponsorAddress),
    readSponsorRoles: async () => {
      const snapshot = fundedSponsorRoleSnapshot()
      snapshot.roles.networkFeeSponsor.native.balanceSun = '1000'
      return snapshot
    },
  }))
  const lowTrx = await fetch(lowTrxBase + '/sponsorship/mainnet-direct/requests/' + key + '/fee-approval-challenge', {
    method: 'POST', headers: headers(),
  })
  assert.equal(lowTrx.status, 409)
  assert.ok((await lowTrx.json()).blockers.includes('fee-sponsor-positive-trx-balance-below-approved-fee-cap'))
})
