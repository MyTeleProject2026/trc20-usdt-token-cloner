function normalizeOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = new URL(value.trim())
    if (!['https:', 'http:'].includes(parsed.protocol)
      || parsed.origin === 'null'
      || parsed.username
      || parsed.password
      || (parsed.pathname !== '' && parsed.pathname !== '/')
      || parsed.search
      || parsed.hash) {
      return null
    }
    return parsed.origin
  } catch {
    return null
  }
}

/**
 * Build an explicit browser-origin allowlist.
 *
 * Requests without an Origin header remain usable for server-to-server and
 * command-line clients. Browser requests are rejected unless their origin is
 * explicitly configured; an empty allowlist never reflects arbitrary origins.
 */
export function createCorsPolicy(configuredOrigins = '') {
  const allowedOrigins = new Set(
    String(configuredOrigins)
      .split(',')
      .map(normalizeOrigin)
      .filter(Boolean),
  )

  const middleware = (req, res, next) => {
    const origin = req.headers?.origin
    if (typeof origin === 'string' && origin.length > 0) {
      const normalizedOrigin = normalizeOrigin(origin)
      if (!normalizedOrigin || normalizedOrigin !== origin || !allowedOrigins.has(normalizedOrigin)) {
        return res.status(403).json({ success: false, error: 'origin-not-allowed' })
      }
      res.setHeader('Access-Control-Allow-Origin', normalizedOrigin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
      res.setHeader('Access-Control-Max-Age', '600')
    }
    if (req.method === 'OPTIONS') return res.status(204).end()
    return next()
  }

  return { allowedOrigins, middleware }
}
