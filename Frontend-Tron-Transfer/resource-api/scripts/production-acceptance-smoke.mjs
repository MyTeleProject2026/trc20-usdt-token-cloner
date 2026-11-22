import process from 'node:process'

const baseUrl = String(process.env.TRON_TRANSFER_API_BASE_URL || '').replace(/\/$/, '')
if (!baseUrl) {
  process.stderr.write('TRON_TRANSFER_API_BASE_URL is required; no production target is assumed.\n')
  process.exit(2)
}
let origin
try {
  origin = new URL(baseUrl)
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash) {
    throw new Error('invalid-origin')
  }
} catch {
  process.stderr.write('TRON_TRANSFER_API_BASE_URL must be a clean HTTPS origin.\n')
  process.exit(2)
}

async function get(path) {
  const response = await fetch(new URL(path, origin), {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(path + ': HTTP ' + response.status)
  return payload
}

try {
  const [health, report] = await Promise.all([
    get('/health'),
    get('/api/acceptance/production'),
  ])
  const required = [
    'owner-address',
    'sponsor-address-format-and-separation',
    'sponsor-signer-address-match',
    'ledger-database-configured',
    'ledger-schema-and-control-row',
    'ledger-durability-and-restore-attestation',
    'writes-remain-paused-until-release',
    'admin-second-factor-configured',
    'session-authentication-configured',
    'mainnet-execution-explicitly-disabled',
  ]
  const checks = Array.isArray(report.acceptance?.checks) ? report.acceptance.checks : []
  const byId = new Map(checks.map(item => [item.id, item]))
  const missing = required.filter(id => !byId.has(id))
  const blocked = checks.filter(item => item.state !== 'passed')
  const safe = report.acceptance?.executionEnabled === false
    && report.transactionExecutionAvailable !== true
  const result = {
    health: health.ok === true ? 'passed' : 'failed',
    network: health.network || 'unknown',
    acceptanceState: report.acceptance?.state || 'missing',
    checks: checks.map(({ id, state, detail }) => ({ id, state, ...(detail ? { detail } : {}) })),
    missingChecks: missing,
    blockedChecks: blocked.map(({ id, state, detail }) => ({ id, state, ...(detail ? { detail } : {}) })),
    mainnetExecutionRemainsDisabled: safe,
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  if (health.ok !== true || missing.length || !safe) process.exitCode = 1
} catch (error) {
  process.stderr.write('Production acceptance smoke test failed: ' + String(error?.message || 'unknown-error') + '\n')
  process.exitCode = 1
}
