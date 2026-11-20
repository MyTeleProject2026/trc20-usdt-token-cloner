import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const route = await readFile(new URL('../server/routes/sponsor-wallet.mjs', import.meta.url), 'utf8')

test('Sponsor status is read-only and never returns signing material', () => {
  assert.match(route, /router\.get\('\/sponsor\/status'/)
  assert.match(route, /canStake: false/)
  assert.match(route, /canDelegate: false/)
  assert.match(route, /read-only-until-signer-and-admin-auth-are-configured/)
  assert.doesNotMatch(route, /res\.json\([^)]*privateKey\s*:/s)
})

test('Sponsor status uses explicit configured wallet identities only', () => {
  assert.match(route, /SPONSOR_MAINNET_ADDRESS/)
  assert.match(route, /TRON_OWNER_ADDRESS/)
  assert.doesNotMatch(route, /TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp/)
})

test('Sponsor automatic staking policy keeps conservative defaults and disables automatic unstaking', () => {
  assert.match(route, /minimumStakeTrx: 1/)
  assert.match(route, /SPONSOR_MAX_AUTOMATIC_STAKE_TRX \|\| 10/)
  assert.match(route, /SPONSOR_LIQUID_RESERVE_TRX \|\| 2/)
  assert.match(route, /automaticUnstakeEnabled: false/)
})

test('Sponsor status is explicitly non-cacheable and reports fail-closed readiness blockers', () => {
  assert.match(route, /Cache-Control', 'no-store'/)
  assert.match(route, /sponsorOwnerIdentityVerified/)
  assert.match(route, /spendableTrxAfterReserve/)
  assert.match(route, /canStakeNow: false/)
  assert.match(route, /canDelegateNow: false/)
  assert.match(route, /canDeployOwnerContractNow: false/)
  assert.match(route, /Sponsor and Owner addresses must be independent/)
})
