import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import express from 'express'
import { reserveSponsorOrganizationPayoutIntent } from '../server/sponsor-organization-payout-intents.mjs'
import { createSponsorOrganizationSelectionRouter } from '../server/routes/sponsor-organization-selection.mjs'

const ADMIN_TOKEN = 'test-sponsor-admin-token-that-is-long-enough-123456'
const PRINCIPAL_ADDRESS = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
const FEE_ADDRESS = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const RECEIVER_ADDRESS = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE'

function links({ sameOrganization = false, sameWallet = false } = {}) {
  return [
    {
      id: '31', organizationId: '101', organizationReference: 'principal-org',
      organizationStatus: 'approved', accountId: '201', accountReference: 'principal-account',
      network: 'nile', role: 'asset-principal', sponsorAddress: PRINCIPAL_ADDRESS,
      accountStatus: 'verified', budgetId: '301', sponsorReference: 'principal-budget',
      purpose: 'asset-grant', asset: 'TRX', tokenContract: null, budgetStatus: 'active',
      linkStatus: 'active', agreementScopeVerified: true, linkCurrentlyActive: true,
    },
    {
      id: '32', organizationId: sameOrganization ? '101' : '102', organizationReference: 'fee-org',
      organizationStatus: 'approved', accountId: '202', accountReference: 'fee-account',
      network: 'nile', role: 'network-fee', sponsorAddress: sameWallet ? PRINCIPAL_ADDRESS : FEE_ADDRESS,
      accountStatus: 'verified', budgetId: '302', sponsorReference: 'fee-budget',
      purpose: 'network-fee', asset: 'TRX', tokenContract: null, budgetStatus: 'active',
      linkStatus: 'active', agreementScopeVerified: true, linkCurrentlyActive: true,
    },
  ]
}

function snapshots(network, feeAddress, principalAddress) {
  const make = (sponsorAddress) => ({
    status: 'solidified-sponsor-balances-read',
    onChainBalanceRead: true,
    network,
    sponsorAddress,
    source: 'Tatum TRON SolidityNode account and constant-contract queries',
    checkedAt: new Date().toISOString(),
    cache: { status: 'fresh', ageMs: 0 },
  })
  return {
    networkFeeSponsor: make(feeAddress),
    assetPrincipalSponsor: make(principalAddress),
  }
}

function roleFunding(network, feeAddress, principalAddress, delegation = true) {
  return {
    fundingSnapshots: snapshots(network, feeAddress, principalAddress),
    roles: { networkFeeSponsor: { resourceStatus: { resourceRead: true } } },
    feeSponsorDelegationToPrincipal: delegation ? {
      success: true, status: 'solidified-delegation-state-read',
      fromAddress: feeAddress, toAddress: principalAddress,
      activeEnergyStakeSun: '1000000', activeBandwidthStakeSun: '0',
    } : { success: false, status: 'delegation-not-found' },
  }
}

function createStore(options = {}) {
  const state = { reserved: [], cancelled: [], expired: 0 }
  return {
    state,
    async listBudgetLinks() { return { success: true, links: links(options) } },
    async reservePayoutIntent(input) {
      state.reserved.push(input)
      return {
        success: true, duplicate: false, intentId: '9001', idempotencyKey: input.idempotencyKey,
        intentDigest: 'a'.repeat(64), status: 'pending_authorization',
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        canSubmitSponsoredTransfer: false, submissionEnabled: false,
      }
    },
    async cancelPayoutIntent(id, reviewReference) {
      state.cancelled.push({ id, reviewReference })
      return { success: true, duplicate: false, status: 'cancelled', reservationReleased: true }
    },
    async expirePayoutIntents({ limit }) {
      state.expired += 1
      return { success: true, expiredCount: limit > 0 ? 2 : 0 }
    },
  }
}

const baseInput = {
  idempotencyKey: 'dual-sponsor-intent-test-0001',
  network: 'nile',
  asset: 'TRX',
  tokenContract: null,
  receiverAddress: RECEIVER_ADDRESS,
  amountBaseUnits: '2500000',
  feeCapSun: '120000',
  principalLinkId: '31',
  feeLinkId: '32',
}

test('dual sponsor intent reserves two independently owned budget links and remains pending authorization', async () => {
  const store = createStore()
  const result = await reserveSponsorOrganizationPayoutIntent({
    store, env: {}, input: baseInput,
    readRoleFunding: async (...args) => roleFunding(...args),
  })
  assert.equal(result.success, true)
  assert.equal(result.status, 'pending_authorization')
  assert.equal(result.intent.amountBaseUnits, '2500000')
  assert.equal(result.intent.feeCapSun, '120000')
  assert.equal(result.transactionSpecificFeeCoverageVerified, false)
  assert.equal(result.sponsorAuthorizationVerified, false)
  assert.equal(result.transactionSubmitted, false)
  assert.equal(result.canSubmitSponsoredTransfer, false)
  assert.equal(result.submissionEnabled, false)
  assert.equal(store.state.reserved.length, 1)
  assert.equal(store.state.reserved[0].fundingSnapshots.networkFeeSponsor.sponsorAddress, FEE_ADDRESS)
  assert.equal(store.state.reserved[0].fundingSnapshots.assetPrincipalSponsor.sponsorAddress, PRINCIPAL_ADDRESS)
})

