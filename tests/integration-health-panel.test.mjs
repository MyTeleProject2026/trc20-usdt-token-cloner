import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const component = await readFile(new URL('../src/IntegrationHealthPanel.tsx', import.meta.url), 'utf8')
const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')

test('diagnostics query live backend readiness and current network sponsor state', () => {
  assert.ok(component.includes("readJson('/health')"))
  assert.ok(component.includes("readJson('/api/readiness')"))
  assert.ok(component.includes("readJson('/api/tron/sponsorship/status')"))
  assert.ok(component.includes('/api/tron/sponsorship/funding-status?network='))
  assert.ok(component.includes('/api/tron/sponsorship/resource-status?network='))
  assert.ok(component.includes("readJson('/api/gasfree/config-status')"))
  assert.ok(component.includes('/api/gasfree/capabilities?network=mainnet'))
  assert.ok(component.includes("credentials: 'omit'"))
  assert.ok(component.includes("cache: 'no-store'"))
  assert.ok(app.includes("import IntegrationHealthPanel from './IntegrationHealthPanel'"))
  assert.ok(app.includes('<IntegrationHealthPanel network={network} />'))
})

test('diagnostics never confuse chain balances, resources, credentials, or policy with transfer authorization', () => {
  assert.ok(component.includes('Chain balances are not an approved budget, grant, or receiver credit'))
  assert.ok(component.includes('Capacity is a snapshot, not proof a transaction will be fully covered'))
  assert.ok(component.includes('No verified sponsor authorization is active'))
  assert.ok(component.includes('no cross-network fallback is used'))
  assert.ok(component.includes('Credential values are never requested or displayed'))
  assert.ok(!component.includes('/api/gasfree/submit'))
})

test('provider reachability is queried only on Mainnet and never uses a Shasta-to-Nile fallback', () => {
  assert.ok(component.includes("network === 'mainnet' ? readJson('/api/gasfree/capabilities?network=mainnet') : Promise.resolve(null)"))
  assert.ok(component.includes('GasFree is configured for Mainnet and Nile only'))
  assert.ok(component.includes('Shasta unsupported'))
  assert.ok(component.includes('sponsored submission remain separate'))
})

test('refresh button re-runs diagnostic reads and announces the last check', () => {
  assert.ok(component.includes('onClick={() => { setLoading(true); setRefreshNonce((value) => value + 1) }}'))
  assert.ok(component.includes('disabled={loading}'))
  assert.ok(component.includes('Last checked:'))
})
