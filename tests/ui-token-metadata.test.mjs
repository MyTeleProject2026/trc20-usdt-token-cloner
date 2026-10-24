import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const app = await readFile(new URL('../src/WorkflowApp.tsx', import.meta.url), 'utf8')
const contract = await readFile(new URL('../contracts/IndependentTRC20.sol', import.meta.url), 'utf8')

test('token request UI identifies a specific TRC-20 contract and never treats a symbol as official USDT identity', () => {
  assert.ok(app.includes('TRC-20 test token'))
  assert.ok(app.includes('Token contract address on'))
  assert.ok(app.includes('This is not official Mainnet USDT'))
  assert.ok(app.includes('token symbol alone does not prove identity or exchange support'))
  assert.ok(!app.includes("setAssetKind('USDT')"))
  assert.match(contract, /independent token, not official Tether USDT/i)
  assert.match(contract, /uint8 public constant decimals = 18/)
})

test('the independent VTRC contract metadata remains distinct from official Tether', () => {
  assert.match(contract, /name must be TRC20/)
  assert.match(contract, /symbol must be VTRC/)
  assert.match(contract, /independent token, not official Tether USDT/i)
})