test('dual sponsor intent rejects shared organizations or shared wallet addresses', async () => {
  for (const options of [{ sameOrganization: true }, { sameWallet: true }]) {
    const store = createStore(options)
    const result = await reserveSponsorOrganizationPayoutIntent({
      store, env: {}, input: baseInput,
      readRoleFunding: async (...args) => roleFunding(...args),
    })
    assert.equal(result.success, false)
    assert.equal(result.reason, 'independent-approved-principal-and-fee-budget-links-required')
    assert.equal(store.state.reserved.length, 0)
  }
})

test('dual sponsor intent fails closed when current fee delegation is not observed', async () => {
  const store = createStore()
  const result = await reserveSponsorOrganizationPayoutIntent({
    store, env: {}, input: baseInput,
    readRoleFunding: async (network, fee, principal) => roleFunding(network, fee, principal, false),
  })
  assert.equal(result.success, false)
  assert.equal(result.reason, 'active-fee-to-principal-resource-delegation-not-observed')
  assert.equal(store.state.reserved.length, 0)
})

test('dual sponsor intent rejects a stale exact-wallet funding snapshot', async () => {
  const store = createStore()
  const readRoleFunding = async (network, fee, principal) => {
    const value = roleFunding(network, fee, principal)
    value.fundingSnapshots.networkFeeSponsor.checkedAt = new Date(Date.now() - 60000).toISOString()
    return value
  }
  const result = await reserveSponsorOrganizationPayoutIntent({ store, env: {}, input: baseInput, readRoleFunding })
  assert.equal(result.success, false)
  assert.equal(result.reason, 'fresh-role-specific-funding-snapshots-required')
  assert.equal(store.state.reserved.length, 0)
})

async function serve(t, store, readRoleFunding) {
  const app = express()
  app.use(express.json({ limit: '32kb' }))
  app.use('/api/tron', createSponsorOrganizationSelectionRouter({
    env: { SPONSOR_ADMIN_API_TOKEN: ADMIN_TOKEN },
    store,
    readRoleFunding,
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  return 'http://127.0.0.1:' + server.address().port + '/api/tron'
}

function adminHeaders() {
  return { authorization: 'Bearer ' + ADMIN_TOKEN, 'content-type': 'application/json' }
}

const baseHttpInput = {
  idempotencyKey: baseInput.idempotencyKey,
  network: baseInput.network,
  asset: baseInput.asset,
  receiverAddress: baseInput.receiverAddress,
  amountBaseUnits: baseInput.amountBaseUnits,
  feeCapSun: baseInput.feeCapSun,
  principalBudgetLinkId: baseInput.principalLinkId,
  feeBudgetLinkId: baseInput.feeLinkId,
}

test('payout intent HTTP route requires admin auth and rejects secret-bearing fields', async (t) => {
  const store = createStore()
  const base = await serve(t, store, async (...args) => roleFunding(...args))
  const denied = await fetch(base + '/sponsorship/organizations/payout-intents', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(baseHttpInput),
  })
  assert.equal(denied.status, 401)
  const rejected = await fetch(base + '/sponsorship/organizations/payout-intents', {
    method: 'POST', headers: adminHeaders(), body: JSON.stringify({ ...baseHttpInput, privateKey: 'never-accept' }),
  })
  assert.equal(rejected.status, 400)
  assert.equal(store.state.reserved.length, 0)
})

test('payout intent HTTP route returns a non-submittable pending authorization record', async (t) => {
  const store = createStore()
  const base = await serve(t, store, async (...args) => roleFunding(...args))
  const response = await fetch(base + '/sponsorship/organizations/payout-intents', {
    method: 'POST', headers: adminHeaders(), body: JSON.stringify(baseHttpInput),
  })
  const payload = await response.json()
  assert.equal(response.status, 201)
  assert.equal(payload.status, 'pending_authorization')
  assert.equal(payload.intent.id, '9001')
  assert.equal(payload.transactionSubmitted, false)
  assert.equal(payload.canSubmitSponsoredTransfer, false)
  assert.equal(payload.submissionEnabled, false)
})

test('payout intent cancellation and expiry endpoints require administrator authorization', async (t) => {
  const store = createStore()
  const base = await serve(t, store, async (...args) => roleFunding(...args))
  const denied = await fetch(base + '/sponsorship/payout-intents/9001/cancel', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reviewReference: 'cancel-review-01' }),
  })
  assert.equal(denied.status, 401)
  const cancelled = await fetch(base + '/sponsorship/payout-intents/9001/cancel', {
    method: 'POST', headers: adminHeaders(), body: JSON.stringify({ reviewReference: 'cancel-review-01' }),
  })
  assert.equal(cancelled.status, 200)
  assert.equal((await cancelled.json()).reservationReleased, true)
  const expired = await fetch(base + '/sponsorship/payout-intents/expire', {
    method: 'POST', headers: adminHeaders(), body: JSON.stringify({ limit: 10 }),
  })
  assert.equal(expired.status, 200)
  assert.equal((await expired.json()).expiredCount, 2)
})

