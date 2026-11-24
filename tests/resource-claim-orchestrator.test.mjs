import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createResourceClaimOrchestrator,
  evaluateZeroBurnDeploymentGate,
} from '../server/resource-claim-orchestrator.mjs'

const ownerAddress = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const txid = 'a'.repeat(64)
const energyTxid = 'b'.repeat(64)
const bandwidthTxid = 'c'.repeat(64)
const required = { ENERGY: '900000', BANDWIDTH: '1200' }

function eligibleAdapter(id, requestGrant, overrides = {}) {
  return {
    id,
    network: 'mainnet',
    authorizationMode: 'provider-managed-signer',
    async health() { return { reachable: true } },
    async checkEligibility() { return { eligible: true, network: 'mainnet', userCostSun: '0' } },
    requestGrant,
    ...overrides,
  }
}

test('no provider adapter means no automatic grant is claimed or fabricated', async () => {
  const manager = createResourceClaimOrchestrator()
  const readiness = await manager.getReadiness(ownerAddress)
  assert.equal(readiness.canRequestGrant, false)
  assert.equal(readiness.status, 'no-authorized-provider-adapter')
  const grant = await manager.requestGrant({ ownerAddress, requestId: 'deploy_12345678', required })
  assert.equal(grant.success, false)
  assert.equal(grant.status, 'no-eligible-zero-cost-provider-grant')
})

test('provider-managed adapter can request and independently verify a zero-cost grant', async () => {
  const calls = []
  const manager = createResourceClaimOrchestrator({
    delegationVerifier: {
      async verifyDelegation(input) {
        calls.push(['independent-verify', input.transactionId, input.required])
        return {
          verified: true, solidified: true, network: 'mainnet',
          ownerAddress, transactionId: input.transactionId,
          ENERGY: '900000', BANDWIDTH: '1200',
        }
      },
    },
    adapters: [eligibleAdapter('example-authorized-provider', async (input) => {
      calls.push(['request', input.requestId])
      return { accepted: true, userCostSun: '0', transactionId: txid }
    }, {
      async checkEligibility(input) { calls.push(['eligibility', input.ownerAddress]); return { eligible: true, network: 'mainnet', userCostSun: '0' } },
    })],
  })
  const readiness = await manager.getReadiness(ownerAddress)
  assert.equal(readiness.canRequestGrant, false)
  assert.equal(readiness.providerReachable, true)
  assert.equal(readiness.status, 'provider-reachable-eligibility-not-checked')
  const result = await manager.requestGrant({ ownerAddress, requestId: 'deploy_12345678', required })
  assert.equal(result.success, true)
  assert.equal(result.status, 'mainnet-resource-grant-verified')
  assert.equal(result.userCostSun, '0')
  assert.equal(result.transactionId, txid)
  assert.deepEqual(result.transactionIds, { ENERGY: txid, BANDWIDTH: txid })
  assert.deepEqual(calls.map((call) => call[0]), ['eligibility', 'request', 'independent-verify', 'independent-verify'])
})

test('provider may delegate Energy and Bandwidth in separate independently verified transactions', async () => {
  const verified = []
  const manager = createResourceClaimOrchestrator({
    delegationVerifier: {
      async verifyDelegation(input) {
        verified.push(input)
        return {
          verified: true, solidified: true, network: 'mainnet',
          ownerAddress, transactionId: input.transactionId,
          ENERGY: '900000', BANDWIDTH: '1200',
        }
      },
    },
    adapters: [eligibleAdapter('split-resource-provider', async () => ({
      accepted: true,
      userCostSun: '0',
      transactionIds: { ENERGY: energyTxid, BANDWIDTH: bandwidthTxid },
    }))],
  })
  const result = await manager.requestGrant({ ownerAddress, requestId: 'deploy_87654321', required })
  assert.equal(result.success, true)
  assert.equal(result.transactionId, null)
  assert.deepEqual(result.transactionIds, { ENERGY: energyTxid, BANDWIDTH: bandwidthTxid })
  assert.deepEqual(verified.map((entry) => entry.transactionId), [energyTxid, bandwidthTxid])
  assert.deepEqual(verified.map((entry) => entry.required), [
    { ENERGY: '900000', BANDWIDTH: '0' },
    { ENERGY: '0', BANDWIDTH: '1200' },
  ])
})

test('provider adapter cannot pass a grant through without solidified Mainnet verification', async () => {
  const manager = createResourceClaimOrchestrator({
    delegationVerifier: {
      async verifyDelegation(input) {
        return { verified: false, solidified: false, network: 'mainnet', ownerAddress, transactionId: input.transactionId }
      },
    },
    adapters: [eligibleAdapter('unverified-provider', async () => ({
      accepted: true, userCostSun: '0', transactionId: txid,
    }))],
  })
  const result = await manager.requestGrant({ ownerAddress, requestId: 'deploy_12345678', required })
  assert.equal(result.success, false)
  assert.equal(result.status, 'grant-not-independently-verified')
  assert.equal(result.retrySafe, false)
})

test('ambiguous provider submission is terminal and is never retried against another provider', async () => {
  let secondProviderCalled = false
  const manager = createResourceClaimOrchestrator({
    adapters: [
      eligibleAdapter('provider-one', async () => { throw new Error('timeout after possible provider broadcast') }),
      eligibleAdapter('provider-two', async () => {
        secondProviderCalled = true
        return { accepted: true, userCostSun: '0', transactionId: txid }
      }),
    ],
  })
  const result = await manager.requestGrant({ ownerAddress, requestId: 'deploy_12345678', required })
  assert.equal(result.success, false)
  assert.equal(result.status, 'grant-submission-outcome-unknown')
  assert.equal(result.retrySafe, false)
  assert.equal(secondProviderCalled, false)
})

