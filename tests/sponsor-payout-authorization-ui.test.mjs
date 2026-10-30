import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const component = await readFile(new URL('../src/SponsorPayoutAuthorization.tsx', import.meta.url), 'utf8')
const entrypoint = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8')
const routes = await readFile(new URL('../server/routes/sponsor-organization-selection.mjs', import.meta.url), 'utf8')

test('independent sponsor approval page is a standalone route outside platform owner login', () => {
  assert.match(entrypoint, /import SponsorPayoutAuthorization from '\.\/SponsorPayoutAuthorization\.tsx'/)
  assert.match(entrypoint, /route === '#\/sponsor-authorization'/)
  assert.match(entrypoint, /if \(isSponsorPayoutAuthorization\) \{[\s\S]*?<SponsorPayoutAuthorization \/>[\s\S]*?return\n  \}/)
  assert.match(component, /Approve a sponsor payout intent/)
  assert.match(component, /Each organization must use its own verified wallet/)
  assert.doesNotMatch(component, /SPONSOR_ADMIN_API_TOKEN|OWNER_PASSWORD|privateKey|seedPhrase|recoveryPhrase/i)
  assert.doesNotMatch(component, /sessionStorage|localStorage/)
})

test('sponsor page proves wallet identity before requesting a role-bound approval challenge', () => {
  const identityChallenge = component.indexOf('/api/auth/tron/challenge')
  const identityVerify = component.indexOf('/api/auth/tron/verify')
  const intentChallenge = component.indexOf('/authorization-challenges')
  const intentAuthorize = component.indexOf('/authorize')
  assert.ok(identityChallenge >= 0 && identityVerify > identityChallenge)
  assert.ok(intentChallenge > identityVerify && intentAuthorize > intentChallenge)
  assert.match(component, /signMessageV2\(loginChallenge\.payload\.message\)/)
  assert.match(component, /signMessageV2\(challenge\.message\)/)
  assert.match(component, /afterApproval\.address !== before\.address/)
  assert.match(component, /afterApproval\.hostname !== before\.hostname/)
  assert.match(component, /api\/auth\/tron\/logout/)
  assert.match(component, /walletSessionToken/)
})

test('sponsor approval routes use wallet session and verify the recovered address against the current sponsor account', () => {
  assert.match(routes, /getWalletAuthSession/)
  assert.match(routes, /resolveWalletSession/)
  assert.match(routes, /Authorization/)
  assert.match(routes, /Trx\.verifyMessageV2/)
  assert.match(routes, /recoveredAddress !== consumed\.authorization\.sponsorAddress/)
  assert.match(routes, /recoveredAddress !== session\.address/)
  assert.match(routes, /recordPayoutAuthorization/)
  assert.match(routes, /canSubmitSponsoredTransfer: false/)
  assert.match(routes, /submissionEnabled: false/)
  assert.match(routes, /transactionSubmitted: false/)
})
