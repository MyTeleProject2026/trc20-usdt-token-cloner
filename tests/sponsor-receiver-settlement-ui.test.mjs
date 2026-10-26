import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const sourceUrl = new URL('../src/SponsorSignerConsole.tsx', import.meta.url)

test('sponsor console verifies the stored transaction before showing a receiver balance', async () => {
  const source = await readFile(sourceUrl, 'utf8')
  assert.match(source, /\/api\/tron\/verify-native-transfer\//)
  assert.match(source, /\/api\/tron\/verify-trc20-transfer\//)
  assert.match(source, /\/api\/tron\/native-balance/)
  assert.match(source, /\/api\/tron\/token-balance/)
  assert.match(source, /chainResult\.payload\.verified !== true/)
  assert.match(source, /receiverBalance: null/)
  assert.match(source, /Verify receipt and read receiver balance/)
})

test('sponsor console does not imply exchange credit or fee-budget settlement from chain verification', async () => {
  const source = await readFile(sourceUrl, 'utf8')
  assert.match(source, /does not create a balance inside an exchange account/)
  assert.match(source, /Exchange deposit credit must be confirmed by that exchange/)
  assert.match(source, /Fee sponsor settlement/)
  assert.match(source, /Not settled by this receiver verification/)
})

test('token receiver balance formatting uses integer strings and never Number rounding', async () => {
  const source = await readFile(sourceUrl, 'utf8')
  assert.match(source, /function formatBaseUnitsForDisplay/)
  assert.match(source, /const whole = padded\.slice/)
  assert.match(source, /const fraction = padded\.slice/)
  assert.doesNotMatch(source, /Number\(settlementCheck\.receiverBalance\.balanceBaseUnits\)/)
})