test('accepted grant with unavailable solidified verification is terminal and is not retried', async () => {
  let secondProviderCalled = false
  const manager = createResourceClaimOrchestrator({
    delegationVerifier: { async verifyDelegation() { throw new Error('SolidityNode timeout') } },
    adapters: [
      eligibleAdapter('provider-one', async () => ({
        accepted: true, userCostSun: '0', transactionId: txid,
      })),
      eligibleAdapter('provider-two', async () => {
        secondProviderCalled = true
        return { accepted: true, userCostSun: '0', transactionId: txid }
      }),
    ],
  })
  const result = await manager.requestGrant({ ownerAddress, requestId: 'deploy_12345678', required })
  assert.equal(result.success, false)
  assert.equal(result.status, 'grant-submitted-verification-unavailable')
  assert.equal(result.retrySafe, false)
  assert.equal(secondProviderCalled, false)
})

test('accepted grant with missing or nonzero final cost is terminal and is not retried', async () => {
  for (const finalCost of [undefined, '1', 0]) {
    let secondProviderCalled = false
    const manager = createResourceClaimOrchestrator({
      adapters: [
        eligibleAdapter('provider-one', async () => ({
          accepted: true,
          ...(finalCost === undefined ? {} : { userCostSun: finalCost }),
          transactionId: txid,
        })),
        eligibleAdapter('provider-two', async () => {
          secondProviderCalled = true
          return { accepted: true, userCostSun: '0', transactionId: txid }
        }),
      ],
    })
    const result = await manager.requestGrant({ ownerAddress, requestId: 'deploy_12345678', required })
    assert.equal(result.success, false)
    assert.equal(result.status, 'grant-accepted-response-incomplete-or-not-zero-cost')
    assert.equal(result.retrySafe, false)
    assert.equal(secondProviderCalled, false)
  }
})

test('paid, wrong-network, or ineligible providers are rejected before grant submission', async (t) => {
  const cases = [
    { name: 'paid grant', eligibility: { eligible: true, network: 'mainnet', userCostSun: '1' } },
    { name: 'wrong network', eligibility: { eligible: true, network: 'nile', userCostSun: '0' } },
    { name: 'not eligible', eligibility: { eligible: false, network: 'mainnet', userCostSun: '0' } },
    { name: 'missing exact cost', eligibility: { eligible: true, network: 'mainnet' } },
    { name: 'malformed cost', eligibility: { eligible: true, network: 'mainnet', userCostSun: 0 } },
  ]
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      let submitted = false
      const manager = createResourceClaimOrchestrator({
        adapters: [eligibleAdapter('policy-test-provider', async () => {
          submitted = true
          return { accepted: true, userCostSun: '0', transactionId: txid }
        }, {
          async checkEligibility() { return scenario.eligibility },
        })],
      })
      const result = await manager.requestGrant({ ownerAddress, requestId: 'deploy_12345678', required })
      assert.equal(submitted, false)
      assert.equal(result.success, false)
      assert.equal(result.status, 'no-eligible-zero-cost-provider-grant')
    })
  }
})

test('invalid owner, request ID, or zero resource request is rejected before provider access', async () => {
  let providerCalls = 0
  const manager = createResourceClaimOrchestrator({
    adapters: [eligibleAdapter('must-not-run', async () => {
      providerCalls++
      return { accepted: true, userCostSun: '0', transactionId: txid }
    })],
  })
  for (const input of [
    { ownerAddress: 'not-an-address', requestId: 'deploy_12345678', required },
    { ownerAddress, requestId: 'short', required },
    { ownerAddress, requestId: 'deploy_12345678', required: { ENERGY: '0', BANDWIDTH: '1200' } },
    { ownerAddress, requestId: 'deploy_12345678', required: { ENERGY: '900000', BANDWIDTH: '0' } },
  ]) {
    const result = await manager.requestGrant(input)
    assert.equal(result.success, false)
    assert.equal(result.status, 'invalid-grant-request')
  }
  assert.equal(providerCalls, 0)
})

test('deployment gate requires positive full Energy, full Bandwidth and exactly zero TRX fallback', () => {
  assert.equal(evaluateZeroBurnDeploymentGate({
    energyRequired: '100', energyAvailable: '100',
    bandwidthRequired: '200', bandwidthAvailable: '200',
    trxBurnFallbackSun: '0',
  }).ready, true)
  assert.equal(evaluateZeroBurnDeploymentGate({
    energyRequired: '100', energyAvailable: '99',
    bandwidthRequired: '200', bandwidthAvailable: '200',
    trxBurnFallbackSun: '0',
  }).ready, false)
  assert.equal(evaluateZeroBurnDeploymentGate({
    energyRequired: '100', energyAvailable: '100',
    bandwidthRequired: '200', bandwidthAvailable: '199',
    trxBurnFallbackSun: '0',
  }).ready, false)
  assert.equal(evaluateZeroBurnDeploymentGate({
    energyRequired: '100', energyAvailable: '100',
    bandwidthRequired: '200', bandwidthAvailable: '200',
    trxBurnFallbackSun: '1',
  }).ready, false)
  for (const zeroBudget of [
    { energyRequired: '0', energyAvailable: '0', bandwidthRequired: '200', bandwidthAvailable: '200', trxBurnFallbackSun: '0' },
    { energyRequired: '100', energyAvailable: '100', bandwidthRequired: '0', bandwidthAvailable: '0', trxBurnFallbackSun: '0' },
  ]) {
    const result = evaluateZeroBurnDeploymentGate(zeroBudget)
    assert.equal(result.ready, false)
    assert.equal(result.status, 'invalid-resource-preflight')
    assert.equal(result.deploymentMayProceed, undefined)
  }
})
