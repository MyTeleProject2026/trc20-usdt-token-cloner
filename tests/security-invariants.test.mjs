import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const contract = await readFile(new URL('../contracts/IndependentTRC20.sol', import.meta.url), 'utf8')
const app = await readFile(new URL('../src/WorkflowApp.tsx', import.meta.url), 'utf8')
const entry = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8')

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

test('the active frontend is the staged workflow and not the legacy simulator', () => {
  assert.ok(entry.includes("import App from './WorkflowApp.tsx'"))
  assert.ok(!app.includes('TransferSimulator'))
  assert.ok(!app.includes('fictional balances and records'))
  assert.ok(!app.includes('/api/gasfree/submit'))
  assert.ok(app.includes('disabled aria-disabled="true"'))
})
