import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const component = await readFile(new URL('../src/SponsorLedgerConsole.tsx', import.meta.url), 'utf8')
const page = await readFile(new URL('../src/SponsorProviderPages.tsx', import.meta.url), 'utf8')

test('protected sponsor ledger console loads real budget and lifecycle endpoints using an explicit bearer token', () => {
  assert.ok(component.includes('/api/tron/sponsorship/budgets?'))
  assert.ok(component.includes('/api/tron/sponsorship/transfers?'))
  assert.ok(component.includes('Authorization: `Bearer ${token}`'))
  assert.ok(component.includes("credentials: 'omit'"))
  assert.ok(component.includes("cache: 'no-store'"))
  assert.ok(page.includes("import SponsorLedgerConsole from './SponsorLedgerConsole'"))
  assert.ok(page.includes('<SponsorLedgerConsole network={network} />'))
})

test('admin token is ephemeral and can be cleared without browser persistence', () => {
  assert.ok(component.includes('setAdminToken'))
  assert.ok(component.includes('Clear token and records'))
  assert.ok(component.includes('not written to localStorage or sessionStorage'))
  assert.ok(!component.includes('localStorage'))
  assert.ok(!component.includes('sessionStorage'))
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
