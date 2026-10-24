import test from 'node:test'
import assert from 'node:assert/strict'
import { createSponsorFeeEstimateRouter } from '../server/routes/sponsor-fee-estimate.mjs'

const assetSponsor = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
const feeSponsor = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const receiver = 'T111111111111111111111111111111111'
const mainnetUsdt = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const assetHex = '41' + '11'.repeat(20)
const feeHex = '41' + '22'.repeat(20)
const receiverHex = '41' + '33'.repeat(20)
const tokenHex = '41' + '44'.repeat(20)

function fakeTronWeb() {
  const addresses = new Map([
    [assetSponsor, assetHex],
    [feeSponsor, feeHex],
    [receiver, receiverHex],
    [mainnetUsdt, tokenHex],
  ])
  return {
    isAddress(value) { return addresses.has(value) },
    address: {
      toHex(value) { return addresses.get(value) || '' },
    },
  }
}

function createHarness({
  energyRequired = '10000',
  principalEnergy = '4000',
  feeSponsorEnergy = '50000',
  env = {
    SPONSOR_ASSET_MAINNET_ADDRESS: assetSponsor,
    SPONSOR_FEE_MAINNET_ADDRESS: feeSponsor,
  },
  delegationPayload = { delegatedResource: [] },
  delegationResponseOk = true,
} = {}) {
  const calls = []
  const router = createSponsorFeeEstimateRouter({
    env,
    tronWebFactory: async () => fakeTronWeb(),
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      if (url.endsWith('/walletsolidity/getdelegatedresourcev2')) {
        return { ok: delegationResponseOk, status: delegationResponseOk ? 200 : 503, json: async () => delegationPayload }
      }
      if (url.endsWith('/wallet/triggerconstantcontract')) {
        return { ok: true, json: async () => ({ result: { result: true }, energy_used: energyRequired }) }
      }
      if (url.endsWith('/wallet/createtransaction')) {
        const body = JSON.parse(init.body)
        return {
          ok: true,
          json: async () => ({
            raw_data_hex: 'ab'.repeat(100),
            raw_data: {
              contract: [{
                type: 'TransferContract',
                parameter: { value: {
                  owner_address: body.owner_address,
                  to_address: body.to_address,
                  amount: body.amount,
                } },
              }],
            },
          }),
        }
      }
      if (url.endsWith('/wallet/getchainparameters')) {
        return { ok: true, json: async () => ({
          chainParameter: [
            { key: 'getEnergyFee', value: 100 },
            { key: 'getTransactionFee', value: 1000 },
          ],
        }) }
      }
      if (url.endsWith('/wallet/getaccountresource')) {
        const body = JSON.parse(init.body)
        const principal = body.address === assetHex
        const energy = principal ? principalEnergy : feeSponsorEnergy
        return { ok: true, json: async () => ({
          EnergyLimit: energy,
          EnergyUsed: '0',
          NetLimit: '80',
          NetUsed: '0',
          freeNetLimit: '20',
          freeNetUsed: '0',
        }) }
      }
      throw new Error('unexpected-provider-path')
    },
  })
  return { router, calls }
}

async function invoke(router, body, endpoint = '/sponsorship/fee-estimate') {
  const layer = router.stack.find((item) =>
    item.route?.path === endpoint && item.route.methods?.post,
  )
  assert.ok(layer, 'fee estimate endpoint should be registered')
  let statusCode = 200
  let payload
  const headers = {}
  const response = {
    setHeader(name, value) { headers[name.toLowerCase()] = value; return this },
    status(code) { statusCode = code; return this },
    json(value) { payload = value; return this },
  }
  await layer.route.stack[0].handle({ body }, response)
  return { statusCode, payload, headers }
}

function validBody(overrides = {}) {
  return {
    network: 'mainnet',
    tokenContract: mainnetUsdt,
    receiverAddress: receiver,
    amountBaseUnits: '1000000',
    ...overrides,
  }
}

test('estimates current-node TRC-20 energy and reports shortfall without claiming total fee coverage', async () => {
  const { router, calls } = createHarness()
  const result = await invoke(router, validBody())
  assert.equal(result.statusCode, 200)
  assert.equal(result.payload.success, true)
  assert.equal(result.payload.status, 'read-only-energy-estimate-incomplete-total-fee')
  assert.equal(result.payload.asset, 'USDT')
  assert.equal(result.payload.estimation.estimatedEnergyRequired, '10000')
  assert.equal(result.payload.estimation.currentEnergyFeeSun, '100')
  assert.equal(result.payload.estimation.estimatedEnergyBurnSun, '600000')
  assert.equal(result.payload.estimation.estimatedEnergyBurnTRX, '0.6')
  assert.equal(result.payload.estimation.principalSponsorResources.availableEnergy, '4000')
  assert.equal(result.payload.estimation.feeSponsorResources.availableEnergy, '50000')
  assert.equal(result.payload.estimation.feeSponsorResourcesCountedTowardPrincipalTransfer, false)
  assert.equal(result.payload.estimation.resourceDelegationVerified, false)
  assert.equal(result.payload.estimation.bandwidthCostEstimated, false)
  assert.equal(result.payload.estimation.totalNetworkFeeEstimated, false)
  assert.equal(result.payload.canSubmitSponsoredTransfer, false)
  assert.equal(result.payload.transactionBroadcast, false)
  assert.equal(calls.length, 4)
  assert.ok(calls.every((call) => call.url.startsWith('https://api.trongrid.io/')))
})

