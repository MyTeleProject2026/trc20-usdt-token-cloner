import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const app = await readFile(new URL('../src/WorkflowApp.tsx', import.meta.url), 'utf8')
const entry = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8')
const sponsorship = await readFile(new URL('../server/sponsorship-status.mjs', import.meta.url), 'utf8')

test('production API calls default to the deployed backend', () => {
  assert.ok(app.includes("import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? '' : 'https://trc20-usdt-token-cloner-api.onrender.com')"))
})

test('the active interface is the single-owner wallet shell; legacy workflow remains testnet-restricted', () => {
  assert.ok(entry.includes("import OwnerControlApp from './OwnerControlApp'"))
  assert.ok(!entry.includes("import App from './WorkflowApp.tsx'"))
  assert.ok(app.includes("type NetworkId = 'shasta' | 'nile'"))
  assert.ok(app.includes("shasta: 'api.shasta.trongrid.io'"))
  assert.ok(app.includes("nile: 'nile.trongrid.io'"))
  assert.ok(app.includes('Network fee sponsor'))
  assert.ok(app.includes('Asset principal sponsor'))
  assert.ok(app.includes('Sender account'))
  assert.ok(app.includes('Receiver & amount'))
  assert.ok(app.includes('Review & availability'))
  assert.doesNotMatch(app, /chooseNetwork\('mainnet'\)/)
  assert.ok(app.includes('MainnetBalanceSnapshot'))
  assert.ok(app.includes('read-only lookup; no wallet connection is required'), 'Mainnet access in this workspace must remain read-only')
  assert.ok(app.includes('sendDirectTestnetTransfer'))
  assert.ok(app.includes('transactionBuilder.sendTrx'))
  assert.ok(app.includes('triggerSmartContract'))
  assert.ok(app.includes('checkedWalletNetwork(tronWeb, network)'))
  assert.ok(app.includes("if (network !== 'nile' && network !== 'shasta')"))
  assert.ok(app.includes('/api/tron/verify-native-transfer/'))
  assert.ok(app.includes('/api/tron/verify-trc20-transfer/'))
  assert.doesNotMatch(app, /eth_sendTransaction/)
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

test('sponsored submission stays disabled while direct testnet sends remain wallet-funded', () => {
  assert.ok(app.includes('No sender-funded fallback'))
  assert.ok(app.includes('sponsored submission disabled'))
  assert.ok(app.includes('Sponsored transfer unavailable'))
  assert.ok(app.includes('disabled aria-disabled="true"'))
  assert.ok(app.includes('sendRawTransaction(signed)'))
  assert.ok(app.includes('tronWeb.trx.sign(unsigned)'))
  assert.ok(!app.includes('eth_sendTransaction'))
  assert.ok(!app.includes('/api/gasfree/submit'))
  assert.ok(!app.includes('/api/tron/sponsorship/budgets/'))
  assert.match(sponsorship, /enabled: false/)
  assert.match(sponsorship, /canSubmitSponsoredTransfer: false/)
})
