import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createResourceClaimOrchestrator,
  evaluateZeroBurnDeploymentGate,
} from '../server/resource-claim-orchestrator.mjs'

const ownerAddress = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const txid = 'a'.repeat(64)
const required = { ENERGY: '900000', BANDWIDTH: '1200' }

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
  const manager = createResourceClaimOrchestrator({ delegationVerifier: { async verifyDelegation(input) { calls.push(['independent-verify', input.transactionId]); return { verified: true, solidified: true, network: 'mainnet', ownerAddress, transactionId: txid, ENERGY: '900000', BANDWIDTH: '1200' } } }, adapters: [{
    id: 'example-authorized-provider',
    network: 'mainnet',
    authorizationMode: 'provider-managed-signer',
    async health() { return { reachable: true } },
    async checkEligibility(input) {
      calls.push(['eligibility', input.ownerAddress])
      return { eligible: true, network: 'mainnet', userCostSun: '0' }
    },
    async requestGrant(input) {
      calls.push(['request', input.requestId])
      return { accepted: true, transactionId: txid }
    },
  }] })
  const readiness = await manager.getReadiness(ownerAddress)
  assert.equal(readiness.canRequestGrant, false)
  assert.equal(readiness.providerReachable, true)
  assert.equal(readiness.status, 'provider-reachable-eligibility-not-checked')
  const result = await manager.requestGrant({ ownerAddress, requestId: 'deploy_12345678', required })
  assert.equal(result.success, true)
  assert.equal(result.status, 'mainnet-resource-grant-verified')
  assert.equal(result.userCostSun, '0')
  assert.deepEqual(calls.map((call) => call[0]), ['eligibility', 'request', 'independent-verify'])
})

test('provider adapter cannot pass grant through without on-chain verification', async () => {
  const manager = createResourceClaimOrchestrator({ delegationVerifier: { async verifyDelegation(input) { return { verified: false, solidified: false, network: 'mainnet', transactionId: input.transactionId } } }, adapters: [{
    id: 'unverified-provider',
    network: 'mainnet',
    authorizationMode: 'provider-managed-signer',
    async health() { return { reachable: true } },
    async checkEligibility() { return { eligible: true, network: 'mainnet', userCostSun: '0' } },
    async requestGrant() { return { accepted: true, transactionId: txid } },
  }] })
  const result = await manager.requestGrant({ ownerAddress, requestId: 'deploy_12345678', required })
  assert.equal(result.success, false)
  assert.equal(result.status, 'grant-not-independently-verified')
})

test('deployment gate requires full Energy, full Bandwidth and exactly zero TRX fallback', () => {
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
})

test('paid, wrong-network, or ineligible provider responses never submit a grant', async (t) => {
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
        delegationVerifier: { async verifyDelegation() { throw new Error('must not verify an unsubmitted grant') } },
        adapters: [{
          id: 'policy-test-provider',
          network: 'mainnet',
          authorizationMode: 'provider-managed-signer',
          async health() { return { reachable: true } },
          async checkEligibility() { return scenario.eligibility },
          async requestGrant() { submitted = true; return { accepted: true, transactionId: txid } },
        }],
      })
      const result = await manager.requestGrant({ ownerAddress, requestId: 'deploy_12345678', required })
      assert.equal(submitted, false)
      assert.equal(result.success, false)
      assert.equal(result.status, 'no-eligible-zero-cost-provider-grant')
    })
  }
})
