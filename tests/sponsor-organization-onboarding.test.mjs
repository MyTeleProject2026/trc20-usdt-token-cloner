import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import express from 'express'
import { createServer } from 'node:http'
import { createSponsorOrganizationOnboardingRouter } from '../server/routes/sponsor-organization-onboarding.mjs'

const OWNER = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const SPONSOR = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const OTHER = 'TTGhREx2pDSxFX555NWz1YwGpiBVPvQA7e'
const ORIGIN = 'https://wallet.example'
const OWNER_TOKEN = 'O'.repeat(43)
const SPONSOR_TOKEN = 'S'.repeat(43)
const TESTNET_TOKEN = 'N'.repeat(43)

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function createMemoryStore() {
  const rows = new Map()
  const openStatuses = new Set(['pending-review', 'in-review', 'accepted-for-due-diligence'])
  const transitions = {
    'pending-review': new Set(['in-review', 'accepted-for-due-diligence', 'declined']),
    'in-review': new Set(['accepted-for-due-diligence', 'declined']),
    'accepted-for-due-diligence': new Set(['in-review', 'declined', 'closed']),
    declined: new Set(['closed']),
    closed: new Set(),
  }
  return {
    rows,
    async create(input) {
      const existing = [...rows.values()].find((row) =>
        row.sponsorWalletAddress === input.sponsorWalletAddress && openStatuses.has(row.status))
      if (existing) {
        const same = existing.organizationName === input.organizationName
          && existing.businessEmail === input.businessEmail
          && existing.jurisdiction === input.jurisdiction
          && existing.website === input.website
          && JSON.stringify(existing.requestedRoles) === JSON.stringify(input.requestedRoles)
        return same
          ? { success: true, duplicate: true, application: existing }
          : { success: false, reason: 'open-application-already-exists' }
      }
      const application = {
        id: input.id,
        sponsorReference: input.sponsorReference,
        organizationName: input.organizationName,
        businessEmail: input.businessEmail,
        jurisdiction: input.jurisdiction,
        website: input.website,
        sponsorWalletAddress: input.sponsorWalletAddress,
        network: input.network,
        requestedRoles: input.requestedRoles,
        status: 'pending-review',
        attestationVersion: input.attestationVersion,
        attestations: {
          authorityToRepresentOrganization: true,
          controlsSponsorWallet: true,
          lawfulSourceOfFunds: true,
          acceptsSponsorTerms: true,
          privacyConsent: true,
        },
        reviewReference: null,
        reviewedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      rows.set(application.id, application)
      return { success: true, duplicate: false, application }
    },
    async getByWallet({ sponsorWalletAddress, network }) {
      const row = [...rows.values()].find((item) =>
        item.sponsorWalletAddress === sponsorWalletAddress && item.network === network)
      return row
        ? { success: true, application: row }
        : { success: false, reason: 'application-not-found' }
    },
    async list({ status = null, limit = 50 } = {}) {
      return {
        success: true,
        applications: [...rows.values()]
          .filter((row) => !status || row.status === status)
          .slice(0, limit),
      }
    },
    async review({ id, status, reviewReference, reviewedByAddress }) {
      const row = rows.get(id)
      if (!row) return { success: false, reason: 'application-not-found' }
      if (row.status === status && row.reviewReference === reviewReference) {
        return { success: true, duplicate: true, id, status }
      }
      if (!transitions[row.status]?.has(status)) {
        return { success: false, reason: 'invalid-status-transition' }
      }
      Object.assign(row, {
        status,
        reviewReference,
        reviewedByAddress,
        reviewedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      return {
        success: true,
        duplicate: false,
        id,
        status,
        reviewReference,
        reviewedAt: row.reviewedAt,
        updatedAt: row.updatedAt,
      }
    },
  }
}

function makeSessionLookup() {
  const sessions = new Map([
    [digest(OWNER_TOKEN), { address: OWNER, network: 'mainnet', origin: ORIGIN }],
    [digest(SPONSOR_TOKEN), { address: SPONSOR, network: 'mainnet', origin: ORIGIN }],
    [digest(TESTNET_TOKEN), { address: OTHER, network: 'nile', origin: ORIGIN }],
  ])
  return async ({ tokenHash, origin }) => {
    const session = sessions.get(tokenHash)
    return { success: true, session: session && session.origin === origin ? session : null }
  }
}

async function serve(t, router) {
  const app = express()
  app.use(express.json({ limit: '32kb' }))
  app.use('/api', router)
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())))
  return `http://127.0.0.1:${server.address().port}/api`
}

