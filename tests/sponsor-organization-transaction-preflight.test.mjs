import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import express from 'express'
import { createSponsorOrganizationSelectionRouter } from '../server/routes/sponsor-organization-selection.mjs'
import { preflightSponsorOrganizationPayoutIntent } from '../server/sponsor-organization-transaction-preflight.mjs'

const principal = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
const fee = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const receiver = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE'
const contract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const principalHex = '41' + '11'.repeat(20)
const feeHex = '41' + '22'.repeat(20)
const receiverHex = '41' + '33'.repeat(20)
const contractHex = '41' + '44'.repeat(20)
const feeCapSun = '120000'
const amountBaseUnits = '1000000'
const parameter = receiverHex.slice(2).padStart(64, '0') + BigInt(amountBaseUnits).toString(16).padStart(64, '0')

function makeIntent(overrides = {}) {
  return {
    id: '9001',
    intentDigest: 'a'.repeat(64),
    status: 'sponsor_authorization_complete',
    network: 'mainnet',
    asset: 'USDT',
    tokenContract: contract,
    receiverAddress: receiver,
    amountBaseUnits,
    feeCapSun,
    principalSponsorAddress: principal,
    feeSponsorAddress: fee,
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    ...overrides,
  }
}

function harness({
  intent = makeIntent(),
  principalEnergy = '20000',
  principalBandwidth = '2000',
  feeEnergy = '900000',
  feeBandwidth = '900000',
  transactionData = 'a9059cbb' + parameter,
  delegation = {
    success: true,
    status: 'solidified-delegation-state-read',
    fromAddress: fee,
    toAddress: principal,
    activeEnergyStakeSun: '5000000',
    activeBandwidthStakeSun: '3000000',
  },
} = {}) {
  const calls = []
  const addresses = new Map([
    [principal, principalHex], [fee, feeHex], [receiver, receiverHex], [contract, contractHex],
  ])
  const tronWebFactory = async () => ({
    isAddress: (value) => addresses.has(value),
    address: { toHex: (value) => addresses.get(value) || '' },
  })
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname
    const body = JSON.parse(init.body)
    calls.push({ path, body })
    if (path === '/wallet/triggerconstantcontract') {
      assert.equal(body.owner_address, principalHex)
      assert.equal(body.contract_address, contractHex)
      assert.equal(body.parameter, parameter)
      return { ok: true, json: async () => ({ result: { result: true }, energy_used: '10000' }) }
    }
    if (path === '/wallet/triggersmartcontract') {
      assert.equal(body.owner_address, principalHex)
      assert.equal(body.contract_address, contractHex)
      assert.equal(body.parameter, parameter)
      return { ok: true, json: async () => ({
        result: { result: true },
        transaction: {
          raw_data_hex: 'ab'.repeat(100),
          raw_data: { contract: [{
            type: 'TriggerSmartContract',
            parameter: { value: {
              owner_address: principalHex,
              contract_address: contractHex,
              data: transactionData,
              fee_limit: Number(feeCapSun),
            } },
          }] },
        },
      }) }
    }
    if (path === '/wallet/getchainparameters') {
      return { ok: true, json: async () => ({ chainParameter: [
        { key: 'getEnergyFee', value: 100 },
        { key: 'getTransactionFee', value: 1000 },
      ] }) }
    }
    if (path === '/wallet/getaccountresource') {
      const isPrincipal = body.address === principalHex
      return { ok: true, json: async () => ({
        EnergyLimit: isPrincipal ? principalEnergy : feeEnergy,
        EnergyUsed: '0',
        NetLimit: isPrincipal ? principalBandwidth : feeBandwidth,
        NetUsed: '0',
        freeNetLimit: '0',
        freeNetUsed: '0',
      }) }
    }
    throw new Error('unexpected provider path: ' + path)
  }
  const store = {
    async getPayoutIntentForPreflight(id) {
      assert.equal(id, '9001')
      return { success: true, intent, sponsorOwnerApprovalsVerified: true }
    },
  }
  return {
    calls,
    run: (overrides = {}) => preflightSponsorOrganizationPayoutIntent({
      store, intentId: '9001',
      env: { TRONGRID_API_KEY: 'test-provider-key' },
      fetchImpl, tronWebFactory,
      readDelegation: async () => delegation,
      ...overrides,
    }),
  }
}

