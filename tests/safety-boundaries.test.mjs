import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const simulator = await readFile(new URL('../src/TransferSimulator.tsx', import.meta.url), 'utf8')
const token = await readFile(new URL('../contracts/IndependentTRC20.sol', import.meta.url), 'utf8')

test('simulator clearly labels records as fictional and not on-chain', () => {
  assert.match(simulator, /SIMULATION ONLY/)
  assert.match(simulator, /NOT ON-CHAIN/)
  assert.match(simulator, /fictional balances and records/)
  assert.match(simulator, /Demo reference/)
})

test('simulator has no blockchain transaction submission or wallet signing calls', () => {
  assert.doesNotMatch(simulator, /\.sendTransaction\s*\(/)
  assert.doesNotMatch(simulator, /\.signTransaction\s*\(/)
  assert.doesNotMatch(simulator, /tronWeb|TronWeb|window\.ethereum|window\.tronLink/)
  assert.doesNotMatch(simulator, /fetch\s*\(|axios\./)
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
