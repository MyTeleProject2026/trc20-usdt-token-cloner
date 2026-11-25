const allowedHosts = new Set(['api.trongrid.io', 'nile.trongrid.io', 'api.shasta.trongrid.io'])

export async function tronGridProviderFetch(url, options = {}) {
  const target = new URL(url)
  if (target.protocol !== 'https:' || !allowedHosts.has(target.hostname)) throw new Error('Unapproved TRON RPC origin')
  const headers = new Headers(options.headers || {})
  if (process.env.TRONGRID_API_KEY) headers.set('TRON-PRO-API-KEY', process.env.TRONGRID_API_KEY)
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  return fetch(target, { ...options, headers })
}
