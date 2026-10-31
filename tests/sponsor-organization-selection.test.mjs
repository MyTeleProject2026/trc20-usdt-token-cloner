import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import express from 'express'
import { selectSponsorOrganizationPair } from '../server/sponsor-organization-selection.mjs'
import { createSponsorOrganizationSelectionRouter } from '../server/routes/sponsor-organization-selection.mjs'

const ADMIN_TOKEN = 'selection-test-admin-token-longer-than-thirty-two-characters'
const PRINCIPAL_ADDRESS = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
const FEE_ADDRESS = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const TOKEN_CONTRACT = FEE_ADDRESS

function link(overrides = {}) {
  return {
    organizationId: '1', organizationReference: 'alpha-org', organizationName: 'Alpha Treasury Ltd',
    organizationStatus: 'approved', accountId: '11', accountReference: 'alpha-principal-account',
    network: 'nile', role: 'asset-principal', sponsorAddress: PRINCIPAL_ADDRESS,
    accountStatus: 'verified', budgetId: '101', sponsorReference: 'alpha-principal-budget',
    purpose: 'asset-grant', asset: 'USDT', tokenContract: TOKEN_CONTRACT,
    budgetBaseUnits: '9000000', reservedBaseUnits: '1000000', spentBaseUnits: '0',
    availableLedgerBaseUnits: '8000000', budgetStatus: 'active', agreementReference: 'agreement-alpha-001',
    linkStatus: 'active', agreementScopeVerified: true, linkCurrentlyActive: true,
    ...overrides,
  }
}

function feeLink(overrides = {}) {
  return link({
    organizationId: '2', organizationReference: 'beta-org', organizationName: 'Beta Treasury Ltd',
    accountId: '22', accountReference: 'beta-fee-account', role: 'network-fee',
    sponsorAddress: FEE_ADDRESS, budgetId: '202', sponsorReference: 'beta-fee-budget',
    purpose: 'network-fee', asset: 'TRX', tokenContract: null,
    budgetBaseUnits: '5000000', reservedBaseUnits: '0', spentBaseUnits: '0',
    availableLedgerBaseUnits: '5000000', agreementReference: 'agreement-beta-001',
    ...overrides,
  })
}

function snapshot(address, tokens = []) {
  return {
    status: 'solidified-sponsor-balances-read',
    onChainBalanceRead: true,
    network: 'nile',
    sponsorAddress: address,
    source: 'Tatum TRON SolidityNode account and constant-contract queries',
    checkedAt: new Date().toISOString(),
    cache: { status: 'fresh', ageMs: 0 },
    native: { status: 'verified', asset: 'TRX', balanceSun: '9000000' },
    tokens,
  }
}

function testBudgets(address, purpose, asset, tokenContract = null) {
  return [{
    id: purpose === 'network-fee' ? '202' : '101',
    sponsor_reference: purpose === 'network-fee' ? 'beta-fee-budget' : 'alpha-principal-budget',
    sponsor_address: address, network: 'nile', purpose, asset, token_contract: tokenContract,
    budget_base_units: purpose === 'network-fee' ? '5000000' : '9000000',
    reserved_base_units: purpose === 'network-fee' ? '0' : '1000000', spent_base_units: '0',
    status: 'active',
    approval_reference: purpose === 'network-fee' ? 'agreement-beta-001' : 'agreement-alpha-001',
    review_reference: 'budget-review-reference', approved_at: new Date().toISOString(),
    approvalScopeVerified: true,
  }]
}

function makeStore(overrides = {}) {
  return {
    async listBudgetLinks() { return { success: true, links: [link(), feeLink()] } },
    async listBudgetsForWallet({ sponsorAddress }) {
      return {
        success: true,
        budgets: sponsorAddress === FEE_ADDRESS
          ? testBudgets(FEE_ADDRESS, 'network-fee', 'TRX')
          : testBudgets(PRINCIPAL_ADDRESS, 'asset-grant', 'USDT', TOKEN_CONTRACT),
      }
    },
    ...overrides,
  }
}

function makeRoleFunding({ stale = false, delegation = true, resources = true, principalBalance = '10000000' } = {}) {
  return async (network, feeAddress, principalAddress) => ({
    success: true,
    network,
    roles: { networkFeeSponsor: { address: feeAddress, resourceStatus: { resourceRead: resources } } },
    fundingSnapshots: {
      networkFeeSponsor: snapshot(feeAddress),
      assetPrincipalSponsor: snapshot(principalAddress, [{
        asset: 'USDT (testnet)', tokenContract: TOKEN_CONTRACT, status: 'verified',
        balanceBaseUnits: principalBalance, decimals: 6,
      }]),
    },
    feeSponsorDelegationToPrincipal: {
      success: delegation,
      status: delegation ? 'solidified-delegation-state-read' : 'solidified-no-delegation-observed',
      fromAddress: feeAddress,
      toAddress: principalAddress,
      activeEnergyStakeSun: delegation ? '1000000' : '0',
      activeBandwidthStakeSun: '0',
    },
  })
}

