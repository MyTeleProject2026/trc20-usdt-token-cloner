import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const entry = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8')
const app = await readFile(new URL('../src/WorkflowApp.tsx', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')

test('the live frontend entrypoint renders the staged workflow, not the legacy tabbed workspace', () => {
  assert.ok(entry.includes("import App from './WorkflowApp.tsx'"))
  assert.ok(!entry.includes("import App from './App.tsx'"))
  assert.ok(!entry.includes('TransferSimulator'))
  assert.ok(!entry.includes('ReceiverHistory'))
  assert.ok(app.includes('Network fee sponsor'))
  assert.ok(app.includes('Asset principal sponsor'))
  assert.ok(app.includes('Sender account'))
  assert.ok(app.includes('Receiver & amount'))
  assert.ok(app.includes('Review & availability'))
})

test('stages are gated by prior validation and live network reads', () => {
  assert.ok(app.includes('const canEnterStep = (index: number) => index === 0 || stageCompletion[index - 1] === true'))
  assert.ok(app.includes('disabled={!canEnterStep(index)}'))
  assert.ok(app.includes('disabled={!stageCompletion[step]}'))
  assert.ok(app.includes('const feeStageValid = feeSponsorRequired && sponsorStageLoaded'))
  assert.ok(app.includes('const senderStageValid = ADDRESS_PATTERN.test(senderAddress)'))
  assert.ok(app.includes('const receiverStageValid = ADDRESS_PATTERN.test(receiverAddress)'))
})

test('wallet inspection is testnet-only and uses real read-only balance endpoints', () => {
  assert.ok(app.includes("shasta: 'api.shasta.trongrid.io'"))
  assert.ok(app.includes("nile: 'nile.trongrid.io'"))
  assert.ok(app.includes('/api/tron/native-balance?network='))
  assert.ok(app.includes('/api/tron/token-balance?network='))
  assert.ok(app.includes('Watch-only address'))
  assert.ok(app.includes('checkedWalletNetwork(tronWeb, network)'))
  assert.ok(!app.includes('eth_sendTransaction'))
  assert.ok(!app.includes('sendRawTransaction'))
  assert.ok(!app.includes('/api/gasfree/submit'))
  assert.ok(!app.includes('/api/tron/sponsorship/budgets/'))
})

test('the UI never submits a transfer or promises sponsor payment while backend capability is disabled', () => {
  assert.ok(app.includes('sponsored transfer submission disabled'))
  assert.ok(app.includes('No sender-funded fallback'))
  assert.ok(app.includes('Sponsored transfer unavailable'))
  assert.ok(app.includes('disabled aria-disabled="true"'))
  assert.ok(app.includes('Copy request summary'))
  assert.ok(app.includes('Recheck sponsor readiness'))
})

test('the glass workspace includes accessible responsive desktop and mobile stage navigation', () => {
  assert.ok(app.includes('aria-label="Transfer stages"'))
  assert.ok(app.includes('aria-label="Mobile transfer stages"'))
  assert.ok(app.includes('aria-current={step === index ? \'step\' : undefined}'))
  assert.ok(css.includes('.studio-sidebar'))
  assert.ok(css.includes('.studio-mobile-steps'))
  assert.ok(css.includes('@media (max-width: 880px)'))
  assert.ok(css.includes('backdrop-filter: blur'))
})
