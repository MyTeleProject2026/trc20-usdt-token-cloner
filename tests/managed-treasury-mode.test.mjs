import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [server, dashboard, treasury] = await Promise.all([
  readFile(new URL('../server/index.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../Frontend-Tron-Transfer/src/App.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../server/routes/treasury-withdrawals.mjs', import.meta.url), 'utf8'),
])

test('managed Fireblocks treasury router is mounted under the authenticated treasury API', () => {
  assert.match(server, /import \{ createTreasuryWithdrawalsRouter \} from '\.\/routes\/treasury-withdrawals\.mjs'/)
  assert.match(server, /app\.use\('\/api\/treasury', createTreasuryWithdrawalsRouter\(\)\)/)
})

test('owner dashboard loads read-only managed treasury readiness with the owner session', () => {
  assert.match(dashboard, /\/api\/treasury\/withdrawals\/readiness/)
  assert.match(dashboard, /Authorization: 'Bearer ' \+ ownerSession\.sessionToken/)
  assert.match(dashboard, /Refresh readiness/)
  assert.match(dashboard, /executionBlocker/)
  assert.match(dashboard, /providerAvailableUsdtBaseUnits/)
})

test('managed treasury payout submission remains hard-disabled regardless of environment flags', () => {
  assert.match(treasury, /const REAL_VALUE_PAYOUT_EXECUTION_DISABLED = true/)
  assert.match(treasury, /if \(REAL_VALUE_PAYOUT_EXECUTION_DISABLED\)/)
  assert.match(treasury, /real-value-payout-execution-disabled-in-this-build/)
  assert.match(dashboard, /Real-value payout execution is disabled in this build/)
})
