import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const routeSource = await readFile(new URL('../server/routes/sponsor-direct-payouts.mjs', import.meta.url), 'utf8')
const archiveSource = await readFile(new URL('../server/sponsor-direct-payout-archive.mjs', import.meta.url), 'utf8')
const fundingLedgerSource = await readFile(new URL('../server/routes/owner-treasury-funding-ledger.mjs', import.meta.url), 'utf8')

test('request history and idempotency resolve active and archived records through the history view', () => {
  assert.ok(routeSource.includes('sponsor_direct_payouts_history WHERE idempotency_key=$1'))
  assert.ok(routeSource.includes('sponsor_direct_payouts_history WHERE requester_address=$1'))
  assert.ok(routeSource.includes('sponsor_direct_payouts_history WHERE id=$1'))
  assert.ok(routeSource.includes('archived: row.is_archived === true'))
  assert.ok(routeSource.includes("row.is_archived !== true && ['submitted', 'outcome-unknown', 'broadcasting']"))
})

test('sponsor queue, preparation and broadcast remain restricted to active payout storage', () => {
  const queue = routeSource.slice(routeSource.indexOf("router.get('/queue'"), routeSource.indexOf("router.post('/requests/:id/prepare'"))
  const prepare = routeSource.slice(routeSource.indexOf("router.post('/requests/:id/prepare'"), routeSource.indexOf("router.post('/requests/:id/broadcast'"))
  const broadcast = routeSource.slice(routeSource.indexOf("router.post('/requests/:id/broadcast'"), routeSource.indexOf("router.get('/requests/:id'"))

  assert.ok(queue.includes(".sponsor_direct_payouts WHERE"))
  assert.ok(prepare.includes(".sponsor_direct_payouts WHERE id=$1 FOR UPDATE"))
  assert.ok(broadcast.includes(".sponsor_direct_payouts WHERE id=$1 FOR UPDATE"))
  assert.ok(!/sponsor_direct_payouts_archive|sponsor_direct_payouts_history/.test(queue + prepare + broadcast))
})

test('archive migration blocks unresolved legacy rows and validates an unconditional active minimum', () => {
  assert.ok(archiveSource.includes("const TERMINAL_STATUSES = \"'broadcast-rejected','confirmed','failed','cancelled','expired'\""))
  assert.ok(archiveSource.includes("status NOT IN (' + TERMINAL_STATUSES + ')"))
  assert.ok(archiveSource.includes('unresolved below-minimum payout records require explicit resolution'))
  assert.ok(archiveSource.includes('VALIDATE CONSTRAINT sponsor_direct_payouts_minimum_amount_check'))
  assert.ok(archiveSource.includes('minimum_policy_blocked'))
  assert.ok(archiveSource.includes('reject_sponsor_direct_payout_archive_mutation'))
  assert.ok(archiveSource.includes('sponsor_direct_payout_idempotency_registry'))
})

test('treasury reservations continue to count active payouts only', () => {
  assert.ok(fundingLedgerSource.includes(".sponsor_direct_payouts WHERE sponsor_address=$1"))
  assert.ok(!/sponsor_direct_payouts_archive|sponsor_direct_payouts_history/.test(fundingLedgerSource))
})

test('owner archive diagnostics and authenticated idempotency lookup are read-only API surfaces', () => {
  assert.ok(routeSource.includes("router.get('/archive-migration-status'"))
  assert.ok(routeSource.includes('readSponsorDirectPayoutArchiveDiagnostics(db'))
  assert.ok(routeSource.includes("router.get('/requests/idempotency/:key'"))
  assert.ok(routeSource.includes('sponsor_direct_payouts_history WHERE idempotency_key=$1'))
  assert.ok(routeSource.includes('payoutAuthorized: false'))
  assert.ok(routeSource.includes('transactionBroadcast: false'))
})
