import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateProductionAcceptance, REQUIRED_PRODUCTION_ACCEPTANCE_CHECKS } from '../production-acceptance-assessment.mjs'

function passingInputs() {
  return {
    health: { ok: true, network: 'mainnet' },
    report: {
      acceptance: {
        state: 'ready-for-independent-review',
        executionEnabled: false,
        checks: REQUIRED_PRODUCTION_ACCEPTANCE_CHECKS.map(id => ({ id, state: 'passed' })),
      },
      transactionExecutionAvailable: false,
    },
  }
}

test('production acceptance passes only for a healthy Mainnet API with every required check passed and execution disabled', () => {
  const { health, report } = passingInputs()
  const result = evaluateProductionAcceptance(health, report)
  assert.equal(result.passed, true)
  assert.equal(result.mainnetOnly, true)
  assert.equal(result.mainnetExecutionRemainsDisabled, true)
  assert.deepEqual(result.missingChecks, [])
  assert.deepEqual(result.blockedChecks, [])
})

test('a healthy API reporting a non-Mainnet network is rejected', () => {
  const { health, report } = passingInputs()
  health.network = 'nile'
  const result = evaluateProductionAcceptance(health, report)
  assert.equal(result.passed, false)
  assert.equal(result.mainnetOnly, false)
})

test('missing required acceptance checks are reported and block readiness', () => {
  const { health, report } = passingInputs()
  report.acceptance.checks = report.acceptance.checks.filter(item => item.id !== 'database-target-identity')
  const result = evaluateProductionAcceptance(health, report)
  assert.equal(result.passed, false)
  assert.deepEqual(result.missingChecks, ['database-target-identity'])
})

test('any blocked acceptance check prevents readiness', () => {
  const { health, report } = passingInputs()
  report.acceptance.checks.find(item => item.id === 'writes-remain-paused-until-release').state = 'blocked'
  const result = evaluateProductionAcceptance(health, report)
  assert.equal(result.passed, false)
  assert.equal(result.blockedChecks[0].id, 'writes-remain-paused-until-release')
})

test('execution enabled or transaction execution available always blocks acceptance', () => {
  for (const mutate of [
    report => { report.acceptance.executionEnabled = true },
    report => { report.transactionExecutionAvailable = true },
  ]) {
    const { health, report } = passingInputs()
    mutate(report)
    assert.equal(evaluateProductionAcceptance(health, report).passed, false)
  }
})

test('an unhealthy API or unapproved acceptance state is rejected', () => {
  const { health, report } = passingInputs()
  health.ok = false
  assert.equal(evaluateProductionAcceptance(health, report).passed, false)
  health.ok = true
  report.acceptance.state = 'production-approved'
  assert.equal(evaluateProductionAcceptance(health, report).passed, false)
})
