import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import {
  buildNetworkSummary,
  createSponsorTestnetPilotRouter,
  readTestnetSolidifiedHead,
} from '../server/routes/sponsor-testnet-pilot.mjs'

const feeAddress = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const assetAddress = 'TTGhREx2pDSxFX555NWz1YwGpiBVPvQA7e'
const secret = 'test-api-secret-must-never-appear'

function response(status, value) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return value },
  }
}

test('solidified head reader uses only the fixed Shasta host and sanitizes provider output', async () => {
  const calls = []
  const result = await readTestnetSolidifiedHead({
    network: 'shasta',
    env: { TATUM_API_KEY: secret },
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return response(200, {
        blockID: 'a'.repeat(64),
        block_header: { raw_data: { number: 12345, timestamp: 1_800_000_000_000 } },
      })
    },
  })

  assert.equal(result.success, true)
  assert.equal(result.status, 'solidified-node-reachable')
  assert.equal(result.network, 'shasta')
  assert.equal(result.latestSolidifiedBlockNumber, 12345)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://tron-shasta.gateway.tatum.io/walletsolidity/getnowblock')
  assert.equal(calls[0].options.method, 'POST')
  assert.equal(calls[0].options.redirect, 'error')
  assert.equal(calls[0].options.headers['x-api-key'], secret)
  assert.equal(JSON.stringify(result).includes(secret), false)
})

test('solidified head reader rejects invalid networks before network access', async () => {
  let called = false
  const result = await readTestnetSolidifiedHead({
    network: 'mainnet',
    env: { TATUM_API_KEY: secret },
    fetchImpl: async () => { called = true; return response(200, {}) },
  })
  assert.equal(result.success, false)
  assert.equal(result.status, 'unsupported-testnet')
  assert.equal(called, false)
})

test('solidified head reader reports only sanitized HTTP status on provider rejection', async () => {
  const result = await readTestnetSolidifiedHead({
    network: 'nile',
    env: { TATUM_API_KEY: secret },
    fetchImpl: async () => response(401, { message: secret }),
  })
  assert.equal(result.success, false)
  assert.equal(result.status, 'provider-http-error')
  assert.equal(result.providerStatus, 401)
  assert.equal(JSON.stringify(result).includes(secret), false)
})

