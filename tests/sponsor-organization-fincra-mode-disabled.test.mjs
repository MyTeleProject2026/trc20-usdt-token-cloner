import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const route = await readFile(new URL('../server/routes/sponsor-organization-onboarding.mjs', import.meta.url), 'utf8')

test('organization config advertises only per-transfer mandates and no Fincra feature flag', () => {
  assert.match(route, /supportedExecutionModes: \['per-transfer'\]/)
  assert.doesNotMatch(route, /fincraAutomaticModeGateConfigured|FINCRA_AUTO_PAYOUTS_ENABLED|FINCRA_BUSINESS_ID/)
})

test('new organization mandate submissions reject the legacy automatic mode and provider fields', () => {
  assert.match(route, /const allowed = \['agreementReference', 'agreementDigest', 'purpose', 'executionMode', 'perPayoutLimit', 'dailyLimit', 'validFrom', 'validUntil', 'mandateSignature'\]/)
  assert.match(route, /executionMode !== 'per-transfer'/)
  assert.doesNotMatch(route, /executionMode === 'fincra-automatic'/)
  assert.match(route, /'Execution mode: per-transfer'/)
  assert.doesNotMatch(route, /Standing authorization: the platform may submit/)
})

test('historical legacy mandates cannot be verified or authorized, but may be declined', () => {
  assert.match(route, /SELECT execution_mode FROM \$\{SCHEMA\}\.sponsor_organization_mandates WHERE id=\$1/)
  assert.match(route, /pendingMandate\.execution_mode !== 'per-transfer' && body\.decision !== 'decline'/)
  assert.match(route, /legacy-mandate-execution-mode-disabled/)
  assert.match(route, /payoutAuthorized: false/)
})

test('legacy database rows remain readable without allowing new API submissions', () => {
  // The schema retains its historical value constraint so existing rows are not
  // destructively rewritten during application startup. The API rejects new rows.
  assert.match(route, /CHECK \(execution_mode IN \('per-transfer','fincra-automatic'\)\)/)
  assert.match(route, /executionMode !== 'per-transfer'/)
  assert.doesNotMatch(route, /UPDATE \$\{SCHEMA\}\.sponsor_organization_mandates\s+SET execution_mode/)
})
