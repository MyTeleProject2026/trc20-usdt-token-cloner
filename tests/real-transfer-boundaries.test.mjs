import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const app = await readFile(new URL('../src/WorkflowApp.tsx', import.meta.url), 'utf8')
const entry = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8')
const sponsorship = await readFile(new URL('../server/sponsorship-status.mjs', import.meta.url), 'utf8')

test('production API calls default to the deployed backend', () => {
  assert.ok(app.includes("import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? '' : 'https://trc20-usdt-token-cloner-api.onrender.com')"))
})

test('the live interface is a five-stage testnet-only flow', () => {
  assert.ok(entry.includes("import App from './WorkflowApp.tsx'"))
  assert.ok(app.includes("type NetworkId = 'shasta' | 'nile'"))
  assert.ok(app.includes("shasta: 'api.shasta.trongrid.io'"))
  assert.ok(app.includes("nile: 'nile.trongrid.io'"))
  assert.ok(app.includes('Network fee sponsor'))
  assert.ok(app.includes('Asset principal sponsor'))
  assert.ok(app.includes('Sender account'))
  assert.ok(app.includes('Receiver & amount'))
  assert.ok(app.includes('Review & availability'))
  assert.ok(!app.includes("network: 'mainnet'"))
})

test('sponsorship cannot be represented as enabled without a verified integration', () => {
  assert.match(sponsorship, /enabled: false/)
  assert.match(sponsorship, /mainnetEnabled: false/)
  assert.match(sponsorship, /canSubmitSponsoredTransfer: false/)
  assert.match(sponsorship, /not-integrated/)
})

test('wallet and receiver balance checks use real read-only backend endpoints', () => {
  assert.ok(app.includes('/api/tron/native-balance?network='))
  assert.ok(app.includes('/api/tron/token-balance?network='))
  assert.ok(app.includes('/api/tron/sponsorship/roles?network='))
  assert.ok(app.includes('/api/tron/sponsorship/status'))
  assert.ok(app.includes('checkedWalletNetwork(tronWeb, network)'))
  assert.ok(app.includes('solidified chain state'))
})

test('the staged frontend never signs or broadcasts and cannot fall back to sender funds', () => {
  assert.ok(app.includes('No sender-funded fallback'))
  assert.ok(app.includes('sponsored submission disabled'))
  assert.ok(app.includes('Sponsored transfer unavailable'))
  assert.ok(app.includes('disabled aria-disabled="true"'))
  assert.ok(!app.includes('sendRawTransaction'))
  assert.ok(!app.includes('eth_sendTransaction'))
  assert.ok(!app.includes('/api/gasfree/submit'))
  assert.ok(!app.includes('/api/tron/sponsorship/budgets/'))
})
