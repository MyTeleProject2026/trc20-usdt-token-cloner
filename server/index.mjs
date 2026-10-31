import './proxy-bootstrap.mjs'
import './credentials-store.mjs'
import express from 'express'
import { createServer as createHttpServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tatumRoutes from './routes/tatum.mjs'
import nativeTronRoutes from './routes/native-tron.mjs'
import sponsorIntegrationReadinessRoutes from './routes/sponsor-integration-readiness.mjs'
import sponsorTestnetPilotRoutes from './routes/sponsor-testnet-pilot.mjs'
import sponsorSettlementRoutes from './routes/sponsor-settlement.mjs'
import sponsorChainCostObservationRoutes from './routes/sponsor-chain-cost-observations.mjs'
import sponsorSolidifiedReconciliationRoutes from './routes/sponsor-solidified-reconciliation.mjs'
import trc20VerificationRoutes from './routes/trc20-verification.mjs'
import sponsorFeeEstimateRoutes from './routes/sponsor-fee-estimate.mjs'
import gasFreeRoutes from './routes/gasfree.mjs'
import tronWalletAuthRoutes, { createOwnerAuthRouter } from './routes/tron-wallet-auth.mjs'
import okxDepositStatusRoutes from './routes/okx-deposit-status.mjs'
import treasuryWithdrawalsRoutes from './routes/treasury-withdrawals.mjs'
import fireblocksInventorySyncRoutes from './routes/fireblocks-inventory-sync.mjs'
import { createTokenAuthenticityRouter } from './routes/token-authenticity.mjs'
import { createChainTokenInspectionRouter } from './routes/chain-token-inspection.mjs'
import treasuryPayoutReadinessRoutes from './routes/treasury-payout-readiness.mjs'
import sponsorRequestIntakeRoutes from './routes/sponsor-request-intake.mjs'
import ownerTreasuryRoutes from './routes/owner-treasury.mjs'
import { credentialGuard } from './credential-guard.mjs'
import { securityHeaders } from './security-headers.mjs'
import { createCorsPolicy } from './cors-policy.mjs'
import { isReadOnlyServiceReady } from './readiness-policy.mjs'
import { initializeDatabase, getDatabaseStatus } from './database.mjs'
import { tatumFetch, MissingApiKeyError } from './tatum-client.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
process.chdir(root)

const app = express()
app.disable('x-powered-by')
app.use(securityHeaders)
app.use(express.json({ limit: '32kb' }))

// Keep the hosted frontend allowlist intact while allowing explicitly opted-in
// packaged clients. PACKAGED_APP_ORIGINS is separate so a Render merge update
// does not replace any already configured FRONTEND_ORIGIN entries.
const configuredOrigins = [
  process.env.FRONTEND_ORIGIN,
  process.env.PACKAGED_APP_ORIGINS,
  // Dedicated non-secret allowlist entry for the OKX read-only status page.
  // This additive variable avoids overwriting an existing frontend allowlist.
  process.env.OKX_UI_ORIGIN,
].filter((value) => typeof value === 'string' && value.trim()).join(',')
const { allowedOrigins, middleware: corsPolicy } = createCorsPolicy(configuredOrigins)
app.use(corsPolicy)

app.use(credentialGuard)
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'tron-token-studio-api' }))
app.get('/', (_req, res) => res.json({ service: 'TRON Token Studio API', health: '/health' }))
app.get('/api/storage/status', async (_req, res) => {
  const database = await getDatabaseStatus()
  res.status(database.configured && !database.ready ? 503 : 200).json({ success: true, storage: database })
})

// Tatum deprecated /v3/tron/info; use the unified current-block endpoint.
const TATUM_TRON_HEALTH_PATH = '/v4/data/blockchains/block/current?chain=tron-mainnet'