test('combined pilot preflight checks Nile and Shasta but never enables sponsored submission', async (t) => {
  const app = express()
  const calls = []
  const env = {
    TATUM_API_KEY: secret,
    DATABASE_URL: 'postgresql://test-only-secret',
    SPONSOR_ADMIN_API_TOKEN: 'x'.repeat(40),
    SPONSOR_APPROVED_AGREEMENT_REFERENCES: 'approved-reference|sponsor-ref|nile|public|asset-grant|TRX|-',
    SPONSOR_USDT_NILE_CONTRACTS: assetAddress,
    SPONSOR_USDT_SHASTA_CONTRACTS: assetAddress,
    SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED: 'true',
  }
  const readHead = async (network) => ({
    success: true,
    network,
    status: 'solidified-node-reachable',
    latestSolidifiedBlockNumber: network === 'nile' ? 200 : 300,
    latestSolidifiedBlockTimestamp: 1_800_000_000_000,
    checkedAt: new Date().toISOString(),
  })
  const readRoles = async (network) => {
    calls.push(network)
    return {
      success: true,
      network,
      accountsConfigured: true,
      configuredAddressesDistinct: true,
      roles: {
        networkFeeSponsor: {
          addressConfigured: true,
          address: feeAddress,
          onChainBalanceRead: true,
          status: 'read-only',
          native: { status: 'verified', balanceSun: '1000000', balanceTRX: '1', accountExists: true },
          tokens: [],
          tokenBalancesComplete: true,
          resourceStatus: {
            status: 'verified',
            resourceRead: true,
            currentlyAvailableEnergy: '1000',
            currentlyAvailableBandwidth: '1000',
          },
        },
        assetPrincipalSponsor: {
          addressConfigured: true,
          address: assetAddress,
          onChainBalanceRead: true,
          status: 'read-only',
          native: { status: 'verified', balanceSun: '2000000', balanceTRX: '2', accountExists: true },
          tokens: [{ asset: 'USDT (testnet)', tokenContract: assetAddress, status: 'verified', balanceBaseUnits: '1230000', decimals: 6 }],
          tokenBalancesComplete: true,
        },
      },
      feeSponsorDelegationToPrincipal: {
        success: true,
        status: 'solidified-delegation-state-read',
        activeEnergyStakeSun: '1000000',
        activeBandwidthStakeSun: '1000000',
        transactionAuditVerified: false,
      },
    }
  }
  app.use('/api/tron', createSponsorTestnetPilotRouter({ env, readHead, readRoles }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))

  const { port } = server.address()
  const responseValue = await fetch(`http://127.0.0.1:${port}/api/tron/sponsorship/testnet-pilot-readiness?network=both`)
  const payload = await responseValue.json()

  assert.equal(responseValue.status, 200)
  assert.equal(payload.success, true)
  assert.equal(payload.status, 'testnet-live-preflight-passed-review-required')
  assert.deepEqual(Object.keys(payload.networks).sort(), ['nile', 'shasta'])
  assert.equal(payload.networks.nile.networkNode.latestSolidifiedBlockNumber, 200)
  assert.equal(payload.networks.shasta.networkNode.latestSolidifiedBlockNumber, 300)
  assert.equal(payload.networks.nile.roleConfiguration.rolesDistinct, true)
  assert.equal(payload.networks.nile.sponsors.assetPrincipalSponsor.tokens[0].balanceBaseUnits, '1230000')
  assert.equal(payload.networks.nile.canSubmitSponsoredTransfer, false)
  assert.equal(payload.submission.enabled, false)
  assert.equal(payload.submission.canSubmitSponsoredTransfer, false)
  assert.equal(payload.submission.userFundedFallbackAllowed, false)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.sort(), ['nile', 'shasta'])
  assert.ok(payload.networks.nile.blockers.includes('sponsor-ownership-and-spending-mandate-require-independent-review'))
  assert.ok(payload.networks.nile.blockers.includes('post-transfer-fee-settlement-and-receiver-reconciliation-not-end-to-end-verified'))

  const serialized = JSON.stringify(payload)
  for (const value of [secret, env.DATABASE_URL, env.SPONSOR_ADMIN_API_TOKEN, feeAddress, assetAddress]) {
    assert.equal(serialized.includes(value), false)
  }
})


