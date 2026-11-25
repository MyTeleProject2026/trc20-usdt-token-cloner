export const REQUIRED_PRODUCTION_ACCEPTANCE_CHECKS = Object.freeze([
  'owner-address',
  'sponsor-address-format-and-separation',
  'sponsor-engine-address-matches-configuration',
  'sponsor-mainnet-address-configured-and-independent',
  'sponsor-wallet-enrolled',
  'ledger-database-configured',
  'database-target-identity',
  'ledger-schema-and-control-row',
  'ledger-durability-and-restore-attestation',
  'writes-remain-paused-until-release',
  'owner-session-for-guarded-administration',
  'session-authentication-configured',
  'sponsor-local-transaction-signer',
  'mainnet-execution-explicitly-disabled',
])

export function evaluateProductionAcceptance(health, report) {
  const rawChecks = Array.isArray(report?.acceptance?.checks) ? report.acceptance.checks : []
  const checks = rawChecks.filter(item => item && typeof item === 'object' && !Array.isArray(item))
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