test('labels an allowlisted USDT-like testnet contract as a testnet contract', async () => {
  const { router } = createHarness({
    env: {
      SPONSOR_ASSET_SHASTA_ADDRESS: assetSponsor,
      SPONSOR_FEE_SHASTA_ADDRESS: feeSponsor,
      SPONSOR_USDT_SHASTA_CONTRACTS: assetSponsor,
    },
  })
  const result = await invoke(router, {
    network: 'shasta',
    tokenContract: assetSponsor,
    receiverAddress: receiver,
    amountBaseUnits: '1000000',
  })
  assert.equal(result.statusCode, 200)
  assert.equal(result.payload.asset, 'USDT (testnet contract)')
  assert.equal(result.payload.network, 'shasta')
})

test('reads live solidified fee-to-principal resource delegation separately from the transaction audit', async () => {
  const expires = Date.now() + 60_000
  const { router, calls } = createHarness({
    env: {
      SPONSOR_ASSET_MAINNET_ADDRESS: assetSponsor,
      SPONSOR_FEE_MAINNET_ADDRESS: feeSponsor,
      TATUM_API_KEY: 'server-only-test-key',
    },
    delegationPayload: {
      delegatedResource: [{
        from: feeHex,
        to: assetHex,
        frozen_balance_for_energy: '6000000',
        frozen_balance_for_bandwidth: '3000000',
        expire_time_for_energy: 0,
        expire_time_for_bandwidth: expires,
      }],
    },
  })
  const result = await invoke(router, validBody())
  assert.equal(result.statusCode, 200)
  const delegation = result.payload.estimation.feeSponsorResourceDelegation
  assert.equal(delegation.success, true)
  assert.equal(delegation.status, 'solidified-delegation-state-read')
  assert.equal(delegation.activeEnergyStakeSun, '6000000')
  assert.equal(delegation.activeBandwidthStakeSun, '3000000')
  assert.equal(delegation.activeBandwidthExpiry, expires)
  assert.equal(delegation.transactionAuditVerified, false)
  assert.equal(result.payload.estimation.resourceDelegationVerified, false)
  assert.equal(result.payload.canSubmitSponsoredTransfer, false)
  assert.ok(calls.some((call) => call.url.endsWith('/walletsolidity/getdelegatedresourcev2')))
  assert.equal(JSON.stringify(result.payload).includes('server-only-test-key'), false)
})

test('distinguishes a successful solidified read with no delegation from an unavailable read', async () => {
  const withNoDelegation = createHarness({
    env: {
      SPONSOR_ASSET_MAINNET_ADDRESS: assetSponsor,
      SPONSOR_FEE_MAINNET_ADDRESS: feeSponsor,
      TATUM_API_KEY: 'server-only-test-key',
    },
    delegationPayload: { delegatedResource: [] },
  })
  const empty = await invoke(withNoDelegation.router, validBody())
  assert.equal(empty.payload.estimation.feeSponsorResourceDelegation.success, true)
  assert.equal(empty.payload.estimation.feeSponsorResourceDelegation.status, 'solidified-no-delegation-observed')
  assert.equal(empty.payload.estimation.feeSponsorResourceDelegation.activeEnergyStakeSun, '0')
  assert.equal(empty.payload.estimation.feeSponsorResourceDelegation.activeBandwidthStakeSun, '0')

  const unavailable = createHarness({
    env: {
      SPONSOR_ASSET_MAINNET_ADDRESS: assetSponsor,
      SPONSOR_FEE_MAINNET_ADDRESS: feeSponsor,
      TATUM_API_KEY: 'server-only-test-key',
    },
    delegationResponseOk: false,
  })
  const failed = await invoke(unavailable.router, validBody())
  assert.equal(failed.payload.estimation.feeSponsorResourceDelegation.success, false)
  assert.equal(failed.payload.estimation.feeSponsorResourceDelegation.status, 'solidified-delegation-read-unavailable')
})

