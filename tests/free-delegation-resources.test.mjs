import test from 'node:test'
import assert from 'node:assert/strict'
import { createFreeDelegationResourceReader } from '../server/free-delegation-resources.mjs'
import { createFreeDelegationResourcesRouter } from '../server/routes/free-delegation-resources.mjs'

const wallet = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const delegator = 'T' + 'A'.repeat(33)
const addressValidator = (value) => value === wallet || value === delegator

function fakeResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload }
}

test('Mainnet reader reports real resources and confirmed incoming Stake-2.0 delegation without signing', async () => {
  const calls = []
  const reader = createFreeDelegationResourceReader({
    env: { TRONGRID_API_KEY: 'server-only-key' },
    addressValidator,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body)
      calls.push({ url, body, headers: init.headers })
      if (url.endsWith('/wallet/getaccountresource')) return fakeResponse({
        EnergyLimit: 10000, EnergyUsed: 2500, NetLimit: 700, NetUsed: 200, freeNetLimit: 600, freeNetUsed: 100,
      })
      if (url.endsWith('/wallet/getaccount')) return fakeResponse({ balance: 0 })
      if (url.endsWith('/wallet/getchainparameters')) return fakeResponse({ chainParameter: [
        { key: 'getEnergyFee', value: 100 }, { key: 'getTransactionFee', value: 1000 }, { key: 'getMaxFeeLimit', value: 15000000000 },
      ] })
      if (url.endsWith('/wallet/getdelegatedresourceaccountindexv2')) return fakeResponse({
        fromAccounts: [delegator], toAccounts: [],
      })
      if (url.endsWith('/wallet/getdelegatedresourcev2')) {
        assert.equal(body.fromAddress, delegator)
        assert.equal(body.toAddress, wallet)
        return fakeResponse({
        delegatedResource: [{ frozen_balance_for_energy: '5000000', frozen_balance_for_bandwidth: '0', expire_time_for_energy: '0' }],
        })
      }
      throw new Error('unexpected endpoint')
    },
  })
  const result = await reader(wallet, { refresh: true })
  assert.equal(result.success, true)
  assert.equal(result.network, 'mainnet')
  assert.equal(result.resources.energyAvailable, '7500')
  assert.equal(result.deploymentResourceSnapshot.nativeBalanceSun, '0')
  assert.equal(result.deploymentResourceSnapshot.energyFeeSun, '100')
  assert.equal(result.deploymentResourceSnapshot.maxFeeLimitSun, '15000000000')
  assert.equal(result.resources.freeBandwidthAvailable, '500')
  assert.equal(result.resources.stakedOrDelegatedBandwidthAvailable, '500')
  assert.equal(result.inboundDelegations.count, 1)
  assert.equal(result.inboundDelegations.records[0].delegator, delegator)
  assert.equal(result.inboundDelegations.records[0].energyStakeSun, '5000000')
  assert.equal(result.policy.mode, 'free-delegation')
  assert.equal(result.policy.walletApprovalRequired, true)
  assert.equal(result.policy.protocolFreeEnergyQuota, '0')
  assert.equal(result.policy.automaticDelegationEnabled, false)
  assert.equal(result.transactionActions.walletSignatureRequested, false)
  assert.equal(result.transactionActions.transactionBroadcast, false)
  assert.ok(calls.every((call) => call.url.startsWith('https://api.trongrid.io/wallet')))
  assert.ok(calls.every((call) => call.headers['TRON-PRO-API-KEY'] === 'server-only-key'))
  assert.equal(JSON.stringify(result).includes('server-only-key'), false)
})

test('Mainnet reader never invents a free Energy provider when no inbound delegation exists', async () => {
  const reader = createFreeDelegationResourceReader({
    env: {},
    addressValidator,
    fetchImpl: async (url) => {
      if (url.endsWith('/wallet/getaccountresource')) return fakeResponse({ freeNetLimit: 600 })
      if (url.endsWith('/wallet/getaccount')) return fakeResponse({ balance: 0 })
      if (url.endsWith('/wallet/getchainparameters')) return fakeResponse({ chainParameter: [
        { key: 'getEnergyFee', value: 100 }, { key: 'getTransactionFee', value: 1000 }, { key: 'getMaxFeeLimit', value: 15000000000 },
      ] })
      return fakeResponse({ fromAccounts: [], toAccounts: [] })
    },
  })
  const result = await reader(wallet, { refresh: true })
  assert.equal(result.success, true)
  assert.equal(result.resources.energyAvailable, '0')
  assert.equal(result.inboundDelegations.count, 0)
  assert.equal(result.policy.freeEnergyProviderStatus, 'no-verified-free-delegation-api')
  assert.equal(result.policy.protocolFreeEnergyQuota, '0')
})

test('Mainnet reader fails closed on invalid provider data and hides provider messages', async () => {
  const secret = 'private upstream api-key-secret'
  const reader = createFreeDelegationResourceReader({
    env: { TRONGRID_API_KEY: 'secret-key' },
    addressValidator,
    fetchImpl: async (url) => url.endsWith('/wallet/getaccountresource')
      ? fakeResponse({ Error: secret })
      : fakeResponse({ fromAccounts: [], toAccounts: [] }),
  })
  const result = await reader(wallet, { refresh: true })
  assert.equal(result.success, false)
  assert.equal(result.failureStage, 'account-resource')
  assert.equal(JSON.stringify(result).includes(secret), false)
  assert.equal(JSON.stringify(result).includes('secret-key'), false)
  assert.equal(result.transactionActions.transactionBroadcast, false)
})

test('resource route is restricted to the configured Mainnet wallet', async () => {
  let statusCode = 0
  let body
  const router = createFreeDelegationResourcesRouter({
    allowedAddress: wallet,
    readStatus: async () => ({ success: true, network: 'mainnet' }),
  })
  const route = router.stack.find((entry) => entry.route?.path === '/resources/free-delegation/status')
  const handler = route.route.stack[0].handle
  const res = {
    setHeader() {},
    status(code) { statusCode = code; return this },
    json(value) { body = value; return this },
  }
  await handler({ query: { address: delegator } }, res)
  assert.equal(statusCode, 403)
  assert.equal(body.error, 'wallet-not-allowed')
})
