import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { createOwnerSponsorLiquidityRouter } from '../server/routes/owner-sponsor-liquidity.mjs'

const OWNER = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const SPONSOR_A = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const SPONSOR_B = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH'
const OFFICIAL_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const TOKEN = 'A'.repeat(43)
const ORIGIN = 'https://wallet.example'
const AGREEMENT_A = 'approved-a-2026'
const AGREEMENT_B = 'approved-b-2026'

function budget({
  sponsorAddress = SPONSOR_A,
  sponsorReference = 'org-a',
  agreement = AGREEMENT_A,
  cap = '100000000',
  reserved = '10000000',
  spent = '20000000',
  status = 'active',
  review = 'review-a-2026',
  approvedAt = '2026-11-04T00:00:00.000Z',
} = {}) {
  return {
    id: '1',
    sponsor_reference: sponsorReference,
    sponsor_address: sponsorAddress,
    network: 'mainnet',
    purpose: 'asset-grant',
    asset: 'USDT',
    token_contract: OFFICIAL_USDT,
    budget_base_units: cap,
    reserved_base_units: reserved,
    spent_base_units: spent,
    ledger_available_base_units: (BigInt(cap) - BigInt(reserved) - BigInt(spent)).toString(),
    status,
    approval_reference: agreement,
    review_reference: review,
    approved_at: approvedAt,
  }
}

function funding(address, balance, checkedAt = new Date().toISOString()) {
  return {
    configured: true,
    network: 'mainnet',
    status: 'solidified-sponsor-balances-read',
    source: 'Tatum TRON SolidityNode account and constant-contract queries',
    checkedAt,
    sponsorAddress: address,
    onChainBalanceRead: true,
    cache: { status: 'fresh', ageMs: 0 },
    native: { status: 'verified', balanceSun: '0', balanceTRX: '0', accountExists: true },
    tokens: [{ asset: 'USDT', tokenContract: OFFICIAL_USDT, status: 'verified', balanceBaseUnits: String(balance), decimals: 6 }],
    tokenBalancesComplete: true,
    sponsorFundingVerified: false,
    sponsorAgreementVerified: false,
    canSubmitSponsoredTransfer: false,
    submissionEnabled: false,
  }
}

async function listen(t, options = {}) {
  const app = express()
  app.use('/api/treasury/owner', createOwnerSponsorLiquidityRouter({
    env: {
      TREASURY_OWNER_ADDRESS: OWNER,
      SPONSOR_APPROVED_AGREEMENT_REFERENCES: [
        [AGREEMENT_A, 'org-a', 'mainnet', SPONSOR_A, 'asset-grant', 'USDT', OFFICIAL_USDT].join('|'),
        [AGREEMENT_B, 'org-b', 'mainnet', SPONSOR_B, 'asset-grant', 'USDT', OFFICIAL_USDT].join('|'),
      ].join(';'),
    },
    getSession: async (input) => ({
      success: true,
      session: { address: OWNER, network: 'mainnet', origin: ORIGIN, expiresAt: Date.now() + 60_000 },
    }),
    isApprovedScope: ({ consentReference, budget }) => consentReference === budget.approval_reference
      && ((budget.sponsor_reference === 'org-a' && consentReference === AGREEMENT_A && budget.sponsor_address === SPONSOR_A)
        || (budget.sponsor_reference === 'org-b' && consentReference === AGREEMENT_B && budget.sponsor_address === SPONSOR_B)),
    listBudgets: async () => ({ success: true, budgets: [] }),
    readFunding: async () => funding(SPONSOR_A, '0'),
    ...options,
  }))
  const server = createServer(app)
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve('http://127.0.0.1:' + server.address().port + '/api/treasury/owner/sponsor-liquidity?network=mainnet')
  }))
}

function authHeaders() {
  return { Authorization: 'Bearer ' + TOKEN, Origin: ORIGIN, Accept: 'application/json' }
}

test('owner sponsor-liquidity endpoint requires the private owner session', async (t) => {
  let reads = 0
  const url = await listen(t, { readFunding: async () => { reads += 1; return funding(SPONSOR_A, '100000000') } })
  const response = await fetch(url)
  const payload = await response.json()
  assert.equal(response.status, 401)
  assert.equal(payload.error, 'owner-session-required')
  assert.equal(reads, 0)
})

