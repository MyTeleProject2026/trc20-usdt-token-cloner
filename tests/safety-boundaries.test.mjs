import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const token = await readFile(new URL('../contracts/IndependentTRC20.sol', import.meta.url), 'utf8')
const entry = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8')
const app = await readFile(new URL('../src/WorkflowApp.tsx', import.meta.url), 'utf8')

test('the active owner UI excludes legacy simulator routes and fictional balances', () => {
  assert.ok(entry.includes("import OwnerControlApp from './OwnerControlApp'"))
  assert.ok(!entry.includes("import App from './WorkflowApp.tsx'"))
  assert.ok(!entry.includes('TransferSimulator'))
  assert.ok(!app.includes('SIMULATION ONLY'))
  assert.ok(!app.includes('fictional balances and records'))
})

test('only the explicitly chosen testnet direct-send path can sign and broadcast', () => {
  assert.ok(app.includes("if (network !== 'nile' && network !== 'shasta')"))
  assert.ok(app.includes('checkedWalletNetwork(tronWeb, network)'))
  assert.ok(app.includes('transactionBuilder.sendTrx'))
  assert.ok(app.includes('triggerSmartContract'))
  assert.ok(app.includes('tronWeb.trx.sign(unsigned)'))
  assert.ok(app.includes('sendRawTransaction(signed)'))
  assert.ok(app.includes('/api/tron/verify-native-transfer/'))
  assert.ok(app.includes('/api/tron/verify-trc20-transfer/'))
  assert.doesNotMatch(app, /eth_sendTransaction/)
  assert.ok(!app.includes('/api/gasfree/submit'))
  assert.ok(app.includes('Sponsored transfer unavailable'))
  assert.ok(app.includes('No sender-funded fallback'))
  assert.ok(app.includes('This is a real on-chain testnet transaction, not a simulation.'))
})

test('token is explicitly distinct from official Tether', () => {
  assert.match(token, /independent token, not official Tether USDT/i)
  assert.match(token, /tokenSymbol\)\) == keccak256\(bytes\("VTRC"\)\)/)
  assert.doesNotMatch(token, /tokenSymbol.*USDT/)
})

test('transferFrom requires an allowance and decrements it', () => {
  const start = token.indexOf('function transferFrom(')
  assert.notEqual(start, -1, 'transferFrom function must exist')
  const body = token.slice(start)
  assert.match(body, /_allowances\[sender\]\[msg\.sender\] >= amount/)
  assert.match(body, /_allowances\[sender\]\[msg\.sender\] -= amount/)
  assert.match(body, /_balances\[sender\] -= amount/)
  assert.doesNotMatch(body, /_balances\[sender\]\s*=\s*0/)
})

test('token transfer rejects zero recipient and insufficient balance', () => {
  const start = token.indexOf('function transfer(')
  const end = token.indexOf('function approve(', start)
  const body = token.slice(start, end)
  assert.match(body, /require\(recipient != address\(0\)/)
  assert.match(body, /require\(_balances\[msg\.sender\] >= amount/)
})
