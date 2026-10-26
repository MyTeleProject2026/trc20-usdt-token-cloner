import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const app = await readFile(new URL('../src/WorkflowApp.tsx', import.meta.url), 'utf8')
const routes = await readFile(new URL('../server/routes/native-tron.mjs', import.meta.url), 'utf8')

test('the simplified frontend does not include the legacy admin ledger console', () => {
  assert.ok(!app.includes('SponsorLedgerConsole'))
  assert.ok(!app.includes('adminToken'))
  assert.ok(app.includes('/api/auth/tron/logout'))
  assert.ok(app.includes('walletIdentity.sessionToken'))
  assert.ok(!app.includes('SPONSOR_ADMIN_API_TOKEN'))
  assert.ok(!app.includes('Authorization: `Bearer'))
  assert.ok(!app.includes('/api/tron/sponsorship/budgets'))
  assert.ok(!app.includes('/api/tron/sponsorship/role-budget-drafts'))
})

test('backend sponsor budget and transfer audit endpoints are preserved', () => {
  assert.ok(routes.includes("router.get('/sponsorship/budgets'"))
  assert.ok(routes.includes("router.get('/sponsorship/transfers'"))
  assert.ok(routes.includes("router.get('/sponsorship/roles/reconciliation'"))
  assert.ok(routes.includes("router.post('/sponsorship/role-budget-drafts'"))
  assert.ok(routes.includes('Sponsored transaction submission is independently disabled') || routes.includes('This endpoint is read-only'))
})

test('budget activation uses a fresh snapshot for the exact sponsor role and address', () => {
  const start = routes.indexOf("router.post('/sponsorship/budgets/:id/activate'")
  const end = routes.indexOf("router.get('/sponsorship/reconciliation'", start)
  assert.ok(start >= 0 && end > start, 'budget activation handler must be present')
  const handler = routes.slice(start, end)
  assert.ok(handler.includes('readSponsorRoleFunding(budget.network, { refresh: true })'))
  assert.ok(handler.includes("budget.purpose === 'network-fee' ? 'networkFeeSponsor' : 'assetPrincipalSponsor'"))
  assert.ok(handler.includes('fundingSnapshot.sponsorAddress !== budget.sponsor_address'))
  assert.ok(handler.includes('roleResult.configuredAddressesDistinct !== true'))
  assert.ok(!handler.includes('readSponsorFundingStatus(budget.network, { refresh: true })'))
})

test('active frontend stays non-submitting and does not turn ledger figures into spendable balance', () => {
  assert.ok(app.includes('Sponsored transfer unavailable'))
  assert.ok(app.includes('No receiver credit is inferred') || app.includes('pending sponsor grant'))
  assert.ok(!app.includes('/api/gasfree/submit'))
})
