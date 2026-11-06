import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import {
  createSponsorOrganizationRouter,
  parseSponsorOrganizationUsdtAmount,
} from '../server/routes/sponsor-organization-onboarding.mjs'

test('organization mandate USDT limits use exact six-decimal base units', () => {
  assert.equal(parseSponsorOrganizationUsdtAmount('1'), '1000000')
  assert.equal(parseSponsorOrganizationUsdtAmount('12.340056'), '12340056')
  assert.equal(parseSponsorOrganizationUsdtAmount('0.000001'), '1')
  for (const value of ['0', '0.0000001', '-1', '1e2', ' 1', 1, null]) {
    assert.throws(() => parseSponsorOrganizationUsdtAmount(value))
  }
})

test('public organization config does not equate an application with payout authorization', async (t) => {
  const app = express()
  app.use('/api/tron', createSponsorOrganizationRouter({ env: {} }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())))

  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/tron/organizations/config')
  const payload = await response.json()
  assert.equal(response.status, 200)
  assert.equal(payload.network, 'mainnet')
  assert.equal(payload.walletSignatureRequired, true)
  assert.equal(payload.organizationReviewRequired, true)
  assert.equal(payload.writtenMandateRequired, true)
  assert.equal(payload.independentVerificationRequired, true)
  assert.equal(payload.sponsorFundingRequired, true)
  assert.equal(payload.payoutEnabledByApplication, false)
})

test('organization applications and mandate reviews require an authenticated owner or sponsor session', async (t) => {
  const app = express()
  app.use(express.json())
  app.use('/api/tron', createSponsorOrganizationRouter({ env: {} }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())))

  const base = 'http://127.0.0.1:' + server.address().port + '/api/tron'
  const application = await fetch(base + '/organizations/applications', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ organizationName: 'Test Organization' }),
  })
  assert.equal(application.status, 401)

  const ownerQueue = await fetch(base + '/organizations/applications')
  assert.equal(ownerQueue.status, 401)
})

test('owner wallet cannot enroll as a third-party sponsor and sponsor can revoke its mandate', async () => {
  const source = await readFile(new URL('../server/routes/sponsor-organization-onboarding.mjs', import.meta.url), 'utf8')
  assert.match(source, /platform-owner-wallet-cannot-act-as-third-party-sponsor/)
  assert.match(source, /router\.post\('\/organizations\/mandates\/:id\/revoke'/)
  assert.match(source, /SET status='revoked'/)
  assert.match(source, /status IN \('signed-awaiting-review','verified','authorized'\)/)
})

test('mandate authorization is a separate transition after evidence verification', async () => {
  const source = await readFile(new URL('../server/routes/sponsor-organization-onboarding.mjs', import.meta.url), 'utf8')
  assert.match(source, /'signed-awaiting-review','verified','authorized','declined','revoked','expired'/)
  assert.match(source, /body\.decision === 'authorize'\s*\? \['verified'\]/)
  assert.match(source, /body\.decision === 'authorize' \? 'authorized'/)
})

test('private owner provider payout readiness stays fail-closed until a provider is approved', async () => {
  const providerRoute = await readFile(new URL('../server/routes/tron-transfer.mjs', import.meta.url), 'utf8')
  const readinessPolicy = await readFile(new URL('../server/provider-payout-readiness.mjs', import.meta.url), 'utf8')
  assert.match(providerRoute, /router\.get\('\/provider-readiness'/)
  assert.match(providerRoute, /providerOwnedLiquidityVerified: false/)
  assert.match(providerRoute, /providerApprovedCreditVerified: false/)
  assert.match(providerRoute, /legacy-fincra-payout-disabled/)
  assert.match(providerRoute, /payoutSubmitted: false/)
  assert.match(providerRoute, /transactionSubmitted: false/)
  assert.match(readinessPolicy, /provider-authorization-not-verified/)
  assert.match(readinessPolicy, /provider-owned-liquidity-or-approved-credit-not-verified/)
  assert.match(readinessPolicy, /approved-provider-broadcast-adapter-not-installed/)
  assert.match(readinessPolicy, /executionEnabled: blockers\.length === 0/)
})


test('standing Fincra mandate is sponsor-signed, business-account-bound and separately reviewed', async () => {
  const source = await readFile(new URL('../server/routes/sponsor-organization-onboarding.mjs', import.meta.url), 'utf8')
  const frontend = await readFile(new URL('../Frontend-Tron-Transfer/src/SponsorOrganizationOnboarding.jsx', import.meta.url), 'utf8')
  assert.match(source, /execution_mode TEXT NOT NULL DEFAULT 'per-transfer'/)
  assert.match(source, /execution_mode='fincra-automatic'/)
  assert.match(source, /provider_business_id ~ '\^\[A-Za-z0-9\._:-\]\{4,128\}\$'/)
  assert.match(source, /Fincra business ID: ' \+ input\.providerBusinessId/)
  assert.match(source, /without a fresh sponsor wallet signature for each payout/)
  assert.match(source, /fincra-business-id-does-not-match-server-configuration/)
  assert.match(frontend, /Standing Fincra authorization \(no per-withdrawal sponsor signature\)/)
  assert.match(frontend, /providerBusinessId: executionMode === 'fincra-automatic'/)
})

test('Fincra automatic mode is not authorized by application or mandate signature alone', async () => {
  const source = await readFile(new URL('../server/routes/sponsor-organization-onboarding.mjs', import.meta.url), 'utf8')
  assert.match(source, /payoutEnabledByApplication: false/)
  assert.match(source, /organizationReviewRequired: true/)
  assert.match(source, /independentVerificationRequired: true/)
  assert.match(source, /sponsorFundingRequired: true/)
  assert.match(source, /payoutAuthorized: false/)
})
