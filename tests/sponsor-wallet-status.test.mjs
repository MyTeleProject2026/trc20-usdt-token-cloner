import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const route = await readFile(new URL('../server/routes/sponsor-wallet.mjs', import.meta.url), 'utf8')

test('Sponsor status is read-only and never returns signing material', () => {
  assert.match(route, /router\.get\('\/sponsor\/status'/)
  assert.match(route, /canStake: Boolean\(/)
  assert.match(route, /transactionEngineEnabled && mainnetBroadcastEnabled/)
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

test('Stake 2.0 preflight endpoint is authenticated, read-only and fail-closed', () => {
  assert.match(route, /router\.post\('\/sponsor\/stake\/plan'/)
  assert.match(route, /hasValidSponsorAdminToken\(req\)/)
  assert.match(route, /timingSafeEqual/)
  assert.match(route, /transactionCreated: false/)
  assert.match(route, /signed: false/)
  assert.match(route, /broadcast: false/)
  assert.match(route, /planSponsorStake\(/)
})

test('Sponsor delegation verification endpoint pins the configured Owner and is admin-authenticated', () => {
  assert.match(route, /router\.post\('\/sponsor\/delegation\/verify'/)
  assert.match(route, /hasValidSponsorAdminToken\(req\)/)
  assert.match(route, /createTronMainnetDelegationVerifier/)
  assert.match(route, /ownerAddress,\s*transactionId/)
  assert.match(route, /signed: false/)
  assert.match(route, /broadcast: false/)
})

test('Sponsor bearer authorization parser accepts standard Bearer whitespace', () => {
  assert.match(route, /replace\(\/\^Bearer\\s\+\/i, ''\)/)
})

test('Sponsor signer readiness requires the private key to derive the configured Sponsor address', () => {
  assert.match(route, /tronWeb\.address\.fromPrivateKey\(process\.env\.SPONSOR_MAINNET_PRIVATE_KEY\)/)
  assert.match(route, /privateKeyMatchesAddress/)
  assert.match(route, /serverSignerAddressMatches/)
})