test('pilot summary exposes only an allowlisted upstream resource diagnostic category', () => {
  const summary = buildNetworkSummary({
    network: 'nile',
    head: { success: false, status: 'provider-unreachable' },
    roleResult: {
      configuredAddressesDistinct: true,
      roles: {
        networkFeeSponsor: {
          addressConfigured: true,
          onChainBalanceRead: false,
          resourceStatus: {
            status: 'resource-read-unavailable',
            resourceRead: false,
            failureStage: 'account-resource',
            providerResponseCategory: 'invalid-address',
          },
        },
        assetPrincipalSponsor: {
          addressConfigured: true,
          onChainBalanceRead: false,
        },
      },
    },
    env: {},
  })
  assert.equal(summary.feeSponsorResources.failureStage, 'account-resource')
  assert.equal(summary.feeSponsorResources.providerResponseCategory, 'invalid-address')
  const fieldsSummary = buildNetworkSummary({
    network: 'nile',
    head: { success: false, status: 'provider-unreachable' },
    roleResult: {
      configuredAddressesDistinct: true,
      roles: {
        networkFeeSponsor: {
          addressConfigured: true,
          onChainBalanceRead: false,
          resourceStatus: {
            status: 'resource-read-unavailable',
            resourceRead: false,
            failureStage: 'energy-delegation-ceiling',
            providerResponseCategory: 'missing-delegation-ceiling',
            providerResponseFields: ['data', 'message', 'untrusted-secret-field'],
          },
        },
        assetPrincipalSponsor: { addressConfigured: true, onChainBalanceRead: false },
      },
    },
    env: {},
  })
  assert.deepEqual(fieldsSummary.feeSponsorResources.providerResponseFields, ['data', 'message'])
  const missingShape = buildNetworkSummary({
    network: 'nile',
    head: { success: false, status: 'provider-unreachable' },
    roleResult: {
      configuredAddressesDistinct: true,
      roles: {
        networkFeeSponsor: {
          addressConfigured: true,
          onChainBalanceRead: false,
          resourceStatus: {
            status: 'resource-read-unavailable',
            resourceRead: false,
            failureStage: 'energy-delegation-ceiling',
            providerResponseCategory: 'missing-delegation-ceiling',
          },
        },
        assetPrincipalSponsor: { addressConfigured: true, onChainBalanceRead: false },
      },
    },
    env: {},
  })
  assert.equal(missingShape.feeSponsorResources.providerResponseCategory, 'missing-delegation-ceiling')
  assert.equal(JSON.stringify(summary).includes('provider error message'), false)

  const unknown = buildNetworkSummary({
    network: 'nile',
    head: { success: false, status: 'provider-unreachable' },
    roleResult: {
      configuredAddressesDistinct: true,
      roles: {
        networkFeeSponsor: {
          addressConfigured: true,
          onChainBalanceRead: false,
          resourceStatus: {
            status: 'resource-read-unavailable',
            resourceRead: false,
            providerResponseCategory: 'raw upstream secret: should not pass through',
          },
        },
        assetPrincipalSponsor: { addressConfigured: true, onChainBalanceRead: false },
      },
    },
    env: {},
  })
  assert.equal('providerResponseCategory' in unknown.feeSponsorResources, false)
})

