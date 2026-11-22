import pg from 'pg'
import { createHash } from 'node:crypto'

const { Pool } = pg
const sourceUrl = process.env.SOURCE_DATABASE_URL
const targetUrl = process.env.TARGET_DATABASE_URL

if (process.env.SPONSOR_WRITES_PAUSED !== 'true') {
  throw new Error('Set SPONSOR_WRITES_PAUSED=true only after Sponsor writes and broadcasts are disabled.')
}
if (!sourceUrl || !targetUrl) {
  throw new Error('Set SOURCE_DATABASE_URL and TARGET_DATABASE_URL; values are never printed.')
}

function identity(value) {
  const url = new URL(value)
  return [url.hostname.toLowerCase(), url.port || '5432', decodeURIComponent(url.pathname.slice(1))].join('|')
}
if (identity(sourceUrl) === identity(targetUrl)) {
  throw new Error('Source and target database identities are the same; refusing migration.')
}

const source = new Pool({ connectionString: sourceUrl, max: 1, connectionTimeoutMillis: 8000 })
const target = new Pool({ connectionString: targetUrl, max: 1, connectionTimeoutMillis: 8000 })

const columns = [
  'id', 'idempotency_key_hash', 'request_hash', 'operation', 'resource',
  'amount_sun', 'sponsor_address', 'owner_address', 'status', 'transaction_id',
  'result_code', 'confirmation_block', 'created_at', 'updated_at',
]
const table = 'public.tron_transfer_sponsor_operations'

function rowDigest(rows) {
  const hash = createHash('sha256')
  for (const row of rows) {
    const normalized = columns.map(column => {
      const value = row[column]
      return value instanceof Date ? value.toISOString() : value === null ? null : String(value)
    })
    hash.update(JSON.stringify(normalized))
    hash.update('\n')
  }
  return hash.digest('hex')
}

async function main() {
  let sourceClient
  let targetClient
  let sourceTransactionOpen = false
  let targetTransactionOpen = false
  try {
    sourceClient = await source.connect()
    targetClient = await target.connect()

    // Pause the live source API durably before taking the read-only snapshot.
    // The API locks this singleton row while reserving an operation, so this
    // update waits for any in-progress reservation and blocks subsequent writes.
    await sourceClient.query(`
      CREATE TABLE IF NOT EXISTS public.tron_transfer_sponsor_control (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        writes_paused BOOLEAN NOT NULL DEFAULT FALSE,
        pause_reason TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO public.tron_transfer_sponsor_control (id, writes_paused, pause_reason)
        VALUES (1, TRUE, 'sponsor-ledger-migration')
      ON CONFLICT (id) DO UPDATE SET
        writes_paused = TRUE,
        pause_reason = 'sponsor-ledger-migration',
        updated_at = now();
    `)

    await sourceClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    sourceTransactionOpen = true
    const pauseCheck = await sourceClient.query(
      'SELECT writes_paused FROM public.tron_transfer_sponsor_control WHERE id=1'
    )
    if (pauseCheck.rows?.[0]?.writes_paused !== true) throw new Error('Source Sponsor ledger write pause could not be verified.')

    const sourceCheck = await sourceClient.query(
      "SELECT to_regclass('public.tron_transfer_sponsor_operations') AS table_name"
    )
    if (!sourceCheck.rows[0]?.table_name) throw new Error('Source Sponsor ledger table does not exist.')

    const rows = await sourceClient.query(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY id ASC`)
    const sourceCount = rows.rowCount
    const inFlight = await sourceClient.query(
      `SELECT count(*)::bigint AS count FROM ${table} WHERE status IN ('reserved','signed-not-broadcast','broadcast-unknown')`
    )
    if (BigInt(inFlight.rows[0].count) !== 0n) {
      throw new Error('Source ledger contains in-flight or ambiguous operations. Reconcile them before migration.')
    }
    const sourceDigest = rowDigest(rows.rows)

    await targetClient.query('BEGIN')
    targetTransactionOpen = true
    await targetClient.query(`
      CREATE TABLE IF NOT EXISTS ${table} (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        idempotency_key_hash CHAR(64) NOT NULL UNIQUE,
        request_hash CHAR(64) NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('stake','delegate','undelegate','unstake','withdraw','topup')),
        resource TEXT NOT NULL CHECK (resource IN ('ENERGY','BANDWIDTH','TRX')),
        amount_sun NUMERIC(21,0) NOT NULL CHECK (amount_sun > 0),
        sponsor_address TEXT NOT NULL,
        owner_address TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('reserved','signed-not-broadcast','broadcast-unknown','confirmed','failed')),
        transaction_id CHAR(64),
        result_code TEXT,
        confirmation_block BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS tron_transfer_sponsor_operations_sponsor_created
        ON ${table} (sponsor_address, created_at DESC);
      CREATE TABLE IF NOT EXISTS public.tron_transfer_sponsor_control (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        writes_paused BOOLEAN NOT NULL DEFAULT TRUE,
        pause_reason TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO public.tron_transfer_sponsor_control (id, writes_paused, pause_reason)
        VALUES (1, TRUE, 'post-migration-verification')
      ON CONFLICT (id) DO UPDATE SET
        writes_paused = TRUE,
        pause_reason = 'post-migration-verification',
        updated_at = now();
    `)

    const existing = await targetClient.query(`SELECT count(*)::bigint AS count FROM ${table}`)
    if (BigInt(existing.rows[0].count) !== 0n) {
      throw new Error('Target Sponsor ledger is not empty. Refusing to merge or overwrite existing operations.')
    }

    for (const row of rows.rows) {
      const placeholders = columns.map((_, index) => '$' + (index + 1)).join(', ')
      await targetClient.query(
        `INSERT INTO ${table} (${columns.join(', ')}) OVERRIDING SYSTEM VALUE VALUES (${placeholders})`,
        columns.map(column => row[column])
      )
    }

    await targetClient.query(`
      SELECT setval(
        pg_get_serial_sequence('${table}', 'id'),
        COALESCE((SELECT MAX(id) FROM ${table}), 1),
        EXISTS (SELECT 1 FROM ${table})
      )
    `)
    const targetRows = await targetClient.query(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY id ASC`)
    const targetCount = targetRows.rowCount
    if (BigInt(targetCount) !== BigInt(sourceCount)) {
      throw new Error('Source and target row counts differ; rolling back target migration.')
    }
    if (rowDigest(targetRows.rows) !== sourceDigest) {
      throw new Error('Source and target ledger checksums differ; rolling back target migration.')
    }

    await targetClient.query('COMMIT')
    targetTransactionOpen = false
    await sourceClient.query('COMMIT')
    sourceTransactionOpen = false
    process.stdout.write(JSON.stringify({
      success: true,
      copiedRows: sourceCount,
      verifiedRows: targetCount,
      checksumVerified: true,
      sourceWritesPaused: true,
      targetWritesPaused: true,
      note: 'Both databases remain write-paused. Unpause the verified target only after cutover checks; no database URLs, passwords, wallet keys, or row contents were printed.',
    }) + '\n')
  } catch (error) {
    if (targetClient && targetTransactionOpen) await targetClient.query('ROLLBACK').catch(() => {})
    if (sourceClient && sourceTransactionOpen) await sourceClient.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    sourceClient?.release()
    targetClient?.release()
  }
}

try {
  await main()
} catch (error) {
  process.stderr.write('Sponsor ledger migration failed: ' + String(error?.message || 'unknown error') + '\n')
  process.exitCode = 1
} finally {
  await Promise.all([source.end(), target.end()])
}
