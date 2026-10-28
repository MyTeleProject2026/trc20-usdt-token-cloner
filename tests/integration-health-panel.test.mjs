import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const app = await readFile(new URL('../src/WorkflowApp.tsx', import.meta.url), 'utf8')
const entry = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8')
const server = await readFile(new URL('../server/index.mjs', import.meta.url), 'utf8')

test('legacy sponsor workflow remains implemented but is not exposed by the owner-only app entry', () => {
  assert.ok(app.includes('/api/tron/sponsorship/roles?network='))
  assert.ok(app.includes('/api/tron/sponsorship/status'))
  assert.ok(app.includes('loadSponsorStatus(true)'))
  assert.ok(app.includes('cache: \'no-store\''))
  assert.ok(app.includes('Sponsor status refreshed successfully'))
  assert.ok(entry.includes("import App from './WorkflowApp.tsx'"))
})

test('the wizard keeps readiness, balance visibility, and transfer authorization conceptually separate', () => {
  assert.ok(app.includes('The backend has not verified an authorized fee sponsor'))
  assert.ok(app.includes('balance snapshot is read-only'))
  assert.ok(app.includes('A configured sponsor address or visible balance is not proof of signing authorization'))
  assert.ok(app.includes('sponsored submission disabled'))
  assert.ok(app.includes('no transaction was created or broadcast'))
  assert.ok(!app.includes('/api/gasfree/submit'))
})

test('legacy integration dashboard is no longer part of the active UI', () => {
  assert.ok(!entry.includes('IntegrationHealthPanel'))
  assert.ok(!app.includes('IntegrationHealthPanel'))
  assert.ok(!app.includes('/api/readiness'))
})

test('active wizard displays backend environment readiness without creating a transfer', () => {
  assert.ok(app.includes('/api/tron/sponsorship/integration-readiness'))
  assert.ok(app.includes('SponsorIntegrationReadinessPanel'))
  assert.ok(app.includes('Configuration presence only'))
  assert.ok(app.includes('sponsored submission disabled'))
  assert.ok(!app.includes('/api/tron/sponsorship/submit'))
  assert.ok(server.includes("import sponsorIntegrationReadinessRoutes from './routes/sponsor-integration-readiness.mjs'"))
  assert.ok(server.includes("app.use('/api/tron', sponsorIntegrationReadinessRoutes)"))
})
