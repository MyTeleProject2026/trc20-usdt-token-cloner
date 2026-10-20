import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
const contract = await readFile(new URL('../contracts/IndependentTRC20.sol', import.meta.url), 'utf8')

test('independent token information is not presented as official USDT supply', () => {
  assert.match(app, /Independent token decimals:/)
  assert.match(app, /18 \(VTRC\)/)
  assert.match(app, /TRC20 \/ VTRC — not official USDT/)
  assert.match(app, /Supply is determined by the deployed contract/)
  assert.doesNotMatch(app, /Total USDT Supply:<\/span>\s*<span[^>]*>&gt; 58 Billion USDT/)
  assert.match(contract, /independent token, not official Tether USDT/i)
  assert.match(contract, /uint8 public constant decimals = 18/)
})
