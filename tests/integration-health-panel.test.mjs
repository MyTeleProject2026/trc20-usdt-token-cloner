import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const component = await readFile(new URL('../src/IntegrationHealthPanel.tsx', import.meta.url), 'utf8')
const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')

test('integration diagnostics read the live health, readiness, sponsorship, and GasFree status endpoints', () => {
  assert.ok(component.includes("readJson('/health')"))
  assert.ok(component.includes("readJson('/api/readiness')"))
  assert.ok(component.includes("readJson('/api/tron/sponsorship/status')"))
  assert.ok(component.includes("readJson('/api/gasfree/config-status')"))
  assert.ok(component.includes('credentials: \'omit\''))
  assert.ok(component.includes("cache: 'no-store'"))
  assert.ok(app.includes("import IntegrationHealthPanel from './IntegrationHealthPanel'"))
  assert.ok(app.includes('<IntegrationHealthPanel network={network} />'))
})

test('diagnostics distinguish sponsor credential presence from transfer authorization and funding', () => {
  assert.ok(component.includes('Credential presence does not prove provider reachability or sponsor funding'))
  assert.ok(component.includes('No verified sponsor authorization is active'))
  assert.ok(component.includes('submission remains disabled'))
  assert.ok(component.includes('Secrets are never requested or shown'))
  assert.ok(!component.includes('/api/gasfree/submit'))
})

test('refresh control is wired to re-run diagnostics and loading state', () => {
  assert.ok(component.includes('onClick={() => { setLoading(true); setRefreshNonce((value) => value + 1) }}'))
  assert.ok(component.includes('disabled={loading}'))
  assert.ok(component.includes('Last checked:'))
})
