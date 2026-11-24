import './proxy-bootstrap.mjs'
import './credentials-store.mjs'
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import nativeTronRoutes from './routes/native-tron.mjs'
import trc20VerificationRoutes from './routes/trc20-verification.mjs'
import tronWalletAuthRoutes, { createOwnerAuthRouter } from './routes/tron-wallet-auth.mjs'
import { createTokenAuthenticityRouter } from './routes/token-authenticity.mjs'
import { createChainTokenInspectionRouter } from './routes/chain-token-inspection.mjs'
import { credentialGuard } from './credential-guard.mjs'
import { securityHeaders } from './security-headers.mjs'
import { createCorsPolicy } from './cors-policy.mjs'
import { getDatabaseStatus } from './database.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
process.chdir(root)
const app = express()
app.disable('x-powered-by')
app.use(securityHeaders)
app.use(express.json({ limit: '32kb' }))
const configuredOrigins = [process.env.FRONTEND_ORIGIN, process.env.PACKAGED_APP_ORIGINS, process.env.TRON_TRANSFER_UI_ORIGIN]
  .filter((value) => typeof value === 'string' && value.trim()).join(',')
const { allowedOrigins, middleware: corsPolicy } = createCorsPolicy(configuredOrigins)
app.use(corsPolicy)
app.use(credentialGuard)
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'legacy-local-api-not-production' }))
app.get('/', (_req, res) => res.json({ service: 'Legacy local API (not the deployed Tron Transfer Resource API)', health: '/health' }))
app.get('/api/storage/status', async (_req, res) => {
  const database = await getDatabaseStatus()
  res.status(database.configured && !database.ready ? 503 : 200).json({ success: true, storage: database })
})
app.get('/api/readiness', async (_req, res) => {
  const database = await getDatabaseStatus()
  const checks = { database: database.ready === true, frontendOriginConfigured: allowedOrigins.size > 0 }
  const ready = checks.database && checks.frontendOriginConfigured
  return res.status(ready ? 200 : 503).json({
    success: ready, status: ready ? 'legacy-local-dependencies-healthy' : 'dependency-check-failed',
    database, checks, rpc: 'not the production Resource API; production Mainnet reads use Tatum-first/TronGrid-fallback and signed broadcasts use TronGrid',
    limitations: ['This legacy local API is not deployed by the existing Render Owner Admin services.', 'Production Owner and Sponsor operations run through Frontend-Tron-Transfer/resource-api and require their respective local wallet authorization.'],
  })
})
app.use('/api/tron', trc20VerificationRoutes)
app.use('/api/tron', nativeTronRoutes)
app.use('/api/auth/tron', tronWalletAuthRoutes)
app.use('/api/auth/owner', createOwnerAuthRouter())
app.use('/api/tron', createTokenAuthenticityRouter())
app.use('/api/tron', createChainTokenInspectionRouter())
if (process.env.NODE_ENV !== 'production') {
  const [{ createServer: createViteServer }, { default: react }] = await Promise.all([import('vite'), import('@vitejs/plugin-react')])
  const { createServer: createHttpServer } = await import('node:http')
  const server = createHttpServer(app)
  const vite = await createViteServer({ root, configFile: false, cacheDir: '/tmp/vite', plugins: [react()], server: { middlewareMode: true, hmr: { server }, allowedHosts: true }, appType: 'spa' })
  app.use(vite.middlewares)
  const port = Number(process.env.PORT || 3000)
  server.listen(port, '0.0.0.0', () => console.log(`development server listening on :${port}`))
} else {
  app.use((_req, res) => res.status(404).json({ success: false, error: 'not-found' }))
  const port = Number(process.env.PORT || 10000)
  app.listen(port, '0.0.0.0', () => console.log(`TRON Token Studio API listening on :${port}`))
}
