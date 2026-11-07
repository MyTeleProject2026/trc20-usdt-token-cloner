import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('organization evidence evaluator remains isolated from runtime payout and signer routes', async () => {
  const [entrypoint, sponsorDirect, evaluator] = await Promise.all([
    readFile(new URL('../server/index.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../server/routes/sponsor-direct-payouts.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../server/sponsor-organization-authorization.mjs', import.meta.url), 'utf8'),
  ])
  assert.doesNotMatch(entrypoint, /sponsor-organization-authorization/)
  assert.doesNotMatch(sponsorDirect, /sponsor-organization-authorization/)
  assert.match(evaluator, /payoutAuthorized: false/)
  assert.match(evaluator, /signerOperationPerformed: false/)
  assert.match(evaluator, /providerRequestPerformed: false/)
  assert.match(evaluator, /transactionBroadcast: false/)
})

test('organization onboarding and Stage 7B governance are mounted without payout authorization', async () => {
  const [entrypoint, onboarding] = await Promise.all([
    readFile(new URL('../server/index.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../server/routes/sponsor-organization-onboarding.mjs', import.meta.url), 'utf8'),
  ])
  assert.match(entrypoint, /createSponsorOrganizationGovernanceRouter/)
  assert.match(entrypoint, /createSponsorOrganizationRouter/)
  assert.ok(entrypoint.indexOf('createSponsorOrganizationGovernanceRouter())') < entrypoint.indexOf('createSponsorOrganizationRouter())'))
  assert.match(onboarding, /payoutAuthorized: false/)
  assert.match(onboarding, /independent legal and funding verification remain separate/i)
})
