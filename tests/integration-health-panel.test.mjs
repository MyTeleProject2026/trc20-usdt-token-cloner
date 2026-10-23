import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const component = await readFile(new URL('../src/IntegrationHealthPanel.tsx', import.meta.url), 'utf8')
const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')

test('diagnostics query live backend readiness and independently scoped sponsor state', () => {
  assert.ok(component.includes("readJson('/health')"))
  assert.ok(component.includes("readJson('/api/readiness')"))
  assert.ok(component.includes("readJson('/api/tron/sponsorship/status')"))
  assert.ok(component.includes('/api/tron/sponsorship/roles?network='))
  assert.ok(component.includes("readJson('/api/gasfree/config-status')"))
  assert.ok(component.includes('/api/gasfree/capabilities?network=mainnet'))
  assert.ok(component.includes("credentials: 'omit'"))
  assert.ok(component.includes("cache: 'no-store'"))
  assert.ok(component.includes('signal: AbortSignal.timeout(12_000)'))
  assert.ok(app.includes("import IntegrationHealthPanel from './IntegrationHealthPanel'"))
  assert.ok(app.includes('<IntegrationHealthPanel network={network} />'))
})

test('dashboard distinguishes distinct addresses, on-chain reads, and transfer authorization', () => {
  assert.ok(component.includes('Two distinct addresses configured'))
  assert.ok(component.includes('Address separation failed'))
  assert.ok(component.includes('requiredEnvironment'))
  assert.ok(component.includes('Configure these as Render environment variables for the selected network'))
  assert.ok(component.includes('never put API secrets in frontend variables'))
  assert.ok(component.includes('Funding agreements, signer authorization, and permission to send remain unverified'))
  assert.ok(component.includes('submission remains disabled'))
  assert.ok(component.includes('no cross-network fallback is used'))
  assert.ok(component.includes('Credential values are never requested or displayed'))
  assert.ok(!component.includes('/api/gasfree/submit'))
})

test('GasFree provider reachability is checked only on Mainnet, with no Shasta-to-Nile fallback', () => {
  assert.ok(component.includes("network === 'mainnet' ? readJson('/api/gasfree/capabilities?network=mainnet') : Promise.resolve(null)"))
  assert.ok(component.includes('GasFree is configured for Mainnet and Nile only'))
  assert.ok(component.includes('Shasta unsupported'))
})

test('refresh button re-runs diagnostic reads and announces the last check', () => {
  assert.ok(component.includes('onClick={() => { setLoading(true); setRefreshNonce((value) => value + 1) }}'))
  assert.ok(component.includes('disabled={loading}'))
  assert.ok(component.includes('Last checked:'))
})