// Probe the same authenticated, read-only Tatum endpoint used by readiness.
// The API root itself is not a health endpoint and may legitimately return 404.
app.get('/api/status', async (_req, res) => {
  if (!process.env.TATUM_API_KEY) return res.json({ status: 'no-api-key' })
  try {
    await tatumFetch(TATUM_TRON_HEALTH_PATH)
    return res.json({ status: 'connected' })
  } catch (error) {
    if (error instanceof MissingApiKeyError) return res.json({ status: 'no-api-key' })
    if (Number.isInteger(error?.status)) {
      return res.json({ status: 'provider-response', providerStatus: error.status })
    }
    const configurationError = error instanceof Error && [
      'Invalid Tatum API base configuration',
      'TATUM_API_BASE must be the approved HTTPS Tatum API origin',
    ].includes(error.message)
    return res.json({
      status: 'egress-failed',
      errorCategory: configurationError ? 'configuration-error' : 'network-error',
    })
  }
})

app.get('/api/readiness', async (_req, res) => {
  const database = await getDatabaseStatus()
  const tatum = {
    configured: Boolean(process.env.TATUM_API_KEY),
    reachable: false,
    status: process.env.TATUM_API_KEY ? 'not-tested' : 'missing-api-key',
  }
  if (tatum.configured) {
    try {
      // Exercise the supported authenticated Tatum current-block endpoint.
      // Do not return provider payloads, credentials, or raw error messages.
      await tatumFetch(TATUM_TRON_HEALTH_PATH)
      tatum.reachable = true
      tatum.status = 'reachable'
    } catch (error) {
      const configurationError = error instanceof Error && [
        'Invalid Tatum API base configuration',
        'TATUM_API_BASE must be the approved HTTPS Tatum API origin',
      ].includes(error.message)
      tatum.status = error instanceof MissingApiKeyError
        ? 'missing-api-key'
        : configurationError
          ? 'configuration-error'
          : Number.isInteger(error?.status)
            ? 'provider-http-error'
            : 'provider-unreachable'
      if (Number.isInteger(error?.status)) tatum.httpStatus = error.status
    }
  }
  const providers = {
    tatum,
    tronGridApiKey: { configured: Boolean(process.env.TRONGRID_API_KEY) },
    frontendOrigin: { configured: allowedOrigins.size > 0 },
  }
  const ready = isReadOnlyServiceReady({ database, providers })
  return res.status(ready ? 200 : 503).json({
    success: ready,
    status: ready ? 'read-only-dependencies-healthy' : 'dependency-check-failed',
    database,
    providers,
    limitations: [
      'This endpoint tests database connectivity and a read-only Tatum API request; it is not proof of an on-chain transfer.',
      'Transfers still require user wallet authorization, actual assets, and network fees.',
      'On-chain confirmation does not guarantee exchange deposit credit.',
    ],
  })
})
app.use('/api', tatumRoutes)
app.use('/api/tron', trc20VerificationRoutes)
app.use('/api/tron', sponsorFeeEstimateRoutes)
app.use('/api/tron', nativeTronRoutes)
app.use('/api/tron', sponsorIntegrationReadinessRoutes)
app.use('/api/tron', sponsorTestnetPilotRoutes)
app.use('/api/tron', sponsorSettlementRoutes)
app.use('/api/tron', sponsorChainCostObservationRoutes)
app.use('/api/tron', sponsorSolidifiedReconciliationRoutes)
app.use('/api/gasfree', gasFreeRoutes)
app.use('/api/auth/tron', tronWalletAuthRoutes)
app.use('/api/auth/owner', createOwnerAuthRouter())
app.use('/api/okx', okxDepositStatusRoutes)
app.use('/api/treasury', treasuryWithdrawalsRoutes)
app.use('/api/treasury', fireblocksInventorySyncRoutes)
app.use('/api/tron', sponsorRequestIntakeRoutes)
app.use('/api/tron', createTokenAuthenticityRouter())
app.use('/api/tron', createChainTokenInspectionRouter())
app.use('/api', treasuryPayoutReadinessRoutes)
app.use('/api/treasury/owner', ownerTreasuryRoutes)

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