function headers(token = SPONSOR_TOKEN) {
  return {
    origin: ORIGIN,
    authorization: 'Bearer ' + token,
    'content-type': 'application/json',
  }
}

function requestBody(overrides = {}) {
  return {
    organizationName: 'Example Sponsor Foundation',
    businessEmail: 'treasury@example.org',
    jurisdiction: 'Singapore',
    website: 'https://example.org/about',
    requestedRoles: ['asset-principal', 'network-fees'],
    authorityToRepresentOrganization: true,
    controlsSponsorWallet: true,
    lawfulSourceOfFunds: true,
    acceptsSponsorTerms: true,
    privacyConsent: true,
    ...overrides,
  }
}

function createApp(t, overrides = {}) {
  const store = overrides.store || createMemoryStore()
  const basePromise = serve(t, createSponsorOrganizationOnboardingRouter({
    env: { OWNER_WALLET_ADDRESS: OWNER },
    store,
    sessionLookup: overrides.sessionLookup || makeSessionLookup(),
    now: () => Date.now(),
  }))
  return { store, basePromise }
}

test('sponsor enrollment requires an authenticated Mainnet wallet session', async (t) => {
  const { store, basePromise } = createApp(t)
  const base = await basePromise
  const missing = await fetch(base + '/tron/sponsorship/organizations', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify(requestBody()),
  })
  assert.equal(missing.status, 401)
  const testnet = await fetch(base + '/tron/sponsorship/organizations', {
    method: 'POST',
    headers: headers(TESTNET_TOKEN),
    body: JSON.stringify(requestBody()),
  })
  assert.equal(testnet.status, 403)
  assert.equal(store.rows.size, 0)
})

test('sponsor wallet address comes only from its authenticated Mainnet wallet session', async (t) => {
  const { store, basePromise } = createApp(t)
  const base = await basePromise
  const response = await fetch(base + '/tron/sponsorship/organizations', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(requestBody()),
  })
  const payload = await response.json()
  assert.equal(response.status, 201)
  assert.equal(payload.success, true)
  assert.equal(payload.status, 'pending-review')
  assert.equal(payload.application.sponsorWalletAddress, SPONSOR)
  assert.match(payload.application.sponsorReference, /^org-[0-9a-f]{32}$/)
  assert.equal(payload.walletControlProof, 'authenticated-mainnet-wallet-session')
  assert.equal(payload.organizationAuthorizationIndependentlyVerified, false)
  assert.equal(payload.sponsorAgreementAuthorized, false)
  assert.equal(payload.canContributeLiquidity, false)
  assert.equal(payload.payoutAuthorized, false)
  assert.equal(payload.submissionEnabled, false)
  assert.equal(store.rows.size, 1)
})

test('unexpected wallet or signing fields are rejected rather than stored', async (t) => {
  const { store, basePromise } = createApp(t)
  const base = await basePromise
  const response = await fetch(base + '/tron/sponsorship/organizations', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(requestBody({ sponsorWalletAddress: OWNER, privateKey: 'never-store-this' })),
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error, 'unexpected-fields')
  assert.equal(store.rows.size, 0)
})

test('all organization, funding and privacy attestations are mandatory', async (t) => {
  const { store, basePromise } = createApp(t)
  const base = await basePromise
  const response = await fetch(base + '/tron/sponsorship/organizations', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(requestBody({ lawfulSourceOfFunds: false })),
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error, 'required-attestation-missing')
  assert.equal(store.rows.size, 0)
})

test('website must use HTTPS and requested roles are bounded', async (t) => {
  const { store, basePromise } = createApp(t)
  const base = await basePromise
  const insecure = await fetch(base + '/tron/sponsorship/organizations', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(requestBody({ website: 'http://example.org' })),
  })
  assert.equal(insecure.status, 400)
  const invalidRole = await fetch(base + '/tron/sponsorship/organizations', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(requestBody({ requestedRoles: ['asset-principal', 'unlimited-signing'] })),
  })
  assert.equal(invalidRole.status, 400)
  assert.equal(store.rows.size, 0)
})

test('duplicate application is idempotent and conflicting re-submission is rejected', async (t) => {
  const { store, basePromise } = createApp(t)
  const base = await basePromise
  const first = await fetch(base + '/tron/sponsorship/organizations', {
    method: 'POST', headers: headers(), body: JSON.stringify(requestBody()),
  })
  assert.equal(first.status, 201)
  const duplicate = await fetch(base + '/tron/sponsorship/organizations', {
    method: 'POST', headers: headers(), body: JSON.stringify(requestBody()),
  })
  assert.equal(duplicate.status, 200)
  assert.equal((await duplicate.json()).duplicate, true)
  const conflict = await fetch(base + '/tron/sponsorship/organizations', {
    method: 'POST', headers: headers(), body: JSON.stringify(requestBody({ organizationName: 'Different Organization' })),
  })
  assert.equal(conflict.status, 409)
  assert.equal(store.rows.size, 1)
})

