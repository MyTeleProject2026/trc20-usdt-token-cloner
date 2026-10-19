// Tatum access for server routes. API keys remain server-side.
export class MissingApiKeyError extends Error {
  constructor() {
    super('TATUM_API_KEY is not set')
    this.name = 'MissingApiKeyError'
  }
}

export function tatumApiBase() {
  return (process.env.TATUM_API_BASE || 'https://api.tatum.io').replace(/\/+$/, '')
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
  const response = await fetch(`${tatumApiBase()}${path.startsWith('/') ? path : `/${path}`}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    ...init,
    headers: withKey(init.headers),
  })
  const text = await response.text()
  let payload
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = { message: text.slice(0, 500) }
  }
  if (!response.ok) {
    const detail = typeof payload?.message === 'string' ? payload.message : typeof payload?.error === 'string' ? payload.error : 'Provider request failed'
    const error = new Error(`Tatum API ${response.status}: ${detail}`)
    error.status = response.status
    throw error
  }
  return payload
}
