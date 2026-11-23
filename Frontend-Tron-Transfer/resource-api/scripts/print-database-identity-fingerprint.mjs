import { sponsorDatabaseConnectionInfo } from '../sponsor-api.mjs'

const info = sponsorDatabaseConnectionInfo(process.env)
if (!info.configured || !/^[0-9a-f]{64}$/.test(info.identityFingerprint || '')) {
  process.stderr.write('Database identity fingerprint unavailable; configure a valid SPONSOR_DATABASE_URL_POOLED, SPONSOR_DATABASE_URL, DATABASE_URL_POOLED, or DATABASE_URL. No connection details were printed.\n')
  process.exitCode = 1
} else {
  process.stdout.write(JSON.stringify({
    sourceVariable: info.sourceVariable,
    provider: info.provider,
    connectionMode: info.connectionMode,
    identityFingerprint: info.identityFingerprint,
  }, null, 2) + '\n')
}