test('sponsor can inspect only the application bound to its own signed-in wallet', async (t) => {
  const { basePromise } = createApp(t)
  const base = await basePromise
  await fetch(base + '/tron/sponsorship/organizations', {
    method: 'POST', headers: headers(), body: JSON.stringify(requestBody()),
  })
  const own = await fetch(base + '/tron/sponsorship/organizations/me', { headers: headers() })
  assert.equal(own.status, 200)
  assert.equal((await own.json()).application.sponsorWalletAddress, SPONSOR)
  const other = await fetch(base + '/tron/sponsorship/organizations/me', { headers: headers(TESTNET_TOKEN) })
  assert.equal(other.status, 403)
})

test('only the configured owner wallet can list organization applications', async (t) => {
  const { basePromise } = createApp(t)
  const base = await basePromise
  const sponsor = await fetch(base + '/treasury/owner/sponsor-organizations', { headers: headers() })
  assert.equal(sponsor.status, 403)
  const owner = await fetch(base + '/treasury/owner/sponsor-organizations', { headers: headers(OWNER_TOKEN) })
  assert.equal(owner.status, 200)
  const payload = await owner.json()
  assert.equal(payload.count, 0)
  assert.equal(payload.dueDiligenceOnly, true)
  assert.equal(payload.sponsorAgreementAuthorized, false)
})

test('owner review records due diligence only and cannot authorize a sponsor or payout', async (t) => {
  const { store, basePromise } = createApp(t)
  const base = await basePromise
  const submitted = await fetch(base + '/tron/sponsorship/organizations', {
    method: 'POST', headers: headers(), body: JSON.stringify(requestBody()),
  })
  const application = (await submitted.json()).application
  const missingReference = await fetch(base + `/treasury/owner/sponsor-organizations/${application.id}/review`, {
    method: 'POST',
    headers: headers(OWNER_TOKEN),
    body: JSON.stringify({ status: 'accepted-for-due-diligence' }),
  })
  assert.equal(missingReference.status, 400)

  const reviewed = await fetch(base + `/treasury/owner/sponsor-organizations/${application.id}/review`, {
    method: 'POST',
    headers: headers(OWNER_TOKEN),
    body: JSON.stringify({ status: 'accepted-for-due-diligence', reviewReference: 'case-review-2026' }),
  })
  const payload = await reviewed.json()
  assert.equal(reviewed.status, 200)
  assert.equal(payload.application.status, 'accepted-for-due-diligence')
  assert.equal(payload.dueDiligenceOnly, true)
  assert.equal(payload.sponsorAgreementAuthorized, false)
  assert.equal(payload.canContributeLiquidity, false)
  assert.equal(payload.payoutAuthorized, false)
  assert.equal(payload.submissionEnabled, false)
  const persisted = store.rows.get(application.id)
  assert.equal(persisted.reviewedByAddress, OWNER)
})

test('owner review rejects unknown statuses and disallowed state transitions', async (t) => {
  const { basePromise } = createApp(t)
  const base = await basePromise
  const submitted = await fetch(base + '/tron/sponsorship/organizations', {
    method: 'POST', headers: headers(), body: JSON.stringify(requestBody()),
  })
  const application = (await submitted.json()).application
  const invalid = await fetch(base + `/treasury/owner/sponsor-organizations/${application.id}/review`, {
    method: 'POST',
    headers: headers(OWNER_TOKEN),
    body: JSON.stringify({ status: 'active', reviewReference: 'case-review-2026' }),
  })
  assert.equal(invalid.status, 400)
  const declined = await fetch(base + `/treasury/owner/sponsor-organizations/${application.id}/review`, {
    method: 'POST',
    headers: headers(OWNER_TOKEN),
    body: JSON.stringify({ status: 'declined', reviewReference: 'case-review-2026' }),
  })
  assert.equal(declined.status, 200)
  const reopened = await fetch(base + `/treasury/owner/sponsor-organizations/${application.id}/review`, {
    method: 'POST',
    headers: headers(OWNER_TOKEN),
    body: JSON.stringify({ status: 'accepted-for-due-diligence', reviewReference: 'case-review-2027' }),
  })
  assert.equal(reopened.status, 409)
})