test('intent-bound preflight validates unsigned TRC20 transaction and current principal resources', async () => {
  const testHarness = harness()
  const result = await testHarness.run()
  assert.equal(result.success, true)
  assert.equal(result.status, 'transaction-specific-resource-preflight-passed-review-required')
  assert.equal(result.intent.intentDigest, 'a'.repeat(64))
  assert.equal(result.sponsorOwnerApprovalsVerified, true)
  assert.equal(result.transactionDraft.builtAndValidated, true)
  assert.equal(result.transactionDraft.signed, false)
  assert.equal(result.transactionDraft.broadcast, false)
  assert.equal(result.resourceEstimate.estimatedEnergyRequired, '10000')
  assert.equal(result.resourceEstimate.estimatedEnergyShortfall, '0')
  assert.equal(result.resourceEstimate.estimatedBandwidthShortfallBytes, '0')
  assert.equal(result.resourceEstimate.estimatedFeeWithinIntentCap, true)
  assert.equal(result.resourceEstimate.feeSponsorDelegationObserved, true)
  assert.equal(result.resourceEstimate.feeSponsorOwnResourcesCountedForPrincipal, false)
  assert.equal(result.transactionSpecificFeeCoverageVerified, false)
  assert.equal(result.canSubmitSponsoredTransfer, false)
  assert.equal(result.submissionEnabled, false)
  assert.equal(result.transactionSubmitted, false)
  assert.equal(testHarness.calls.some((call) => /broadcast|sendrawtransaction/i.test(call.path)), false)
})

test('principal resource shortfall blocks preflight and never counts fee sponsor wallet resources', async () => {
  const testHarness = harness({ principalEnergy: '1000', principalBandwidth: '1' })
  const result = await testHarness.run()
  assert.equal(result.success, true)
  assert.equal(result.status, 'transaction-specific-resource-preflight-blocked')
  assert.equal(result.resourceEstimate.estimatedEnergyShortfall, '9000')
  assert.equal(result.resourceEstimate.estimatedEnergyBurnSun, '900000')
  assert.equal(result.resourceEstimate.feeSponsorOwnAvailableEnergy, '900000')
  assert.equal(result.resourceEstimate.feeSponsorOwnResourcesCountedForPrincipal, false)
  assert.ok(result.blockers.includes('principal-sponsor-resources-insufficient-for-current-estimate'))
  assert.ok(result.blockers.includes('estimated-network-fee-exceeds-intent-fee-cap'))
  assert.equal(result.canSubmitSponsoredTransfer, false)
})

test('preflight rejects a mismatched unsigned transaction before reading resources', async () => {
  const testHarness = harness({ transactionData: 'a9059cbb' + '00'.repeat(64) })
  const result = await testHarness.run()
  assert.equal(result.success, false)
  assert.equal(result.reason, 'unsigned-transaction-validation-failed')
  assert.equal(testHarness.calls.some((call) => call.path === '/wallet/getaccountresource'), false)
})

test('preflight requires both current owner approvals before contacting the chain', async () => {
  const testHarness = harness()
  const result = await testHarness.run({
    store: { getPayoutIntentForPreflight: async () => ({
      success: false, reason: 'both-sponsor-owner-approvals-required',
    }) },
  })
  assert.equal(result.success, false)
  assert.equal(result.reason, 'both-sponsor-owner-approvals-required')
  assert.equal(testHarness.calls.length, 0)
})

test('preflight rechecks the network-scoped token allowlist', async () => {
  const testHarness = harness({
    intent: makeIntent({ network: 'nile', tokenContract: principal }),
  })
  const result = await testHarness.run({ env: {} })
  assert.equal(result.success, false)
  assert.equal(result.reason, 'payout-intent-token-contract-no-longer-allowlisted')
  assert.equal(testHarness.calls.length, 0)
})

test('preflight refuses expired intents and unsafe provider integer ranges', async () => {
  const expired = harness({ intent: makeIntent({ expiresAt: new Date(Date.now() - 1000).toISOString() }) })
  assert.equal((await expired.run()).reason, 'payout-intent-scope-or-expiry-invalid')
  const unsafe = harness({ intent: makeIntent({ feeCapSun: '9007199254740992' }) })
  assert.equal((await unsafe.run()).reason, 'fee-cap-exceeds-safe-provider-range')
})

const ADMIN_TOKEN = 'test-sponsor-admin-token-that-is-long-enough-123456'

async function serveRoute(t, overrides = {}) {
  const app = express()
  app.use(express.json())
  app.use('/api/tron', createSponsorOrganizationSelectionRouter({
    env: { SPONSOR_ADMIN_API_TOKEN: ADMIN_TOKEN },
    store: { getPayoutIntentForPreflight: async () => ({
      success: true, intent: makeIntent({ id: '9001' }), sponsorOwnerApprovalsVerified: true,
    }) },
    preflightIntent: async () => ({
      success: true, status: 'transaction-specific-resource-preflight-blocked',
      canSubmitSponsoredTransfer: false, submissionEnabled: false, transactionSubmitted: false,
    }),
    ...overrides,
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())))
  return 'http://127.0.0.1:' + server.address().port + '/api/tron'
}

test('intent transaction preflight endpoint is administrator protected and accepts no caller transaction fields', async (t) => {
  const base = await serveRoute(t)
  const denied = await fetch(base + '/sponsorship/payout-intents/9001/transaction-preflight', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  assert.equal(denied.status, 401)

  const invalid = await fetch(base + '/sponsorship/payout-intents/9001/transaction-preflight', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + ADMIN_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ receiverAddress: receiver }),
  })
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).error, 'transaction-preflight-does-not-accept-transaction-fields')
})

