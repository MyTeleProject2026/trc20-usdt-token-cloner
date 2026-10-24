import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const workflow = await readFile(new URL('../src/WorkflowApp.tsx', import.meta.url), 'utf8')
const server = await readFile(new URL('../server/index.mjs', import.meta.url), 'utf8')
const gasfree = await readFile(new URL('../server/routes/gasfree.mjs', import.meta.url), 'utf8')

test('GasFree provider diagnostics remain a backend capability and are not exposed as a send action', () => {
  assert.ok(server.includes("import gasFreeRoutes from './routes/gasfree.mjs'"))
  assert.ok(server.includes("app.use('/api/gasfree', gasFreeRoutes)"))
  assert.ok(gasfree.includes("router.get('/capabilities'"))
  assert.ok(gasfree.includes("router.get('/account'"))
  assert.ok(gasfree.includes("router.get('/trace'"))
  assert.ok(gasfree.includes("router.post('/preflight'"))
  assert.ok(gasfree.includes("router.post('/submit'"))
  assert.ok(gasfree.includes('sponsored-submission-disabled'))
  assert.ok(gasfree.includes('submissionEnabled: false'))
})

test('active UI reads sponsor roles/status but never asks for provider secrets or submits through GasFree', () => {
  assert.ok(workflow.includes('/api/tron/sponsorship/roles?network='))
  assert.ok(workflow.includes('/api/tron/sponsorship/status'))
  assert.ok(!workflow.includes('GASFREE_API_SECRET'))
  assert.ok(!workflow.includes('GASFREE_API_KEY'))
  assert.ok(!workflow.includes('/api/gasfree/submit'))
  assert.ok(!workflow.includes('sendRawTransaction'))
  assert.ok(workflow.includes('sponsored submission disabled'))
  assert.ok(workflow.includes('No sender-funded fallback'))
})

test('provider credential presence and sponsor balance are not presented as transfer authorization', () => {
  assert.match(gasfree, /providerFundingVerified: false/)
  assert.match(gasfree, /canSubmitSponsoredTransfer: false/)
  assert.match(gasfree, /No transfer was submitted/)
  assert.ok(workflow.includes('does not prove'))
  assert.ok(workflow.includes('The sponsor must cover eligible fees'))
})

test('provider research panel surfaces candidate limits without exposing credentials or enabling submission', () => {
  assert.ok(workflow.includes('ProviderResearchPanel'))
  assert.ok(workflow.includes('sponsorship?.providerResearch'))
  assert.ok(workflow.includes('No verified full sponsor'))
  assert.ok(workflow.includes('Does not provide asset principal.'))
  assert.ok(workflow.includes('Not integrated'))
  assert.ok(!workflow.includes('GASFREE_API_SECRET'))
  assert.ok(!workflow.includes('GASFREE_API_KEY'))
  assert.ok(!workflow.includes('/api/gasfree/submit'))
})
