// Apply conservative browser security headers to API responses.
// HSTS is added only in production, where Render terminates HTTPS.
export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')

  // Keep the restrictive JSON/API policy off the Vite HTML app in development.
  const path = req.path || ''
  if (path === '/api' || path.startsWith('/api/') || path === '/health') {
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'")
  }
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
  next()
}
