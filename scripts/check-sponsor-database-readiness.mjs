#!/usr/bin/env node
import pg from 'pg'
import { pathToFileURL } from 'node:url'
import { databaseSslConfig, normalizeDatabaseConnectionString } from '../server/database.mjs'
import { inspectSponsorDatabaseReadiness } from '../server/sponsor-database-readiness.mjs'

const { Pool } = pg

async function main() {
  const configuredUrl = process.env.DATABASE_URL
  if (typeof configuredUrl !== 'string' || !configuredUrl.trim()) {
    console.error('DATABASE_URL is required. No database was contacted.')
    process.exitCode = 2
    return
  }

  const connectionString = normalizeDatabaseConnectionString(configuredUrl)
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
    max: 1,
    ssl: databaseSslConfig(connectionString),
  })

  try {
    const report = await inspectSponsorDatabaseReadiness(pool)
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    process.exitCode = report.ready ? 0 : 1
  } catch (error) {
    // Never print DATABASE_URL, SQL parameters, or provider secrets.
    console.error('Sponsor database readiness check could not complete:', error?.code || 'connection-or-query-error')
    process.exitCode = 2
  } finally {
    await pool.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('Sponsor database readiness check failed:', error?.code || 'unknown-error')
    process.exitCode = 2
  })
}