test('does not count fee sponsor resources as delegated energy for the principal sponsor', async () => {
  const { router } = createHarness({ principalEnergy: '20000', feeSponsorEnergy: '900000' })
  const result = await invoke(router, validBody())
  assert.equal(result.payload.estimation.estimatedEnergyBurnSun, '0')
  assert.equal(result.payload.estimation.feeSponsorResources.availableEnergy, '900000')
  assert.equal(result.payload.estimation.feeSponsorResourcesCountedTowardPrincipalTransfer, false)
  assert.equal(result.payload.estimation.resourceDelegationVerified, false)
  assert.ok(result.payload.blockers.includes('fee-sponsor-resource-delegation-not-verified'))
})

test('rejects arbitrary token contracts before calling the chain provider', async () => {
  const { router, calls } = createHarness()
  const result = await invoke(router, validBody({ tokenContract: receiver }))
  assert.equal(result.statusCode, 403)
  assert.equal(result.payload.status, 'token-contract-not-allowlisted')
  assert.equal(calls.length, 0)
})

test('does not accept caller-supplied sponsor addresses or transaction fields', async () => {
  const { router, calls } = createHarness()
  const result = await invoke(router, validBody({ assetSponsorAddress: receiver }))
  assert.equal(result.statusCode, 400)
  assert.equal(result.payload.status, 'invalid-request')
  assert.equal(calls.length, 0)
})

test('estimates native TRX bandwidth shortfall from a validated unsigned transaction draft', async () => {
  const { router, calls } = createHarness()
  const result = await invoke(router, {
    network: 'mainnet',
    receiverAddress: receiver,
    amountBaseUnits: '3000000',
  }, '/sponsorship/native-fee-estimate')

  assert.equal(result.statusCode, 200)
  assert.equal(result.payload.success, true)
  assert.equal(result.payload.status, 'read-only-native-bandwidth-estimate')
  assert.equal(result.payload.asset, 'TRX')
  assert.equal(result.payload.amountBaseUnits, '3000000')
  assert.equal(result.payload.nativeEstimation.estimatedUnsignedRawDataBytes, 100)
  assert.equal(result.payload.nativeEstimation.estimatedSignedTransactionBytes, 169)
  assert.equal(result.payload.nativeEstimation.totalPrincipalSponsorBandwidth, '100')
  assert.equal(result.payload.nativeEstimation.estimatedBandwidthShortfallBytes, '69')
  assert.equal(result.payload.nativeEstimation.estimatedBandwidthFeeSun, '69000')
  assert.equal(result.payload.nativeEstimation.estimatedBandwidthFeeTRX, '0.069')
  assert.equal(result.payload.nativeEstimation.feeSponsorResourcesCountedTowardPrincipalTransfer, false)
  assert.equal(result.payload.nativeEstimation.resourceDelegationVerified, false)
  assert.equal(result.payload.nativeEstimation.totalNetworkFeeEstimated, false)
  assert.equal(result.payload.canSubmitSponsoredTransfer, false)
  assert.equal(result.payload.transactionBroadcast, false)
  assert.ok(calls.some((call) => call.url.endsWith('/wallet/createtransaction')))
})

test('native TRX preflight rejects provider-created drafts with a mismatched receiver or amount', async () => {
  const harness = createHarness()
  harness.calls.length = 0
  // Create a separate injected client whose unsigned draft does not match the request.
  const mismatchedRouter = createSponsorFeeEstimateRouter({
    env: {
      SPONSOR_ASSET_MAINNET_ADDRESS: assetSponsor,
      SPONSOR_FEE_MAINNET_ADDRESS: feeSponsor,
    },
    tronWebFactory: async () => fakeTronWeb(),
    fetchImpl: async (url, init) => {
      if (url.endsWith('/wallet/createtransaction')) {
        const body = JSON.parse(init.body)
        return { ok: true, json: async () => ({
          raw_data_hex: 'ab'.repeat(100),
          raw_data: { contract: [{
            type: 'TransferContract',
            parameter: { value: {
              owner_address: body.owner_address,
              to_address: body.to_address,
              amount: Number(body.amount) + 1,
            } },
          }] },
        }) }
      }
      throw new Error('should stop before reading resources')
    },
  })
  const result = await invoke(mismatchedRouter, {
    network: 'mainnet',
    receiverAddress: receiver,
    amountBaseUnits: '3000000',
  }, '/sponsorship/native-fee-estimate')
  assert.equal(result.statusCode, 502)
  assert.equal(result.payload.status, 'unsigned-transaction-validation-failed')
})

test('blocks the estimate when either sponsor role is not configured', async () => {
  const router = createSponsorFeeEstimateRouter({
    env: {},
    tronWebFactory: async () => fakeTronWeb(),
    fetchImpl: async () => { throw new Error('must-not-call-provider') },
  })
  const result = await invoke(router, validBody())
  assert.equal(result.statusCode, 503)
  assert.equal(result.payload.status, 'sponsor-role-addresses-not-configured')
})
