import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import express from 'express'
import { createSponsorOrganizationRouter } from '../server/routes/sponsor-organizations.mjs'

const ADMIN_TOKEN = 'test-sponsor-admin-token-that-is-long-enough-123456'
const VALID_ADDRESS = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'

function createMemoryStore() {
  const organizations = new Map()
  const accounts = new Map()
  let nextOrganizationId = 1
  let nextAccountId = 1

  return {
    organizations,
    accounts,
    async listOrganizations({ status, limit }) {
      return {
        success: true,
        organizations: [...organizations.values()].filter((item) => !status || item.status === status)
          .slice(0, limit)
          .map((item) => ({ ...item, accounts: [...accounts.values()].filter((account) => account.organizationId === item.id) })),
      }
    },
    async createOrganization(input) {
      if ([...organizations.values()].some((item) => item.sponsorReference === input.sponsorReference)) {
        return { success: false, reason: 'sponsor-reference-already-exists' }
      }
      const organization = {
        id: String(nextOrganizationId++), sponsorReference: input.sponsorReference, legalName: input.legalName,
        displayName: input.displayName || null, jurisdictionCountryCode: input.jurisdictionCountryCode?.toUpperCase() || null,
        status: 'pending_review', agreementReference: null, reviewReference: null, verificationMethod: null,
        evidenceReference: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        approvedAt: null, payoutEligible: false,
      }
      organizations.set(organization.id, organization)
      return { success: true, organization }
    },
    async createAccount(organizationId, input) {
      const organization = organizations.get(organizationId)
      if (!organization) return { success: false, reason: 'organization-not-found' }
      const account = {
        id: String(nextAccountId++), organizationId, sponsorReference: input.sponsorReference,
        network: input.network, role: input.role, address: input.address,
        status: 'pending_verification', payoutEligible: false,
      }
      accounts.set(account.id, account)
      return { success: true, account }
    },
    async reviewOrganization(organizationId, input) {
      const organization = organizations.get(organizationId)
      if (!organization) return { success: false, reason: 'organization-not-found' }
      const transitions = {
        pending_review: ['under_review', 'suspended', 'revoked'],
        under_review: ['verified', 'suspended', 'revoked'],
        verified: ['approved', 'suspended', 'revoked'],
        approved: ['suspended', 'revoked'],
        suspended: ['revoked'],
        revoked: [],
      }
      if (!transitions[organization.status].includes(input.decision)) {
        return { success: false, reason: 'invalid-organization-status-transition' }
      }
      Object.assign(organization, {
        status: input.decision, reviewReference: input.reviewReference,
        evidenceReference: input.evidenceReference || organization.evidenceReference,
        verificationMethod: input.verificationMethod || organization.verificationMethod,
        agreementReference: input.agreementReference || organization.agreementReference,
      })
      return { success: true, organization }
    },
    async reviewAccount(organizationId, accountId, input) {
      const organization = organizations.get(organizationId)
      const account = accounts.get(accountId)
      if (!organization || !account || account.organizationId !== organizationId) {
        return { success: false, reason: 'sponsor-account-not-found' }
      }
      if (!['verified', 'approved'].includes(organization.status)) {
        return { success: false, reason: 'organization-verification-required' }
      }
      const transitions = {
        pending_verification: ['verified', 'suspended', 'revoked'],
        verified: ['suspended', 'revoked'],
        suspended: ['revoked'],
        revoked: [],
      }
      if (!transitions[account.status].includes(input.decision)) {
        return { success: false, reason: 'invalid-sponsor-account-status-transition' }
      }
      Object.assign(account, {
        status: input.decision, reviewReference: input.reviewReference,
        verificationReference: input.evidenceReference || null, verificationMethod: input.verificationMethod || null,
      })
      return { success: true, account }
    },
  }
}

