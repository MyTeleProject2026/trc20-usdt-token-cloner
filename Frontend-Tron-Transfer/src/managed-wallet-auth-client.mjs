const ROLES = new Set(['owner', 'sponsor'])

function safeRole(role) {
  if (!ROLES.has(role)) throw new TypeError('wallet-auth-role-invalid')
  return role
}

function readCsrfCookie(cookieString = '', role) {
  const match = String(cookieString).match(/(?:^|;\\s*)tron_wallet_csrf=([^;]+)/)
  return match ? decodeURIComponent(match[1]) : ''
}

export function createManagedWalletAuthClient({
  role,
  apiBaseUrl = import.meta.env?.VITE_RESOURCE_API_URL || 'https://tron-transfer-resource-api.onrender.com',
  fetchImpl = fetch,
  cookieReader = () => typeof document === 'undefined' ? '' : document.cookie,
} = {}) {
  const walletRole = safeRole(role)
  const base = String(apiBaseUrl).replace(/\\/+$/, '')
  const root = base + '/api/wallet-auth/' + walletRole
  let csrfToken = ''

  async function request(path, { method = 'GET', body, enrollmentToken, csrf = false } = {}) {
    const headers = { accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (enrollmentToken) headers['x-' + walletRole + '-enrollment-token'] = enrollmentToken
    if (csrf) {
      const token = csrfToken || readCsrfCookie(cookieReader(), walletRole)
      if (!token) throw new Error('WALLET_AUTH_CSRF_TOKEN_MISSING')
      headers['x-csrf-token'] = token
    }
    const response = await fetchImpl(root + path, {
      method,
      headers,
      credentials: 'include',
      cache: 'no-store',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      const code = typeof payload.error === 'string' ? payload.error : 'WALLET_AUTH_REQUEST_FAILED'
      throw Object.assign(new Error(code), { status: response.status, code })
    }
    if (payload?.role && payload.role !== walletRole) throw new Error('WALLET_AUTH_ROLE_MISMATCH')
    if (payload?.session?.csrfToken) csrfToken = payload.session.csrfToken
    return payload
  }

  return Object.freeze({
    role: walletRole,
    status: () => request('/status'),
    enroll: (password, enrollmentToken) => request('/enroll', {
      method: 'POST', body: { password }, enrollmentToken,
    }),
    login: password => request('/login', { method: 'POST', body: { password } }),
    session: () => request('/session'),
    logout: () => request('/logout', { method: 'POST', csrf: true }).finally(() => { csrfToken = '' }),
  })
}