test('aggregates only approved, funded, active non-owner Mainnet USDT capacities', async (t) => {
  const budgets = [
    budget({ sponsorAddress: SPONSOR_A, sponsorReference: 'org-a', agreement: AGREEMENT_A }),
    budget({ sponsorAddress: SPONSOR_B, sponsorReference: 'org-b', agreement: AGREEMENT_B, cap: '50000000', reserved: '5000000', spent: '5000000' }),
    budget({ sponsorAddress: OWNER, sponsorReference: 'owner-wallet', agreement: AGREEMENT_A }),
  ]
  const balances = new Map([[SPONSOR_A, '100000000'], [SPONSOR_B, '50000000'], [OWNER, '500000000']])
  const url = await listen(t, {
    listBudgets: async () => ({ success: true, budgets }),
    readFunding: async (address) => funding(address, balances.get(address) || '0'),
  })
  const response = await fetch(url, { headers: authHeaders() })
  const payload = await response.json()
  assert.equal(response.status, 200)
  assert.equal(payload.success, true)
  assert.equal(payload.network, 'mainnet')
  assert.equal(payload.tokenContract, OFFICIAL_USDT)
  assert.equal(payload.ownerWalletExcluded, true)
  assert.equal(payload.sourceCount, 2)
  assert.equal(payload.verifiedSourceCount, 2)
  assert.equal(payload.eligibleSourceCount, 2)
  assert.equal(payload.onChainBalanceBaseUnits, '150000000')
  assert.equal(payload.availableBaseUnits, '110000000')
  assert.equal(payload.sources.some((item) => item.address === OWNER), false)
  assert.equal(payload.canSubmitSponsoredTransfer, false)
  assert.equal(payload.submissionEnabled, false)
})

test('multiple approved budget records for one sponsor wallet share one chain snapshot and are not double-counted', async (t) => {
  const budgets = [
    budget({ sponsorAddress: SPONSOR_A, sponsorReference: 'org-a', agreement: AGREEMENT_A }),
    budget({ sponsorAddress: SPONSOR_A, sponsorReference: 'org-a', agreement: AGREEMENT_A, cap: '20000000', reserved: '2000000', spent: '3000000' }),
  ]
  let reads = 0
  const url = await listen(t, {
    listBudgets: async () => ({ success: true, budgets }),
    readFunding: async (address) => { reads += 1; return funding(address, '120000000') },
  })
  const payload = await (await fetch(url, { headers: authHeaders() })).json()
  assert.equal(payload.sourceCount, 1)
  assert.equal(payload.verifiedSourceCount, 1)
  assert.equal(payload.onChainBalanceBaseUnits, '120000000')
  assert.equal(payload.availableBaseUnits, '85000000')
  assert.equal(reads, 1)
})

test('underfunded source contributes no available capacity', async (t) => {
  const budgets = [budget()]
  const url = await listen(t, {
    listBudgets: async () => ({ success: true, budgets }),
    readFunding: async (address) => funding(address, '50000000'),
  })
  const payload = await (await fetch(url, { headers: authHeaders() })).json()
  assert.equal(payload.sourceCount, 1)
  assert.equal(payload.onChainBalanceBaseUnits, '50000000')
  assert.equal(payload.availableBaseUnits, '0')
  assert.equal(payload.sources[0].status, 'underfunded')
})

test('a non-allowlisted active budget cannot contribute to available capacity', async (t) => {
  const budgets = [budget({ agreement: 'not-allowlisted-reference' })]
  const url = await listen(t, {
    listBudgets: async () => ({ success: true, budgets }),
    readFunding: async (address) => funding(address, '100000000'),
  })
  const payload = await (await fetch(url, { headers: authHeaders() })).json()
  assert.equal(payload.onChainBalanceBaseUnits, '100000000')
  assert.equal(payload.availableBaseUnits, '0')
  assert.equal(payload.sources[0].status, 'approval-required')
})

test('unavailable provider balance is not converted into zero or counted as verified', async (t) => {
  const budgets = [budget()]
  const url = await listen(t, {
    listBudgets: async () => ({ success: true, budgets }),
    readFunding: async () => ({ success: false, status: 'solidified-balance-read-failed' }),
  })
  const payload = await (await fetch(url, { headers: authHeaders() })).json()
  assert.equal(payload.verifiedSourceCount, 0)
  assert.equal(payload.onChainBalanceBaseUnits, '0')
  assert.equal(payload.availableBaseUnits, '0')
  assert.equal(payload.sources[0].status, 'balance-unavailable')
  assert.equal(payload.sources[0].onChainBalanceBaseUnits, null)
})

test('truncated budget ledger fails closed instead of aggregating an incomplete sponsor set', async (t) => {
  const url = await listen(t, {
    listBudgets: async () => ({ success: true, budgets: Array.from({ length: 100 }, (_, index) => budget({ sponsorReference: 'org-' + index })) }),
  })
  const response = await fetch(url, { headers: authHeaders() })
  const payload = await response.json()
  assert.equal(response.status, 503)
  assert.equal(payload.error, 'sponsor-budget-ledger-truncated')
  assert.equal(payload.availableBaseUnits, '0')
})
