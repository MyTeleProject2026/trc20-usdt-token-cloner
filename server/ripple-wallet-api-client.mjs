/**
 * Ripple Custody (Wallet) server-to-server API transport.
 *
 * Implements Ripple's documented OAuth 2.0 client_credentials exchange only.
 * This is an authenticated API transport, NOT proof of a TRX credit facility,
 * fee sponsorship, or support for payable TriggerSmartContract submissions.
 */
const ALLOWED_API_ORIGINS = new Set([
  'https://api.sandbox.palisade.co',
  'https://api.palisade.co',
])
const TOKEN_PATH = '/v2/credentials/oauth/token'
const DEFAULT_TIMEOUT_MS = 10_000

function configError(code) {
  const error = new Error('Ripple Wallet API configuration is incomplete or invalid')
  error.code = code
  return error
}

function parseBaseUrl(value) {
  const raw = typeof value === 'string' && value.trim()
    ? value.trim()
    : 'https://api.sandbox.palisade.co'
  let parsed
  try { parsed = new URL(raw) } catch { throw configError('ripple-api-base-url-invalid') }
  if (!ALLOWED_API_ORIGINS.has(parsed.origin) || parsed.pathname !== '/'
    || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw configError('ripple-api-base-url-not-allowlisted')
  }
  return parsed.origin
}

function safePath(path) {
  let decodedPath = ''
  try { decodedPath = decodeURIComponent(String(path).split('?')[0]) } catch { throw configError('ripple-api-path-invalid') }
  if (typeof path !== 'string' || !path.startsWith('/v2/')
    || path.startsWith('//') || path.includes('\\') || decodedPath.includes('\\')
    || decodedPath.split('/').some((part) => part === '.' || part === '..')) {
    throw configError('ripple-api-path-invalid')
  }
  return path
}
function parseJsonResponse(response, body) {
  if (!response.ok) {
    const error = new Error('Ripple Wallet API request failed')
    error.code = 'ripple-api-http-error'
    error.status = response.status
    throw error
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const error = new Error('Ripple Wallet API returned an invalid response')
    error.code = 'ripple-api-response-invalid'
    throw error
  }
  return body
}

export function createRippleWalletApiClient({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw configError('fetch-unavailable')
  const baseUrl = parseBaseUrl(env.RIPPLE_WALLET_API_BASE_URL)
  const clientId = typeof env.RIPPLE_WALLET_CLIENT_ID === 'string' ? env.RIPPLE_WALLET_CLIENT_ID.trim() : ''
  const clientSecret = typeof env.RIPPLE_WALLET_CLIENT_SECRET === 'string' ? env.RIPPLE_WALLET_CLIENT_SECRET : ''
  let tokenCache = null

  async function fetchJson(url, options) {
    let response
    try {
      response = await fetchImpl(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      const error = new Error('Ripple Wallet API is unreachable')
      error.code = 'ripple-api-network-error'
      throw error
    }
    let body
    try { body = await response.json() } catch { body = null }
    return { response, body }
  }

  async function getAccessToken() {
    if (!clientId || !clientSecret) throw configError('ripple-api-credentials-missing')
    if (tokenCache && tokenCache.expiresAt > now() + 5_000) return tokenCache.accessToken

    const { response, body } = await fetchJson(baseUrl + TOKEN_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ clientId, clientSecret }),
    })
    const result = parseJsonResponse(response, body)
    if (typeof result.accessToken !== 'string' || result.accessToken.length < 20
      || !Number.isInteger(result.expiresIn) || result.expiresIn < 30) {
      throw configError('ripple-api-token-response-invalid')
    }
    tokenCache = {
      accessToken: result.accessToken,
      expiresAt: now() + result.expiresIn * 1000,
    }
    return tokenCache.accessToken
  }

  async function request(path, {
    method = 'GET',
    body,
    headers = {},
  } = {}) {
    const endpoint = safePath(path)
    const token = await getAccessToken()
    const requestHeaders = {
      accept: 'application/json',
      authorization: 'Bearer ' + token,
      ...headers,
    }
    const options = { method, headers: requestHeaders }
    if (body !== undefined) {
      requestHeaders['content-type'] = 'application/json'
      options.body = JSON.stringify(body)
    }
    const { response, body: responseBody } = await fetchJson(baseUrl + endpoint, options)
    if (response.status === 401) tokenCache = null
    return parseJsonResponse(response, responseBody)
  }

  return Object.freeze({
    providerId: 'ripple',
    apiBaseUrl: baseUrl,
    getAccessToken,
    request,
    clearToken: () => { tokenCache = null },
  })
}
