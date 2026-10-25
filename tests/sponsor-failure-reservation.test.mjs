import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('submitted sponsor reservations stay held when a provider response is missing or inconclusive', async () => {
  const source = await readFile(new URL('../server/database.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('export async function transitionSponsorTransfer')
  assert.ok(start >= 0)
  const transition = source.slice(start)
  const guard = transition.indexOf("transfer.status === 'submitted' && nextStatus === 'failed'")
  const budgetLookup = transition.indexOf('const budgetResult = await client.query')
  const reservationRelease = transition.indexOf('reserved_base_units = reserved_base_units - $1::numeric')
  assert.ok(guard >= 0, 'submitted-to-failed guard must exist')
  assert.ok(budgetLookup > guard, 'failed submitted transfers must be rejected before budget accounting')
  assert.ok(reservationRelease > budgetLookup, 'reservation updates must occur only after state and evidence checks')
  assert.match(transition, /finalized-failure-evidence-and-fee-reconciliation-required/)
  assert.match(transition, /submitted: \['confirmed'\]/)
})

test('sponsor confirmation cannot use a transaction hash alone as proof of delivery', async () => {
  const source = await readFile(new URL('../server/database.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('export async function transitionSponsorTransfer')
  const transition = source.slice(start)
  assert.match(transition, /if \(nextStatus === 'confirmed'\)/)
  assert.match(transition, /finalized-transfer-evidence-not-found/)
  assert.match(transition, /verification_status = 'verified-on-chain'/)
  assert.match(transition, /native_transfer_verifications/)
  assert.match(transition, /transfer_verifications/)
})

test('provider timeouts must not be mapped to terminal failure or reservation release', async () => {
  const source = await readFile(new URL('../server/database.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('export async function transitionSponsorTransfer')
  const transition = source.slice(start)
  const submittedTransitions = transition.match(/submitted:\s*\[([^\]]*)\]/)
  assert.ok(submittedTransitions, 'submitted transition policy must be explicit')
  assert.equal(submittedTransitions[1].trim(), "'confirmed'")
  assert.doesNotMatch(transition, /provider-timeout[^\n]*nextStatus\s*=\s*['"]failed['"]/i)
})
