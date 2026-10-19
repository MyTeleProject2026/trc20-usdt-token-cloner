import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const contract = await readFile(new URL('../contracts/IndependentTRC20.sol', import.meta.url), 'utf8')
const simulator = await readFile(new URL('../src/TransferSimulator.tsx', import.meta.url), 'utf8')
const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')

function functionBody(source, signature) {
  const start = source.indexOf(signature)
  assert.notEqual(start, -1, `missing function: ${signature}`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  assert.fail(`unterminated function: ${signature}`)
}

test('transfer spends only the caller balance and rejects insufficient funds', () => {
  const body = functionBody(contract, 'function transfer(address recipient, uint256 amount)')
  assert.match(body, /_balances\[msg\.sender\]\s*>=\s*amount/)
  assert.match(body, /_balances\[msg\.sender\]\s*-=?\s*amount/)
  assert.match(body, /_balances\[recipient\]\s*\+=\s*amount/)
  assert.doesNotMatch(body, /_balances\[[^\]]+\]\s*=\s*0/)
})

test('transferFrom requires and consumes an allowance', () => {
  const body = functionBody(contract, 'function transferFrom(address sender, address recipient, uint256 amount)')
  assert.match(body, /_balances\[sender\]\s*>=\s*amount/)
  assert.match(body, /_allowances\[sender\]\[msg\.sender\]\s*>=\s*amount/)
  assert.match(body, /_allowances\[sender\]\[msg\.sender\]\s*-=?\s*amount/)
  assert.match(body, /_balances\[sender\]\s*-=?\s*amount/)
  assert.match(body, /_balances\[recipient\]\s*\+=\s*amount/)
})

test('token contract exposes no arbitrary balance-edit or privileged transfer function', () => {
  assert.doesNotMatch(contract, /function\s+(?:adminTransfer|setBalance|forceTransfer|confiscate|mint)\s*\(/i)
  assert.match(contract, /name must be TRC20/)
  assert.match(contract, /symbol must be VTRC/)
})

test('transfer simulator is clearly labeled as local-only and fictional', () => {
  assert.match(simulator, /SIMULATION ONLY/)
  assert.match(simulator, /NOT ON-CHAIN/)
  assert.match(simulator, /fictional balances and records/)
  assert.match(simulator, /setRecords\(\(current\) =>/)
})

test('simulator does not submit network or wallet transactions', () => {
  assert.doesNotMatch(simulator, /\bTronWeb\b|\bfetch\s*\(|sendRawTransaction|triggerSmartContract|\.trx\.send|eth_sendTransaction|requestAccounts/i)
  assert.match(app, /activeTab === 'simulation' && <TransferSimulator\s*\/>/)
})
