import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const databaseSource = await readFile(new URL('../server/database.mjs', import.meta.url), 'utf8')
const reconciliationSource = await readFile(new URL('../server/routes/sponsor-solidified-reconciliation.mjs', import.meta.url), 'utf8')
const gateSource = await readFile(new URL('../server/routes/sponsor-fee-settlement-gate.mjs', import.meta.url), 'utf8')

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
})

test('receipt resource usage is recorded as pending evidence, never falsely settled', () => {
  assert.match(databaseSource, /recordSponsorResourceCostSettlementObservation/)
  assert.match(databaseSource, /resourceAttributionVerified: false/)
  assert.match(databaseSource, /sponsorResourceBudgetSettled: false/)
  assert.match(databaseSource, /status = \$2, transaction_hash = \$3/)
  assert.match(reconciliationSource, /recordSponsorResourceCostSettlementObservation/)
  assert.match(reconciliationSource, /solidified-costs-observed-not-settled/)
})

test('testnet signing and broadcast remain blocked until attribution and settlement are independently complete', () => {
  assert.match(gateSource, /SPONSOR_FEE_BUDGET_SETTLEMENT_ADAPTER_READY = false/)
  assert.match(gateSource, /atomic-fee-resource-budget-reservation-not-integrated/)
  assert.match(gateSource, /transaction-specific-fee-sponsor-resource-cost-attribution-not-verified/)
  assert.match(gateSource, /solidified-fee-resource-budget-settlement-and-release-not-integrated/)
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