async function serve(t, store) {
  const app = express()
  app.use(express.json({ limit: '32kb' }))
  app.use('/api/tron', createSponsorOrganizationRouter({ env: { SPONSOR_ADMIN_API_TOKEN: ADMIN_TOKEN }, store }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  return `http://127.0.0.1:${server.address().port}/api/tron`
}

function adminHeaders() {
  return { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' }
}

test('registry endpoints reject missing or incorrect sponsor admin authorization', async (t) => {
  const store = createMemoryStore()
  const base = await serve(t, store)
  const response = await fetch(base + '/sponsorship/organizations')
  assert.equal(response.status, 401)
  assert.equal((await response.json()).error, 'sponsor-admin-authorization-required')
  assert.equal(store.organizations.size, 0)
})

test('organization registration creates pending review and payout remains disabled', async (t) => {
  const store = createMemoryStore()
  const base = await serve(t, store)
  const response = await fetch(base + '/sponsorship/organizations', {
    method: 'POST', headers: adminHeaders(),
    body: JSON.stringify({
      sponsorReference: 'independent-org-alpha', legalName: 'Alpha Treasury Ltd',
      displayName: 'Alpha Treasury', jurisdictionCountryCode: 'sg',
    }),
  })
  const payload = await response.json()
  assert.equal(response.status, 201)
  assert.equal(payload.organization.status, 'pending_review')
  assert.equal(payload.organization.jurisdictionCountryCode, 'SG')
  assert.equal(payload.organization.payoutEligible, false)
  assert.equal(payload.submissionEnabled, false)
  assert.equal(payload.canSubmitSponsoredTransfer, false)
})

test('organization registration rejects secret-bearing and unknown fields', async (t) => {
  const store = createMemoryStore()
  const base = await serve(t, store)
  const response = await fetch(base + '/sponsorship/organizations', {
    method: 'POST', headers: adminHeaders(),
    body: JSON.stringify({ sponsorReference: 'independent-org-alpha', legalName: 'Alpha Treasury Ltd', privateKey: 'do-not-accept' }),
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error, 'invalid-organization-request')
  assert.equal(store.organizations.size, 0)
})

test('account registration pins network and role and begins pending verification', async (t) => {
  const store = createMemoryStore()
  const base = await serve(t, store)
  const created = await fetch(base + '/sponsorship/organizations', {
    method: 'POST', headers: adminHeaders(),
    body: JSON.stringify({ sponsorReference: 'independent-org-alpha', legalName: 'Alpha Treasury Ltd' }),
  })
  const organization = (await created.json()).organization
  const response = await fetch(base + `/sponsorship/organizations/${organization.id}/accounts`, {
    method: 'POST', headers: adminHeaders(),
    body: JSON.stringify({
      sponsorReference: 'alpha-mainnet-principal', network: 'mainnet', role: 'asset-principal', address: VALID_ADDRESS,
    }),
  })
  const payload = await response.json()
  assert.equal(response.status, 201)
  assert.equal(payload.account.status, 'pending_verification')
  assert.equal(payload.account.role, 'asset-principal')
  assert.equal(payload.account.network, 'mainnet')
  assert.equal(payload.account.payoutEligible, false)
  assert.equal(payload.canSubmitSponsoredTransfer, false)
})

test('organization status transitions require evidence and signed agreement references', async (t) => {
  const store = createMemoryStore()
  const base = await serve(t, store)
  const created = await fetch(base + '/sponsorship/organizations', {
    method: 'POST', headers: adminHeaders(),
    body: JSON.stringify({ sponsorReference: 'independent-org-alpha', legalName: 'Alpha Treasury Ltd' }),
  })
  const organization = (await created.json()).organization
  const route = base + `/sponsorship/organizations/${organization.id}/review`

  const missingEvidence = await fetch(route, {
    method: 'POST', headers: adminHeaders(),
    body: JSON.stringify({ decision: 'verified', reviewReference: 'review-alpha-001' }),
  })
  assert.equal(missingEvidence.status, 400)

  const underReview = await fetch(route, {
    method: 'POST', headers: adminHeaders(),
    body: JSON.stringify({ decision: 'under_review', reviewReference: 'review-alpha-001' }),
  })
  assert.equal(underReview.status, 200)
  assert.equal((await underReview.json()).organization.status, 'under_review')

  const verified = await fetch(route, {
    method: 'POST', headers: adminHeaders(),
    body: JSON.stringify({
      decision: 'verified', reviewReference: 'review-alpha-002', evidenceReference: 'evidence-alpha-002',
      verificationMethod: 'manual-independent-review',
    }),
  })
  assert.equal(verified.status, 200)

  const noAgreement = await fetch(route, {
    method: 'POST', headers: adminHeaders(),
    body: JSON.stringify({ decision: 'approved', reviewReference: 'review-alpha-003' }),
  })
  assert.equal(noAgreement.status, 400)

  const approved = await fetch(route, {
    method: 'POST', headers: adminHeaders(),
    body: JSON.stringify({
      decision: 'approved', reviewReference: 'review-alpha-003', agreementReference: 'signed-agreement-alpha-003',
    }),
  })
  const approvedPayload = await approved.json()
  assert.equal(approved.status, 200)
  assert.equal(approvedPayload.organization.status, 'approved')
  assert.equal(approvedPayload.organization.payoutEligible, false)
  assert.equal(approvedPayload.submissionEnabled, false)
})

test('account verification is scoped to a verified parent organization', async (t) => {
  const store = createMemoryStore()
  const base = await serve(t, store)
  const created = await fetch(base + '/sponsorship/organizations', {
    method: 'POST', headers: adminHeaders(),
    body: JSON.stringify({ sponsorReference: 'independent-org-alpha', legalName: 'Alpha Treasury Ltd' }),
  })
  const organization = (await created.json()).organization
  const accountResponse = await fetch(base + `/sponsorship/organizations/${organization.id}/accounts`, {
    method: 'POST', headers: adminHeaders(),
    body: JSON.stringify({
      sponsorReference: 'alpha-mainnet-principal', network: 'mainnet', role: 'asset-principal', address: VALID_ADDRESS,
    }),
  })
  const account = (await accountResponse.json()).account
  const accountReviewUrl = base + `/sponsorship/organizations/${organization.id}/accounts/${account.id}/review`
  const premature = await fetch(accountReviewUrl, {
    method: 'POST', headers: adminHeaders(),
    body: JSON.stringify({
      decision: 'verified', reviewReference: 'account-review-001', evidenceReference: 'account-proof-001',
      verificationMethod: 'wallet-signature',
    }),
  })
  assert.equal(premature.status, 409)

  const orgReviewUrl = base + `/sponsorship/organizations/${organization.id}/review`
  for (const body of [
    { decision: 'under_review', reviewReference: 'org-review-001' },
    { decision: 'verified', reviewReference: 'org-review-002', evidenceReference: 'org-proof-002', verificationMethod: 'manual-independent-review' },
  ]) {
    const result = await fetch(orgReviewUrl, { method: 'POST', headers: adminHeaders(), body: JSON.stringify(body) })
    assert.equal(result.status, 200)
  }

  const verified = await fetch(accountReviewUrl, {
    method: 'POST', headers: adminHeaders(),
    body: JSON.stringify({
      decision: 'verified', reviewReference: 'account-review-002', evidenceReference: 'account-proof-002',
      verificationMethod: 'wallet-signature',
    }),
  })
  assert.equal(verified.status, 200)
  assert.equal((await verified.json()).account.status, 'verified')
})

test('registry listing is protected, non-cacheable, and remains non-executable', async (t) => {
  const store = createMemoryStore()
  const base = await serve(t, store)
  await fetch(base + '/sponsorship/organizations', {
    method: 'POST', headers: adminHeaders(),
    body: JSON.stringify({ sponsorReference: 'independent-org-alpha', legalName: 'Alpha Treasury Ltd' }),
  })
  const response = await fetch(base + '/sponsorship/organizations', { headers: adminHeaders() })
  const payload = await response.json()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(payload.organizations.length, 1)
  assert.equal(payload.organizations[0].status, 'pending_review')
  assert.equal(payload.canSubmitSponsoredTransfer, false)
})

test('registry database schema provides organization isolation and immutable audit references', async () => {
  const source = await readFile(new URL('../server/sponsor-organizations.mjs', import.meta.url), 'utf8')
  assert.match(source, /UNIQUE \(network, wallet_address\)/)
  assert.match(source, /REFERENCES trc20_token_clone\.sponsor_organizations\(id\) ON DELETE RESTRICT/)
  assert.match(source, /sponsor_organization_audit_events/)
  assert.match(source, /payoutEligible: false/)
})
