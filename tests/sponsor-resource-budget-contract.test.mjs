import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const databaseSource = await readFile(new URL('../server/database.mjs', import.meta.url), 'utf8')
const reconciliationSource = await readFile(new URL('../server/routes/sponsor-solidified-reconciliation.mjs', import.meta.url), 'utf8')
const gateSource = await readFile(new URL('../server/routes/sponsor-fee-settlement-gate.mjs', import.meta.url), 'utf8')
const submissionSource = await readFile(new URL('../server/routes/native-tron.mjs', import.meta.url), 'utf8')
const envSource = await readFile(new URL('../.env.example', import.meta.url), 'utf8')

test('resource budgets are isolated from principal budgets and limited to testnets', () => {
  assert.match(databaseSource, /CREATE TABLE IF NOT EXISTS \$\{schema\}\.sponsor_resource_budgets/)
  assert.match(databaseSource, /network TEXT NOT NULL CHECK \(network IN \('shasta','nile'\)\)/)
  assert.match(databaseSource, /energy_reserved_units \+ energy_spent_units <= energy_budget_units/)
  assert.match(databaseSource, /bandwidth_reserved_units \+ bandwidth_spent_units <= bandwidth_budget_units/)
  assert.match(databaseSource, /fee_sponsor_address <> asset_principal_address/)
})

test('resource reservations serialize and bind to the exact principal transfer and configured fee sponsor', () => {
  assert.match(databaseSource, /reserveSponsorResourceBudgetForTransfer/)
  assert.match(databaseSource, /FROM \$\{schema\}\.sponsor_transfers WHERE idempotency_key = \$1 FOR UPDATE/)
  assert.match(databaseSource, /SPONSOR_FEE_.*_ADDRESS/)
  assert.match(databaseSource, /resource-per-transfer-limit-exceeded/)
  assert.match(databaseSource, /insufficient-resource-budget/)
  assert.match(databaseSource, /resource-reservation-conflict/)
  assert.match(databaseSource, /getSponsorResourceReservationForTransfer/)
  assert.match(databaseSource, /FOR UPDATE OF r, b/)
  assert.match(databaseSource, /active-fee-resource-reservation-required/)
  assert.match(databaseSource, /resource-reservation-or-mandate-not-active/)
  assert.match(databaseSource, /expires_at TIMESTAMPTZ NOT NULL/)
  assert.match(databaseSource, /releaseExpiredSponsorResourceReservations/)
  assert.match(databaseSource, /let reopenExisting = false/)
  assert.match(databaseSource, /resource-reservation-reopen-conflict/)
  assert.match(databaseSource, /t.status IN \('pending-review','authorized'\)/)
  assert.match(databaseSource, /configured-fee-sponsor-mismatch/)
  assert.match(databaseSource, /pauseSponsorResourceBudget/)
  assert.match(databaseSource, /idx_ttc_sponsor_resource_budgets_one_active_pair/)
  assert.match(databaseSource, /another-resource-mandate-active-or-unsettled/)
  assert.match(databaseSource, /pg_advisory_xact_lock/)
  assert.match(databaseSource, /pg_advisory_lock\(\$1::bigint\)/)
  assert.match(databaseSource, /pg_advisory_unlock\(\$1::bigint\)/)
})

test('receipt resource usage is recorded as pending evidence, never falsely settled', () => {
  assert.match(databaseSource, /recordSponsorResourceCostSettlementObservation/)
  assert.match(databaseSource, /block_timestamp_ms::text AS block_timestamp_ms/)
  assert.match(databaseSource, /preflight_checked_at::text AS preflight_checked_at/)
  assert.match(databaseSource, /reservation_expires_at/)
  assert.match(databaseSource, /preflight_checked_at\).*<= Number\(row\.block_timestamp_ms\)/)
  assert.match(databaseSource, /resourceAttributionVerified: status === 'settled'/)
  assert.match(databaseSource, /resource-budget-settlement-invariant-failed/)
  assert.match(reconciliationSource, /verifySponsorFeeResourceSource/)
  assert.match(databaseSource, /resourceAttributionVerified: status === 'settled'/)
  assert.match(databaseSource, /sponsorResourceBudgetSettled: false/)
  assert.match(databaseSource, /status = \$2, transaction_hash = \$3/)
  assert.match(reconciliationSource, /recordSponsorResourceCostSettlementObservation/)
  assert.match(reconciliationSource, /solidified-resource-budget-settled/)
  assert.match(reconciliationSource, /solidified-costs-observed-pending-resource-attribution/)
})

test('testnet signing and broadcast remain blocked until attribution and settlement are independently complete', async () => {
  const { getSponsorFeeBudgetSettlementGate } = await import('../server/routes/sponsor-fee-settlement-gate.mjs')
  const releaseGate = getSponsorFeeBudgetSettlementGate()
  assert.equal(releaseGate.ready, false)
  assert.ok(releaseGate.blockers.includes('historical-delegation-cryptographic-proof-implementation-not-independently-reviewed'))
  assert.ok(releaseGate.blockers.includes('historical-delegation-witness-state-and-canonical-chain-not-independently-witnessed'))
  assert.ok(!releaseGate.blockers.includes('historical-delegation-block-and-transaction-inclusion-not-independently-verified'))
  assert.match(gateSource, /SPONSOR_FEE_BUDGET_SETTLEMENT_ADAPTER_READY = false/)
  assert.match(gateSource, /historical-delegation-cryptographic-proof-implementation-not-independently-reviewed/)
  assert.match(gateSource, /historical-delegation-witness-state-and-canonical-chain-not-independently-witnessed/)
  assert.match(gateSource, /stake-changing-contract-coverage-not-independently-reviewed/)
  assert.match(gateSource, /fee-to-principal-resource-delegation-transactions-not-independently-audited/)
  assert.match(gateSource, /funded-nile-and-shasta-sponsored-transfer-not-verified/)
  assert.match(gateSource, /production-database-migration-and-restore-rehearsal-not-complete/)
  assert.match(submissionSource, /getSponsorResourceReservationForTransfer\(idempotencyKey\)/)
  assert.match(submissionSource, /rejectIfSponsorFeeBudgetSettlementIsIncomplete\(res\)/)
  assert.match(submissionSource, /router\.post\('\/sponsorship\/resource-budgets'/)
  assert.match(submissionSource, /router\.post\('\/sponsorship\/resource-budgets\/:id\/activate'/)
  assert.match(submissionSource, /router\.post\('\/sponsorship\/resource-budgets\/:id\/pause'/)
  assert.match(submissionSource, /router\.get\('\/sponsorship\/resource-budgets'/)
  assert.match(submissionSource, /SPONSOR_ASSET_.*_ADDRESS/)
  assert.match(envSource, /SPONSOR_APPROVED_RESOURCE_MANDATES/)
})

test('invalid resource reservation input fails before database access', async () => {
  const { reserveSponsorResourceBudgetForTransfer, createSponsorResourceBudgetDraft } =
    await import('../server/database.mjs')
  assert.deepEqual(await reserveSponsorResourceBudgetForTransfer({ idempotencyKey: 'bad' }), {
    reserved: false, reason: 'invalid-resource-reservation',
  })
  assert.deepEqual(await createSponsorResourceBudgetDraft({}), {
    success: false, reason: 'invalid-resource-budget-draft',
  })
})
