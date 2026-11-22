export function databaseIdentity(value) {
  const url = new URL(value)
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname || url.pathname === '/') {
    throw new Error('invalid-postgres-database-url')
  }
  return [
    url.hostname.toLowerCase(),
    url.port || '5432',
    decodeURIComponent(url.pathname.slice(1)),
  ].join('|')
}

/**
 * node-postgres 8.16 currently treats libpq sslmode=require/prefer/verify-ca
 * as verify-full. Make that effective strict behavior explicit to avoid the
 * compatibility warning and prevent a future driver major from weakening TLS.
 * Other modes (including local sslmode=disable) are left untouched.
 */
export function normalizePostgresTlsMode(value) {
  const url = new URL(value)
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) {
    throw new Error('invalid-postgres-database-url')
  }
  const mode = (url.searchParams.get('sslmode') || '').toLowerCase()
  if (['require', 'prefer', 'verify-ca'].includes(mode)) {
    url.searchParams.set('sslmode', 'verify-full')
  }
  return url.toString()
}
