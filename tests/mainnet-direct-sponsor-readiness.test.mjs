import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  buildMainnetDirectSponsorReadiness,
  createMainnetDirectSponsorReadinessRouter,
  OFFICIAL_MAINNET_USDT_CONTRACT,
} from '../server/routes/mainnet-direct-sponsor-readiness.mjs'

const feeAddress = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const principalAddress = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const now = Date.now()
const approvedScopes = [
  ['fee-scope-001', 'org-001', 'mainnet', feeAddress, 'network-fee', 'TRX', '-'].join('|'),
  ['usdt-scope-001', 'org-001', 'mainnet', principalAddress, 'asset-grant', 'USDT', OFFICIAL_MAINNET_USDT_CONTRACT].join('|'),
].join(';')

function readyDiagnostics(overrides = {}) {
  return {
    roleResult: {
      success: true,
      checkedAt: new Date(now).toISOString(),
      configuredAddressesDistinct: true,
      roles: {
        networkFeeSponsor: {
          address: feeAddress,
          onChainBalanceRead: true,
          native: { status: 'verified', balanceSun: '1000000' },
          resourceStatus: { resourceRead: true },
        },
        assetPrincipalSponsor: {
          address: principalAddress,
          onChainBalanceRead: true,
          tokenBalancesComplete: true,
          tokens: [{
            asset: 'USDT',
            tokenContract: OFFICIAL_MAINNET_USDT_CONTRACT,
            status: 'verified',
            decimals: 6,
            balanceBaseUnits: '250000000',
          }],
        },
      },
      feeSponsorDelegationToPrincipal: {
        success: true,
        transactionAuditVerified: true,
        auditedResourceTypes: ['ENERGY', 'BANDWIDTH'],
        activeEnergyStakeSun: '1000000',
        activeBandwidthStakeSun: '1000000',
      },
      ...(overrides.roleResult || {}),
    },
    database: { configured: true, ready: true },
    env: { SPONSOR_APPROVED_AGREEMENT_REFERENCES: approvedScopes },
    nowMs: now,
    ...overrides,
  }
}

test('Mainnet direct sponsor diagnostics recognize exact official USDT and distinct, audited sponsor roles', () => {
  const result = buildMainnetDirectSponsorReadiness(readyDiagnostics())
  assert.equal(result.success, true)
  assert.equal(result.network, 'mainnet')
  assert.equal(result.model, 'sponsor-wallet-direct-to-recipient')
  assert.equal(result.sponsorRoles.addressesDistinct, true)
  assert.equal(result.sponsorRoles.assetPrincipalSponsor.officialUsdtBalanceVerified, true)
  assert.equal(JSON.stringify(result).includes('250000000'), false, 'readiness output must not disclose sponsor token balances')
  assert.equal(Object.hasOwn(result.sponsorRoles.assetPrincipalSponsor, 'officialUsdtBalanceBaseUnits'), false)
  assert.equal(result.sponsorRoles.feeResourceDelegationTransactionAuditVerified, true)
  assert.equal(result.sponsorRoles.networkFeeSponsor.agreementScopeConfigured, true)
  assert.equal(result.sponsorRoles.assetPrincipalSponsor.agreementScopeConfigured, true)
})

test('Mainnet direct sponsor diagnostics remain blocked even when all read-only prerequisites appear present', () => {
  const result = buildMainnetDirectSponsorReadiness(readyDiagnostics())
  assert.equal(result.preflightReady, false)
  assert.equal(result.mainnetExecutionDisabled, true)
  assert.equal(result.canCreateSigningIntent, false)
  assert.equal(result.canSubmitSponsoredTransfer, false)
  assert.equal(result.unpaidFallbackToUserFunds, false)
  assert.ok(result.blockers.includes('mainnet-direct-request-reservation-and-sponsor-wallet-signing-route-not-implemented'))
  assert.ok(result.blockers.includes('sponsor-legal-authority-account-ownership-and-source-of-funds-require-independent-review'))
})

test('wrong token contract, stale role data, same sponsor wallet, or missing database fail the diagnostics', () => {
  const input = readyDiagnostics()
  input.roleResult.roles.assetPrincipalSponsor.tokens[0].tokenContract = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
  input.roleResult.checkedAt = new Date(now - 60_000).toISOString()
  input.roleResult.roles.networkFeeSponsor.address = principalAddress
  input.roleResult.configuredAddressesDistinct = false
  input.database.ready = false
  const result = buildMainnetDirectSponsorReadiness(input)
  assert.equal(result.sponsorRoles.addressesDistinct, false)
  assert.equal(result.sponsorRoles.assetPrincipalSponsor.officialUsdtBalanceVerified, false)
  assert.equal(result.database.ready, false)
  assert.ok(result.blockers.includes('fresh-mainnet-sponsor-role-snapshot-required'))
  assert.ok(result.blockers.includes('mainnet-sponsor-role-addresses-must-be-distinct'))
  assert.ok(result.blockers.includes('official-mainnet-usdt-principal-balance-not-independently-verified-positive'))
  assert.ok(result.blockers.includes('project-database-not-ready'))
})

function makeResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this },
  }
}

test('Mainnet direct sponsor readiness route is a GET-only diagnostic and never creates a signing intent', async () => {
  let readCount = 0
  const router = createMainnetDirectSponsorReadinessRouter({
    env: { SPONSOR_APPROVED_AGREEMENT_REFERENCES: approvedScopes },
    readRoles: async (network, options) => {
      readCount += 1
      assert.equal(network, 'mainnet')
      assert.equal(options.refresh, true)
      return readyDiagnostics().roleResult
    },
    readDatabase: async () => ({ configured: true, ready: true }),
    now: () => now,
  })
  const layer = router.stack.find((item) =>
    item.route?.path === '/sponsorship/mainnet-direct/readiness' && item.route.methods?.get)
  assert.ok(layer)
  const handler = layer.route.stack.find((item) => item.method === 'get').handle
  const response = makeResponse()
  await handler({ query: { refresh: '1' } }, response)
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.readOnly, true)
  assert.equal(response.body.canCreateSigningIntent, false)
  assert.equal(response.body.canSubmitSponsoredTransfer, false)
  assert.equal(readCount, 1)
})

test('invalid refresh query is rejected before reading sponsor or database state', async () => {
  let calls = 0
  const router = createMainnetDirectSponsorReadinessRouter({
    readRoles: async () => { calls += 1; return readyDiagnostics().roleResult },
    readDatabase: async () => { calls += 1; return { ready: true } },
  })
  const layer = router.stack.find((item) => item.route?.path === '/sponsorship/mainnet-direct/readiness')
  const handler = layer.route.stack.find((item) => item.method === 'get').handle
  const response = makeResponse()
  await handler({ query: { refresh: 'yes' } }, response)
  assert.equal(response.statusCode, 400)
  assert.equal(calls, 0)
})

test('backend mounts the direct Mainnet sponsor diagnostic under the TRON API', async () => {
  const source = await readFile(new URL('../server/index.mjs', import.meta.url), 'utf8')
  assert.match(source, /import mainnetDirectSponsorReadinessRoutes from '\.\/routes\/mainnet-direct-sponsor-readiness\.mjs'/)
  assert.match(source, /app\.use\('\/api\/tron', mainnetDirectSponsorReadinessRoutes\)/)
})
