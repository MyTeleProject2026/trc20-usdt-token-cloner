export const REQUIRED_PRODUCTION_ACCEPTANCE_CHECKS = Object.freeze([
  'owner-address',
  'sponsor-address-format-and-separation',
  'sponsor-mainnet-address-configured-and-independent',
  'ledger-database-configured',
  'database-target-identity',
  'ledger-schema-and-control-row',
  'ledger-durability-and-restore-attestation',
  'writes-remain-paused-until-release',
  'owner-admin-second-factor-configured',
  'session-authentication-configured',
  'sponsor-local-transaction-signer',
  'mainnet-execution-explicitly-disabled',
])

export function evaluateProductionAcceptance(health, report) {
  const checks = Array.isArray(report?.acceptance?.checks) ? report.acceptance.checks : []
  const byId = new Map(checks.map(item => [item.id, item]))
  const missingChecks = REQUIRED_PRODUCTION_ACCEPTANCE_CHECKS.filter(id => !byId.has(id))
  const blockedChecks = checks.filter(item => item?.state !== 'passed')
  const network = String(health?.network || '').trim().toLowerCase()
  const mainnet = network === 'mainnet'
  const safe = report?.acceptance?.executionEnabled === false
    && report?.transactionExecutionAvailable !== true
  const acceptanceState = report?.acceptance?.state || 'missing'
  const passed = health?.ok === true
    && mainnet
    && missingChecks.length === 0
    && blockedChecks.length === 0
    && acceptanceState === 'ready-for-independent-review'
    && safe
  return {
    passed,
    health: health?.ok === true ? 'passed' : 'failed',
    network: network || 'unknown',
    mainnetOnly: mainnet,
    acceptanceState,
    checks: checks.map(({ id, state, detail }) => ({ id, state, ...(detail ? { detail } : {}) })),
    missingChecks,
    blockedChecks: blockedChecks.map(({ id, state, detail }) => ({ id, state, ...(detail ? { detail } : {}) })),
    mainnetExecutionRemainsDisabled: safe,
  }
}
