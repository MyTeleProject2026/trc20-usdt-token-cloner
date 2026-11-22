import process from 'node:process'
import pg from 'pg'
import { sponsorDatabaseConnectionString } from '../sponsor-api.mjs'
import { normalizePostgresTlsMode } from '../scripts/sponsor-ledger-database-identity.mjs'

const connectionString = sponsorDatabaseConnectionString(process.env)
if (!connectionString) {
  process.stderr.write('Wallet-auth schema check blocked: database connection is not configured.\n')
  process.exit(2)
}

const pool = new pg.Pool({
  connectionString: normalizePostgresTlsMode(connectionString),
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 5000,
  max: 1,
})
try {
  const result = await pool.query(`
    SELECT
      to_regclass('public.tron_transfer_wallet_accounts') AS accounts,
      to_regclass('public.tron_transfer_wallet_sessions') AS sessions,
      to_regclass('public.tron_transfer_wallet_auth_audit') AS auth_audit,
      to_regclass('public.tron_transfer_sponsor_operations') AS sponsor_operations,
      to_regclass('public.tron_transfer_sponsor_control') AS sponsor_control
  `)
  const row = result.rows?.[0] || {}
  let sponsorWritesPaused = false
  if (row.sponsor_control) {
    const control = await pool.query('SELECT writes_paused FROM public.tron_transfer_sponsor_control WHERE id=1')
    sponsorWritesPaused = control.rows?.[0]?.writes_paused === true
  }
  const checks = [
    { id: 'wallet-accounts-table', passed: Boolean(row.accounts) },
    { id: 'wallet-sessions-table', passed: Boolean(row.sessions) },
    { id: 'wallet-auth-audit-table', passed: Boolean(row.auth_audit) },
    { id: 'sponsor-ledger-schema-present', passed: Boolean(row.sponsor_operations && row.sponsor_control) },
    { id: 'sponsor-writes-paused', passed: sponsorWritesPaused },
  ]
  const report = {
    success: checks.every(item => item.passed),
    mode: 'read-only',
    schemaMutationPerformed: false,
    authenticationEnabled: false,
    transactionExecutionEnabled: false,
    checks,
    note: 'This check only inspects schema presence and the existing Sponsor pause control. It does not apply migrations, enroll accounts, create sessions, or enable signing.',
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  if (!report.success) process.exitCode = 1
} catch (error) {
  process.stderr.write('Wallet-auth schema check failed: ' + String(error?.code || 'database-error') + '\n')
  process.exitCode = 1
} finally {
  await pool.end().catch(() => {})
}
