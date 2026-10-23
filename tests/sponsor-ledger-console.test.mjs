import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const component = await readFile(new URL('../src/SponsorLedgerConsole.tsx', import.meta.url), 'utf8')
const page = await readFile(new URL('../src/SponsorProviderPages.tsx', import.meta.url), 'utf8')

test('protected sponsor ledger console loads real budget and lifecycle endpoints using an explicit bearer token', () => {
  assert.ok(component.includes('/api/tron/sponsorship/budgets?'))
  assert.ok(component.includes('/api/tron/sponsorship/transfers?'))
  assert.ok(component.includes('/api/tron/sponsorship/roles/reconciliation?network='))
  assert.ok(component.includes('/api/tron/sponsorship/role-budget-drafts'))
  assert.ok(component.includes('Create testnet budget draft'))
  assert.ok(component.includes('Mainnet drafts are disabled here'))
  assert.ok(component.includes("['shasta', 'nile'].includes(ledgerNetwork)"))
  assert.ok(component.includes('Authorization: `Bearer ${token}`'))
  assert.ok(component.includes("credentials: 'omit'"))
  assert.ok(component.includes("cache: 'no-store'"))
  assert.ok(component.includes('setLedgerNetwork(network)'))
  assert.ok(page.includes("import SponsorLedgerConsole from './SponsorLedgerConsole'"))
  assert.ok(page.includes('<SponsorLedgerConsole network={network} />'))
})

test('admin token is ephemeral and can be cleared without browser persistence', () => {
  assert.ok(component.includes('setAdminToken'))
  assert.ok(component.includes('Clear token and records'))
  assert.ok(component.includes('not written to localStorage or sessionStorage'))
  assert.ok(!component.includes('localStorage.setItem('))
  assert.ok(!component.includes('sessionStorage.setItem('))
})

test('ledger UI is read-only and distinguishes ledger units from chain balances', () => {
  assert.ok(component.includes('Read-only access to the real PostgreSQL sponsor budget and transfer lifecycle tables'))
  assert.ok(component.includes('ledger_available_base_units'))
  assert.ok(component.includes('not a chain balance or spendable receiver credit'))
  assert.ok(component.includes('No records were changed'))
  assert.ok(component.includes('Sponsored transaction submission is independently disabled'))
  assert.ok(!component.includes('/sponsorship/budgets/${'))
  assert.ok(!component.includes('/api/gasfree/submit'))
})

test('console presents per-role reconciliation without hiding ledger history on reconciliation errors', () => {
  assert.ok(component.includes('Independent sponsor budget reconciliation'))
  assert.ok(component.includes('Sponsor A · fee/resource allocations'))
  assert.ok(component.includes('Sponsor B · asset-principal allocations'))
  assert.ok(component.includes('reconciliationError'))
  assert.ok(component.includes('successfully loaded budget/transfer history'))
  assert.ok(component.includes('Mainnet sponsored submission remains disabled'))
})

test('role draft form uses server-side sponsor identity and never enables transfers', () => {
  assert.ok(component.includes('role: draftRole'))
  assert.ok(component.includes('budgetBaseUnits: draftBudgetBaseUnits'))
  assert.ok(component.includes("Authorization: `Bearer ${token}`"))
  assert.ok(component.includes('credentials: \'omit\''))
  assert.ok(component.includes('It does not activate the cap, reserve funds, sign or send a transaction'))
  assert.ok(!component.includes('/api/gasfree/submit'))
})
