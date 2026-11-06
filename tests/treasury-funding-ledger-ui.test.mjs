import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('live Tron Transfer owner withdrawal page exposes verified treasury funding controls', async () => {
  const ui = await readFile(new URL('../Frontend-Tron-Transfer/src/SponsorDirectPayouts.jsx', import.meta.url), 'utf8')
  assert.ok(ui.includes("{isOwnerAdmin && mode !== 'sponsor' && ("))
  assert.ok(ui.includes('/api/treasury/owner/funding-ledger?network=mainnet'))
  assert.ok(ui.includes('/api/treasury/owner/funding-ledger/deposits/verify'))
  assert.ok(ui.includes('Verify and record incoming USDT'))
  assert.ok(ui.includes('Unreserved on-chain balance'))
  assert.ok(ui.includes('Available USDT is the live on-chain treasury balance less active sponsor payout reservations.'))
  assert.ok(ui.includes('This ledger never creates USDT or TRX.'))
  assert.ok(ui.includes('sign each exact outgoing transaction'))
})
