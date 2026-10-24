import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const routes = await readFile(new URL('../server/routes/native-tron.mjs', import.meta.url), 'utf8')
const activeUi = await readFile(new URL('../src/WorkflowApp.tsx', import.meta.url), 'utf8')
const entry = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8')

test('receiver history API is bounded, read-only, and network-scoped', () => {
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

test('receiver history UI distinguishes solidified receipts from indexed candidates', () => {
  assert.ok(routes.includes("receiver-history/persisted"))
  assert.match(routes, /listPersistedReceiverHistory/)
  assert.match(routes, /persisted-history-unavailable/)
  assert.ok(routes.includes("eventIndex: item.event_index"))
  assert.ok(entry.includes("import App from './WorkflowApp.tsx'"))
  assert.ok(activeUi.includes('Incoming TRC-20 history'))
  assert.ok(activeUi.includes('/api/tron/receiver-history/persisted'))
  assert.ok(activeUi.includes('/api/tron/receiver-history?'))
  assert.match(activeUi, /record\.verifiedOnChain === true && record\.verificationStatus === 'verified-on-chain'/)
  assert.ok(activeUi.includes('indexed-candidate-awaiting-solidified-verification'))
  assert.ok(activeUi.includes('Awaiting solidified verification'))
  assert.ok(activeUi.includes('The verified-history store is unavailable'))
  assert.ok(activeUi.includes('receiverHistoryRequestGeneration'))
  assert.ok(activeUi.includes('requestGeneration !== receiverHistoryRequestGeneration.current'))
})

test('history verification ignores stale responses after the selected receiver or network changes', () => {
  const start = activeUi.indexOf('  const verifyReceiverHistoryRecord = async (record: ReceiverHistoryRecord, recordKey: string) => {')
  const end = activeUi.indexOf('  const chooseNetwork = (next: NetworkId) => {', start)
  assert.ok(start >= 0 && end > start, 'history verification handler should exist')
  const handler = activeUi.slice(start, end)
  assert.match(handler, /const requestGeneration = receiverHistoryRequestGeneration\.current/)
  assert.match(handler, /requestGeneration !== receiverHistoryRequestGeneration\.current\) return/)
  assert.match(handler, /if \(requestGeneration === receiverHistoryRequestGeneration\.current\)/)
  assert.match(handler, /server history was not saved/)
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

test('receiver history does not start background polling or browser notifications', () => {
  assert.ok(!activeUi.includes('Notification'))
  assert.ok(!activeUi.includes('setInterval('))
  assert.ok(activeUi.includes('loadReceiverHistory'))
})
