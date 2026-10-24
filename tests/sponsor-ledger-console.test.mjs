import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const app = await readFile(new URL('../src/WorkflowApp.tsx', import.meta.url), 'utf8')
const routes = await readFile(new URL('../server/routes/native-tron.mjs', import.meta.url), 'utf8')

test('the simplified frontend does not include the legacy admin ledger console', () => {
  assert.ok(!app.includes('SponsorLedgerConsole'))
  assert.ok(!app.includes('adminToken'))
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

test('active frontend stays non-submitting and does not turn ledger figures into spendable balance', () => {
  assert.ok(app.includes('Sponsored transfer unavailable'))
  assert.ok(app.includes('No receiver credit is inferred') || app.includes('pending sponsor grant'))
  assert.ok(!app.includes('/api/gasfree/submit'))
})
