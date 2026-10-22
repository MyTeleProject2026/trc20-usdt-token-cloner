import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const routes = await readFile(new URL('../server/routes/native-tron.mjs', import.meta.url), 'utf8')
const ui = await readFile(new URL('../src/ReceiverHistory.tsx', import.meta.url), 'utf8')
const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
const sponsorshipUi = await readFile(new URL('../src/SponsorshipStatus.tsx', import.meta.url), 'utf8')

test('receiver history is a bounded, read-only, network-scoped indexer endpoint', () => {
  assert.match(routes, /router\.get\('\/receiver-history'/)
  assert.match(routes, /only_confirmed: 'true'/)
  assert.match(routes, /only_to: 'true'/)
  assert.match(routes, /limit > 50/)
  assert.match(routes, /networks\[network\].*transactions\/trc20/)
  assert.match(routes, /TRONGRID_API_KEY/)
  assert.match(routes, /nextFingerprint/)
  assert.match(routes, /invalid-fingerprint/)
  assert.match(routes, /query\.set\('fingerprint', fingerprint\)/)
  assert.match(routes, /indexed-candidate-awaiting-solidified-verification/)
  assert.match(routes, /verifiedOnChain: false/)
  const start = routes.indexOf("router.get('/receiver-history'")
  const end = routes.indexOf("\n})", start)
  assert.ok(start >= 0 && end > start)
  const endpoint = routes.slice(start, end)
  assert.doesNotMatch(endpoint, /privateKey|broadcasttransaction|sendRawTransaction|wallet\/broadcasttransaction/i)
  assert.doesNotMatch(endpoint, /fetch\(req\.query|new URL\(req\.query/i)
})

test('receiver history UI refreshes automatically and never labels indexer rows as verified', () => {
  assert.match(ui, /setInterval\(\(\) => \{ void load\(false\) \}, 30000\)/)
  assert.match(ui, /Refresh history/)
  assert.match(ui, /Load older records/)
  assert.match(ui, /fingerprint: nextFingerprint/)
  assert.match(ui, /setNextFingerprint/)
  assert.match(ui, /Awaiting solidified verification/)
  assert.match(ui, /On-chain verified:/)
  assert.match(ui, /does not change balances or promise exchange credit/)
  assert.match(ui, /!\/\^\\d\+\$\//)
  assert.match(app, /<ReceiverHistory network=\{network\}/)
})

test('sponsor UI keeps fee sponsorship, asset grants, and real spendable balance separate', () => {
  assert.match(sponsorshipUi, /Network fee sponsorship/)
  assert.match(sponsorshipUi, /Sponsor-funded TRX \/ USDT \/ VTRC grant/)
  assert.match(sponsorshipUi, /Only the actual on-chain wallet balance is spendable/)
  assert.match(sponsorshipUi, /No verified sponsor provider\/account or funded budget is integrated/)
})

test('persisted receiver history endpoint is bounded and uses stored verification state', () => {
  assert.ok(routes.includes("receiver-history/persisted"))
  assert.match(routes, /listPersistedReceiverHistory/)
  assert.match(routes, /persisted-history-unavailable/)
  assert.ok(routes.includes("eventIndex: item.event_index"))
  assert.ok(ui.includes("receiver-history/persisted"))
  assert.match(ui, /Solidified on-chain verified/)
  assert.ok(ui.includes("record.verifiedOnChain"))
  assert.match(ui, /showing saved receiver history/)
  assert.match(ui, /persistedOnly = storedPayload.records/)
})

 
test('persistent watchlist registration is protected and does not imply monitoring is running', () => {
  assert.ok(routes.includes("router.post('/tracked-wallets'"))
  assert.match(routes, /RECEIVER_WATCHLIST_ADMIN_TOKEN/)
  assert.match(routes, /timingSafeEqual/)
  assert.match(routes, /status\(401\)/)
  assert.match(routes, /status\(503\)/)
  assert.match(routes, /registerTrackedWallet/)
  assert.match(routes, /pending-worker-schedule/)
  assert.match(routes, /A valid watchlist administrator token is required/)
  assert.doesNotMatch(routes.slice(routes.indexOf("router.post('/tracked-wallets'"), routes.indexOf("// Read-only incoming TRC-20 indexer feed.")), /privateKey|broadcasttransaction|sendRawTransaction/i)
})


test('receiver history React identity includes the event index for multiple token transfers in one transaction', () => {
  assert.match(ui, /key=\{\`\$\{record\.network\}:\$\{record\.transactionId \|\| index\}:\$\{record\.tokenContract \|\| ''\}:\$\{record\.eventIndex \?\? ''\}\`\}/)
})
