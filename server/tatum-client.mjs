// Tatum access for server routes. API keys remain server-side.
export class MissingApiKeyError extends Error {
  constructor() {
    super('TATUM_API_KEY is not set')
    this.name = 'MissingApiKeyError'
  }
}

const APPROVED_API_ORIGIN = 'https://api.tatum.io'

export function tatumApiBase() {
  const configured = process.env.TATUM_API_BASE || APPROVED_API_ORIGIN
  let parsed
  try {
    parsed = new URL(configured)
  } catch {
    throw new Error('Invalid Tatum API base configuration')
  }
  if (parsed.protocol !== 'https:' || parsed.origin !== APPROVED_API_ORIGIN || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('TATUM_API_BASE must be the approved HTTPS Tatum API origin')
  }
  return APPROVED_API_ORIGIN
}

function apiKey() {
  const key = process.env.TATUM_API_KEY
  if (!key) throw new MissingApiKeyError()
  return key
}

const TIMEOUT_MS = 20000

function withKey(headers) {
  const result = new Headers(headers)
  result.set('x-api-key', apiKey())
  return result
}

export async function tatumFetch(path, init = {}) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    throw new Error('Tatum API path must be an absolute path on the approved API origin')
  }
  const response = await fetch(`${tatumApiBase()}${path}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    ...init,
    headers: withKey(init.headers),
  })
  const text = await response.text()
  let payload
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }
  if (!response.ok) {
    const error = new Error('Tatum provider request failed')
    error.status = response.status
    throw error
  }
  return payload
}