test('intent transaction preflight endpoint returns read-only result with execution flags disabled', async (t) => {
  const base = await serveRoute(t)
  const response = await fetch(base + '/sponsorship/payout-intents/9001/transaction-preflight', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + ADMIN_TOKEN, 'content-type': 'application/json' },
    body: '{}',
  })
  const payload = await response.json()
  assert.equal(response.status, 200)
  assert.equal(payload.success, true)
  assert.equal(payload.canSubmitSponsoredTransfer, false)
  assert.equal(payload.submissionEnabled, false)
  assert.equal(payload.transactionSubmitted, false)
})


test('Fireblocks custody preflight endpoint requires admin authorization and accepts no caller-supplied provider fields', async (t) => {
  let invoked = 0
  const base = await serveRoute(t, {
    custodyPreflight: async () => {
      invoked += 1
      return {
        success: true,
        status: 'fireblocks-custody-preflight-passed-review-required',
        transactionCreated: false,
        transactionSigned: false,
        transactionSubmitted: false,
        canSubmitSponsoredTransfer: false,
        submissionEnabled: false,
      }
    },
  })
  const denied = await fetch(base + '/sponsorship/payout-intents/9001/custody-preflight', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  assert.equal(denied.status, 401)

  const invalid = await fetch(base + '/sponsorship/payout-intents/9001/custody-preflight', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + ADMIN_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ vaultAccountId: '999' }),
  })
  assert.equal(invalid.status, 400)
  assert.equal(invoked, 0)

  const valid = await fetch(base + '/sponsorship/payout-intents/9001/custody-preflight', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + ADMIN_TOKEN, 'content-type': 'application/json' },
    body: '{}',
  })
  const payload = await valid.json()
  assert.equal(valid.status, 200)
  assert.equal(payload.status, 'fireblocks-custody-preflight-passed-review-required')
  assert.equal(payload.transactionCreated, false)
  assert.equal(payload.transactionSigned, false)
  assert.equal(payload.transactionSubmitted, false)
  assert.equal(payload.canSubmitSponsoredTransfer, false)
  assert.equal(payload.submissionEnabled, false)
  assert.equal(invoked, 1)
})


test('Fireblocks submission endpoint is admin protected, accepts no caller transaction fields, and preserves disabled flags', async (t) => {
  let invoked = 0
  const base = await serveRoute(t, {
    submitFireblocksPayout: async () => {
      invoked += 1
      return {
        success: true, status: 'provider-pending', providerRequestCreated: true,
        reservationRetained: true, canSubmitSponsoredTransfer: false,
        submissionEnabled: false, transactionSubmitted: false,
      }
    },
  })
  const denied = await fetch(base + '/sponsorship/payout-intents/9001/fireblocks-submit', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  assert.equal(denied.status, 401)

  const invalid = await fetch(base + '/sponsorship/payout-intents/9001/fireblocks-submit', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + ADMIN_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ receiverAddress: receiver, amountBaseUnits: amountBaseUnits }),
  })
  assert.equal(invalid.status, 400)
  assert.equal(invoked, 0)

  const valid = await fetch(base + '/sponsorship/payout-intents/9001/fireblocks-submit', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + ADMIN_TOKEN, 'content-type': 'application/json' },
    body: '{}',
  })
  const payload = await valid.json()
  assert.equal(valid.status, 200)
  assert.equal(payload.status, 'provider-pending')
  assert.equal(payload.reservationRetained, true)
  assert.equal(payload.canSubmitSponsoredTransfer, false)
  assert.equal(payload.submissionEnabled, false)
  assert.equal(payload.transactionSubmitted, false)
  assert.equal(invoked, 1)
})

test('Fireblocks status refresh endpoint is admin protected, accepts no transaction fields and never enables submission', async (t) => {
  let invoked = 0
  const base = await serveRoute(t, {
    refreshFireblocksPayout: async () => {
      invoked += 1
      return {
        success: true, status: 'broadcast-accepted', chainSettlement: 'solidified-chain-verification-required',
        canSubmitSponsoredTransfer: false, submissionEnabled: false, transactionSubmitted: false,
      }
    },
  })
  const denied = await fetch(base + '/sponsorship/payout-intents/9001/fireblocks-refresh', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  assert.equal(denied.status, 401)

  const invalid = await fetch(base + '/sponsorship/payout-intents/9001/fireblocks-refresh', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + ADMIN_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ transactionHash: 'a'.repeat(64) }),
  })
  assert.equal(invalid.status, 400)
  assert.equal(invoked, 0)

  const valid = await fetch(base + '/sponsorship/payout-intents/9001/fireblocks-refresh', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + ADMIN_TOKEN, 'content-type': 'application/json' },
    body: '{}',
  })
  const payload = await valid.json()
  assert.equal(valid.status, 200)
  assert.equal(payload.status, 'broadcast-accepted')
  assert.equal(payload.canSubmitSponsoredTransfer, false)
  assert.equal(payload.submissionEnabled, false)
  assert.equal(payload.transactionSubmitted, false)
  assert.equal(invoked, 1)
})
