import './proxy-bootstrap.mjs'
import './credentials-store.mjs'
import express from 'express'
import { createServer as createHttpServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tatumRoutes from './routes/tatum.mjs'
import nativeTronRoutes from './routes/native-tron.mjs'
import { credentialGuard } from './credential-guard.mjs'
import { securityHeaders } from './security-headers.mjs'
import { initializeDatabase, getDatabaseStatus } from './database.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
process.chdir(root)

const app = express()
app.disable('x-powered-by')
app.use(securityHeaders)
app.use(express.json({ limit: '32kb' }))

const allowedOrigins = new Set(
  (process.env.FRONTEND_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
)
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin && allowedOrigins.size && !allowedOrigins.has(origin)) {
    return res.status(403).json({ success: false, error: 'origin-not-allowed' })
  }
  if (origin && (!allowedOrigins.size || allowedOrigins.has(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  }
  if (req.method === 'OPTIONS') return res.status(204).end()
  next()
})

app.use(credentialGuard)
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'tron-token-studio-api' }))
app.get('/', (_req, res) => res.json({ service: 'TRON Token Studio API', health: '/health' }))
app.get('/api/storage/status', async (_req, res) => {
  const database = await getDatabaseStatus()
  res.status(database.configured && !database.ready ? 503 : 200).json({ success: true, storage: database })
})
app.use('/api', tatumRoutes)
app.use('/api/tron', nativeTronRoutes)

if (process.env.DATABASE_URL) {
  try {
    const database = await initializeDatabase()
    console.log('Project database initialization:', database.ready ? 'ready' : 'not-configured')
  } catch {
    // Keep read-only chain verification endpoints available; storage status exposes failure.
    console.error('Project database initialization failed; persistence is unavailable')
  }
}

if (process.env.NODE_ENV !== 'production') {
  const [{ createServer: createViteServer }, { default: react }] = await Promise.all([
    import('vite'),
    import('@vitejs/plugin-react'),
  ])
  const server = createHttpServer(app)
  const vite = await createViteServer({
    root,
    configFile: false,
    cacheDir: '/tmp/vite',
    plugins: [react()],
    server: {
      middlewareMode: true,
      hmr: { server },
      allowedHosts: true,
    },
    appType: 'spa',
  })
  app.use(vite.middlewares)
  const port = Number(process.env.PORT || 3000)
  server.listen(port, '0.0.0.0', () => console.log(`development server listening on :${port}`))
} else {
  app.use((req, res) => res.status(404).json({ success: false, error: 'not-found' }))
  const port = Number(process.env.PORT || 10000)
  app.listen(port, '0.0.0.0', () => console.log(`TRON Token Studio API listening on :${port}`))
}