test('combined pilot preflight rejects unsupported network filters', async (t) => {
  const app = express()
  let called = false
  app.use('/api/tron', createSponsorTestnetPilotRouter({
    env: {},
    readHead: async () => { called = true; return { success: false, status: 'unavailable' } },
    readRoles: async () => { called = true; return null },
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const { port } = server.address()
  const responseValue = await fetch(`http://127.0.0.1:${port}/api/tron/sponsorship/testnet-pilot-readiness?network=mainnet`)
  const payload = await responseValue.json()
  assert.equal(responseValue.status, 400)
  assert.equal(payload.error, 'invalid-network')
  assert.equal(payload.canSubmitSponsoredTransfer, false)
  assert.equal(called, false)
})

test('pilot readiness blocks partial Energy/Bandwidth delegation and missing USDT allowlisting', () => {
  const makeRoleResult = ({ energy = '1000000', bandwidth = '1000000' } = {}) => ({
    configuredAddressesDistinct: true,
    roles: {
      networkFeeSponsor: {
        addressConfigured: true,
        onChainBalanceRead: true,
        resourceStatus: {
          status: 'verified',
          resourceRead: true,
          currentlyAvailableEnergy: '1000',
          currentlyAvailableBandwidth: '1000',
        },
      },
      assetPrincipalSponsor: {
        addressConfigured: true,
        onChainBalanceRead: true,
        tokens: [{ asset: 'USDT (testnet)', tokenContract: feeAddress, status: 'verified', balanceBaseUnits: '1000000', decimals: 6 }],
        tokenBalancesComplete: true,
      },
    },
    feeSponsorDelegationToPrincipal: {
      success: true,
      activeEnergyStakeSun: energy,
      activeBandwidthStakeSun: bandwidth,
      transactionAuditVerified: true,
    },
  })
  const head = {
    success: true,
    status: 'solidified-node-reachable',
    latestSolidifiedBlockNumber: 500,
    latestSolidifiedBlockTimestamp: 1_800_000_000_000,
    checkedAt: new Date().toISOString(),
  }
  const env = {
    DATABASE_URL: 'postgresql://test-only-secret',
    SPONSOR_ADMIN_API_TOKEN: 'x'.repeat(40),
    SPONSOR_APPROVED_AGREEMENT_REFERENCES: 'reviewed-reference',
    SPONSOR_USDT_NILE_CONTRACTS: feeAddress,
  }

  const energyOnly = buildNetworkSummary({
    network: 'nile',
    head,
    roleResult: makeRoleResult({ energy: '1000000', bandwidth: '0' }),
    env,
  })
  assert.equal(energyOnly.preflightStatus, 'blocked-by-live-or-configuration-prerequisites')
  assert.equal(energyOnly.feeSponsorResources.delegation.activeDelegationObserved, false)
  assert.ok(energyOnly.blockers.includes('active-fee-to-principal-energy-and-bandwidth-delegation-not-verified'))

  const bandwidthOnly = buildNetworkSummary({
    network: 'nile',
    head,
    roleResult: makeRoleResult({ energy: '0', bandwidth: '1000000' }),
    env,
  })
  assert.equal(bandwidthOnly.preflightStatus, 'blocked-by-live-or-configuration-prerequisites')
  assert.equal(bandwidthOnly.feeSponsorResources.delegation.activeDelegationObserved, false)
  assert.ok(bandwidthOnly.blockers.includes('active-fee-to-principal-energy-and-bandwidth-delegation-not-verified'))

  const zeroUsdtBalance = makeRoleResult()
  zeroUsdtBalance.roles.assetPrincipalSponsor.tokens[0].balanceBaseUnits = '0'
  const unfundedPrincipal = buildNetworkSummary({
    network: 'nile',
    head,
    roleResult: zeroUsdtBalance,
    env,
  })
  assert.equal(unfundedPrincipal.preflightStatus, 'blocked-by-live-or-configuration-prerequisites')
  assert.equal(unfundedPrincipal.roleConfiguration.assetPrincipalUsdtFundingVerified, false)
  assert.ok(unfundedPrincipal.blockers.includes('asset-principal-usdt-funding-not-verified-positive'))

  const wrongDecimals = makeRoleResult()
  wrongDecimals.roles.assetPrincipalSponsor.tokens[0].decimals = 18
  const decimalsMismatch = buildNetworkSummary({
    network: 'nile',
    head,
    roleResult: wrongDecimals,
    env,
  })
  assert.equal(decimalsMismatch.preflightStatus, 'blocked-by-live-or-configuration-prerequisites')
  assert.ok(decimalsMismatch.blockers.includes('asset-principal-usdt-funding-not-verified-positive'))

  const wrongContract = makeRoleResult()
  wrongContract.roles.assetPrincipalSponsor.tokens[0].tokenContract = assetAddress
  const mismatchedToken = buildNetworkSummary({
    network: 'nile',
    head,
    roleResult: wrongContract,
    env,
  })
  assert.equal(mismatchedToken.preflightStatus, 'blocked-by-live-or-configuration-prerequisites')
  assert.ok(mismatchedToken.blockers.includes('asset-principal-usdt-funding-not-verified-positive'))

  const belowMinimum = buildNetworkSummary({
    network: 'nile',
    head,
    roleResult: makeRoleResult({ energy: '999999', bandwidth: '1000000' }),
    env,
  })
  assert.equal(belowMinimum.preflightStatus, 'blocked-by-live-or-configuration-prerequisites')
  assert.equal(belowMinimum.feeSponsorResources.delegation.activeDelegationObserved, false)
  assert.ok(belowMinimum.blockers.includes('active-fee-to-principal-energy-and-bandwidth-delegation-not-verified'))

  const allowlistMissing = buildNetworkSummary({
    network: 'nile',
    head,
    roleResult: makeRoleResult(),
    env: { ...env, SPONSOR_USDT_NILE_CONTRACTS: '' },
  })
  assert.equal(allowlistMissing.preflightStatus, 'blocked-by-live-or-configuration-prerequisites')
  assert.ok(allowlistMissing.blockers.includes('usdt-token-contract-allowlist-not-configured'))
})

