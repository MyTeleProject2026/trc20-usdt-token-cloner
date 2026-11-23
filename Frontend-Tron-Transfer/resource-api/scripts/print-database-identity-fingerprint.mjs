import { createHash } from 'node:crypto'
import { sponsorDatabaseConnectionInfo } from '../sponsor-api.mjs'

function ownerAdminDatabaseInfo(value) {
  const parsed = new URL(value)
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname || parsed.pathname === '/') {
    throw new Error('invalid-postgres-database-url')
  }
  const identity = JSON.stringify({
    hostname: parsed.hostname.toLowerCase(),
    port: parsed.port || '5432',
    database: decodeURIComponent(parsed.pathname.slice(1)),
    username: decodeURIComponent(parsed.username),
  })
  const hostname = parsed.hostname.toLowerCase()
  return {
    sourceVariable: 'OWNER_ADMIN_DATABASE_URL',
    provider: hostname.endsWith('.neon.tech') ? 'neon' : hostname.endsWith('.render.com') || hostname.includes('render') ? 'render-postgres' : 'external-postgres',
    connectionMode: 'direct',
    identityFingerprint: createHash('sha256').update(identity).digest('hex'),
  }
}

let info
try {
  info = typeof process.env.OWNER_ADMIN_DATABASE_URL === 'string' && process.env.OWNER_ADMIN_DATABASE_URL.trim()
    ? ownerAdminDatabaseInfo(process.env.OWNER_ADMIN_DATABASE_URL.trim())
    : sponsorDatabaseConnectionInfo(process.env)
} catch {
  process.stderr.write('Database identity fingerprint unavailable; selected database URL is invalid. No connection details were printed.\n')
  process.exitCode = 1
}

if (!process.exitCode && (!info?.configured && !info?.identityFingerprint || !/^[0-9a-f]{64}$/.test(info?.identityFingerprint || ''))) {
  process.stderr.write('Database identity fingerprint unavailable; configure a valid OWNER_ADMIN_DATABASE_URL or Sponsor/DATABASE_URL. No connection details were printed.\n')
  process.exitCode = 1
} else if (!process.exitCode) {
  process.stdout.write(JSON.stringify({
    sourceVariable: info.sourceVariable,
    provider: info.provider,
    connectionMode: info.connectionMode,
    identityFingerprint: info.identityFingerprint,
  }, null, 2) + '\n')
}