const request = {
  store: makeStore(),
  env: {},
  network: 'nile',
  asset: 'USDT',
  tokenContract: TOKEN_CONTRACT,
  amountBaseUnits: '2000000',
  estimatedFeeSun: '100000',
}

test('selector returns a read-only pair only with fresh principal/fee chain balances and active delegation', async () => {
  const result = await selectSponsorOrganizationPair({ ...request, readRoleFunding: makeRoleFunding() })
  assert.equal(result.success, true)
  assert.equal(result.status, 'dual-sponsor-preflight-passed-review-required')
  assert.equal(result.selection.principal.organizationId, '1')
  assert.equal(result.selection.fee.organizationId, '2')
  assert.equal(result.selection.fee.resourceRead, true)
  assert.equal(result.selection.transactionSpecificFeeCoverageVerified, false)
  assert.equal(result.canSubmitSponsoredTransfer, false)
  assert.equal(result.submissionEnabled, false)
  assert.equal(result.transactionSubmitted, false)
})

test('selector rejects stale snapshots even when ledger budget caps are sufficient', async () => {
  const staleReader = async (network, feeAddress, principalAddress) => {
    const value = await makeRoleFunding()(network, feeAddress, principalAddress)
    value.fundingSnapshots.assetPrincipalSponsor.cache = { status: 'cached', ageMs: 20000 }
    return value
  }
  const result = await selectSponsorOrganizationPair({ ...request, readRoleFunding: staleReader })
  assert.equal(result.success, false)
  assert.ok(result.blockers.includes('fresh-role-specific-funding-snapshots-required'))
})

test('selector refuses fee accounts without the exact active fee-to-principal delegation', async () => {
  const result = await selectSponsorOrganizationPair({
    ...request, readRoleFunding: makeRoleFunding({ delegation: false }),
  })
  assert.equal(result.success, false)
  assert.ok(result.blockers.includes('active-fee-to-principal-resource-delegation-not-observed'))
})

test('selector refuses underfunded live token balances', async () => {
  const result = await selectSponsorOrganizationPair({
    ...request, readRoleFunding: makeRoleFunding({ principalBalance: '1000000' }),
  })
  assert.equal(result.success, false)
  assert.ok(result.blockers.includes('role-specific-onchain-balance-does-not-cover-existing-commitments'))
})

async function serve(t, store, selector = selectSponsorOrganizationPair) {
  const app = express()
  app.use(express.json())
  app.use('/api/tron', createSponsorOrganizationSelectionRouter({
    env: { SPONSOR_ADMIN_API_TOKEN: ADMIN_TOKEN }, store, selector,
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  return `http://127.0.0.1:${server.address().port}/api/tron`
}

test('selection endpoint requires the sponsor administrator bearer token', async (t) => {
  const base = await serve(t, makeStore())
  const response = await fetch(base + `/sponsorship/organizations/selection?network=nile&asset=USDT&tokenContract=${TOKEN_CONTRACT}&amountBaseUnits=10&estimatedFeeSun=10`)
  assert.equal(response.status, 401)
  assert.equal((await response.json()).error, 'sponsor-admin-authorization-required')
})

test('selection endpoint validates exact asset parameters and remains non-executable', async (t) => {
  const base = await serve(t, makeStore(), async () => ({
    success: true, status: 'dual-sponsor-preflight-passed-review-required',
    canSubmitSponsoredTransfer: false, submissionEnabled: false,
  }))
  const invalid = await fetch(base + '/sponsorship/organizations/selection?network=nile&asset=USDT&tokenContract=bad&amountBaseUnits=1&estimatedFeeSun=1', {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  })
  assert.equal(invalid.status, 400)

  const valid = await fetch(base + `/sponsorship/organizations/selection?network=nile&asset=USDT&tokenContract=${TOKEN_CONTRACT}&amountBaseUnits=10&estimatedFeeSun=10`, {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  })
  const payload = await valid.json()
  assert.equal(valid.status, 200)
  assert.equal(payload.success, true)
  assert.equal(payload.canSubmitSponsoredTransfer, false)
  assert.equal(payload.submissionEnabled, false)
})
