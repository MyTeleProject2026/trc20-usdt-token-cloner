import pg from 'pg'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { databaseIdentity } from './sponsor-ledger-database-identity.mjs'

const { Pool } = pg
const TABLE = 'public.tron_transfer_sponsor_operations'
const REQUIRED_COLUMNS = [
  'id', 'idempotency_key_hash', 'request_hash', 'operation', 'resource',
  'amount_sun', 'sponsor_address', 'owner_address', 'status', 'transaction_id',
  'result_code', 'confirmation_block', 'created_at', 'updated_at',
]

export function assessMigrationPreflight(snapshot) {
  const blockers = []
  if (snapshot.operatorConfirmed !== true) blockers.push('operator-pause-confirmation-required')
  if (snapshot.sourceTargetDistinct !== true) blockers.push('source-and-target-must-be-distinct')
  if (snapshot.sourceOperationsTable !== true) blockers.push('source-ledger-table-missing')
  if (snapshot.sourceControlTable !== true) blockers.push('source-control-table-missing')
  if (snapshot.sourceWritesPaused !== true) blockers.push('source-writes-not-confirmed-paused')
  if (BigInt(snapshot.sourceInFlightCount ?? '-1') !== 0n) blockers.push('source-ledger-has-in-flight-or-unreadable-operations')
  if (snapshot.sourceColumnsComplete !== true) blockers.push('source-ledger-schema-incomplete')
  if (snapshot.targetOperationsTable === true) {
    if (BigInt(snapshot.targetRowCount ?? '-1') !== 0n) blockers.push('target-ledger-must-be-empty')
    if (snapshot.targetColumnsComplete !== true) blockers.push('target-ledger-schema-incomplete')
  }
  if (snapshot.targetControlTable === true && snapshot.targetWritesPaused !== true) {
    blockers.push('existing-target-write-control-not-paused')
  }
  return { readyToMigrate: blockers.length === 0, blockers }
}

async function readDatabase(pool, role) {
  const client = await pool.connect()
  let transactionOpen = false
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    transactionOpen = true
    const tables = await client.query(`
      SELECT
        to_regclass('public.tron_transfer_sponsor_operations') AS operations_table,
        to_regclass('public.tron_transfer_sponsor_control') AS control_table
    `)
    const operationsTable = Boolean(tables.rows?.[0]?.operations_table)
    const controlTable = Boolean(tables.rows?.[0]?.control_table)
    let columnsComplete = false
    let rowCount = null
    let writesPaused = null
    let inFlightCount = null

    if (operationsTable) {
      const columns = await client.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema='public' AND table_name='tron_transfer_sponsor_operations'
      `)
      const found = new Set((columns.rows || []).map(row => row.column_name))
      columnsComplete = REQUIRED_COLUMNS.every(column => found.has(column))
      const count = await client.query(`SELECT count(*)::text AS count FROM ${TABLE}`)
      rowCount = String(count.rows?.[0]?.count ?? '-1')
      if (role === 'source') {
        const inFlight = await client.query(
          `SELECT count(*)::text AS count FROM ${TABLE} WHERE status IN ('reserved','signed-not-broadcast','broadcast-unknown')`
        )
        inFlightCount = String(inFlight.rows?.[0]?.count ?? '-1')
      }
    }

    if (controlTable) {
      const control = await client.query(
        'SELECT writes_paused FROM public.tron_transfer_sponsor_control WHERE id=1'
      )
      writesPaused = control.rows?.length === 1 && control.rows[0].writes_paused === true
    }

    await client.query('ROLLBACK')
    transactionOpen = false
    return {
      operationsTable,
      controlTable,
      columnsComplete,
      rowCount,
      writesPaused,
      inFlightCount,
    }
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

function safeDatabaseError(error) {
  const code = String(error?.code || '')
  if (code === '28P01' || code === '28000') return 'database-authentication-failed'
  if (code === '3D000') return 'database-not-found'
  if (code === 'ECONNREFUSED') return 'database-connection-refused'
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'database-connection-timeout'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'database-host-unresolved'
  if (code === '42501') return 'database-permission-denied'
  return 'database-preflight-failed'
}

export async function runSponsorLedgerPreflight({ env = process.env, PoolClass = Pool } = {}) {
  const sourceUrl = env.SOURCE_DATABASE_URL
  const targetUrl = env.TARGET_DATABASE_URL
  if (!sourceUrl || !targetUrl) {
    return { success: false, readyToMigrate: false, readOnly: true, blockers: ['source-and-target-database-urls-required'] }
  }
  if (env.SPONSOR_WRITES_PAUSED !== 'true') {
    return { success: false, readyToMigrate: false, readOnly: true, blockers: ['set-SPONSOR_WRITES_PAUSED-true-after-pausing-live-sponsor-writes'] }
  }

  let distinct = false
  try {
    distinct = databaseIdentity(sourceUrl) !== databaseIdentity(targetUrl)
  } catch {
    return { success: false, readyToMigrate: false, readOnly: true, blockers: ['database-url-invalid'] }
  }
  if (!distinct) {
    return { success: false, readyToMigrate: false, readOnly: true, blockers: ['source-and-target-must-be-distinct'] }
  }

  const source = new PoolClass({ connectionString: sourceUrl, max: 1, connectionTimeoutMillis: 8000 })
  const target = new PoolClass({ connectionString: targetUrl, max: 1, connectionTimeoutMillis: 8000 })
  try {
    const [sourceState, targetState] = await Promise.all([
      readDatabase(source, 'source'),
      readDatabase(target, 'target'),
    ])
    const assessment = assessMigrationPreflight({
      operatorConfirmed: true,
      sourceTargetDistinct: true,
      sourceOperationsTable: sourceState.operationsTable,
      sourceControlTable: sourceState.controlTable,
      sourceWritesPaused: sourceState.writesPaused,
      sourceInFlightCount: sourceState.inFlightCount,
      sourceColumnsComplete: sourceState.columnsComplete,
      targetOperationsTable: targetState.operationsTable,
      targetRowCount: targetState.rowCount,
      targetColumnsComplete: targetState.columnsComplete,
      targetControlTable: targetState.controlTable,
      targetWritesPaused: targetState.writesPaused,
    })
    return {
      success: assessment.readyToMigrate,
      ...assessment,
      readOnly: true,
      source: {
        connected: true,
        ledgerPresent: sourceState.operationsTable,
        controlPresent: sourceState.controlTable,
        writesPaused: sourceState.writesPaused,
        inFlightOperations: sourceState.inFlightCount,
        schemaComplete: sourceState.columnsComplete,
      },
      target: {
        connected: true,
        ledgerPresent: targetState.operationsTable,
        existingRows: targetState.rowCount,
        schemaComplete: targetState.operationsTable ? targetState.columnsComplete : null,
        controlPresent: targetState.controlTable,
        writesPaused: targetState.writesPaused,
      },
      note: 'Read-only preflight only. No schema, pause state, ledger rows, or transaction state was changed.',
    }
  } catch (error) {
    return {
      success: false,
      readyToMigrate: false,
      readOnly: true,
      blockers: [safeDatabaseError(error)],
    }
  } finally {
    await Promise.all([source.end(), target.end()])
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runSponsorLedgerPreflight()
  process.stdout.write(JSON.stringify(result) + '\\n')
  if (!result.readyToMigrate) process.exitCode = 1
}
