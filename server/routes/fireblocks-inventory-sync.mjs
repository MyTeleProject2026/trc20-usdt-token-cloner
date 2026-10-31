import { createPublicKey, verify as verifySignature } from 'node:crypto'
import { Router } from 'express'
import { TronWeb } from 'tronweb'
import {
  createFireblocksClient, fireblocksConfiguration, extractFireblocksAddresses,
  providerAssetAvailableBaseUnits, fireblocksAssetIdentifierMatches,
  isOfficialFireblocksUsdtAsset, isNativeFireblocksTrxAsset,
} from '../fireblocks-client.mjs'
import { persistFireblocksInventorySnapshot } from '../database.mjs'

const USDT_MAINNET = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const OIDC_ISSUER = 'https://token.actions.githubusercontent.com'
const OIDC_DISCOVERY = OIDC_ISSUER + '/.well-known/openid-configuration'
const OIDC_AUDIENCE = 'tron-token-studio-fireblocks-inventory'
const REPOSITORY = 'MyTeleProject2026/trc20-usdt-token-cloner'
const REPOSITORY_ID = '1424901043'
const REPOSITORY_OWNER = 'MyTeleProject2026'
const REPOSITORY_OWNER_ID = '267598483'
const WORKFLOW_REF = REPOSITORY + '/.github/workflows/fireblocks-inventory-sync.yml@refs/heads/main'
const WORKFLOW_NAME = 'Fireblocks read-only inventory sync and config export'
const WORKFLOW_ENVIRONMENT = 'fireblocks-readonly-sync'
const USDT_ABI = [
  { constant: true, inputs: [{ name: 'owner', type: 'address' }], name: 'balanceOf', outputs: [{ name: 'balance', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { constant: true, inputs: [], name: 'decimals', outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view', type: 'function' },
  { constant: true, inputs: [], name: 'symbol', outputs: [{ name: '', type: 'string' }], stateMutability: 'view', type: 'function' },
]

let jwksCache
let jwksCacheExpiresAt = 0

async function loadGitHubJwks(fetchImpl, now, forceRefresh = false) {
  if (!forceRefresh && Array.isArray(jwksCache?.keys) && jwksCacheExpiresAt > now()) return jwksCache
  if (typeof fetchImpl !== 'function') throw new Error('OIDC key fetch unavailable')
  const discoveryResponse = await fetchImpl(OIDC_DISCOVERY, {
    method: 'GET', headers: { Accept: 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(8000),
  })
  if (!discoveryResponse?.ok) throw new Error('OIDC discovery unavailable')
  const discovery = await discoveryResponse.json()
  const jwksUrl = new URL(String(discovery?.jwks_uri || ''))
  if (jwksUrl.protocol !== 'https:' || jwksUrl.hostname !== 'token.actions.githubusercontent.com') {
    throw new Error('Unexpected OIDC key endpoint')
  }
  const jwksResponse = await fetchImpl(jwksUrl.toString(), {
    method: 'GET', headers: { Accept: 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(8000),
  })
  if (!jwksResponse?.ok) throw new Error('OIDC signing keys unavailable')
  const jwks = await jwksResponse.json()
  if (!Array.isArray(jwks?.keys) || jwks.keys.length < 1 || jwks.keys.length > 32) {
    throw new Error('Invalid OIDC signing key set')
  }
  jwksCache = jwks
  jwksCacheExpiresAt = now() + 10 * 60 * 1000
  return jwks
}

function decodeJwtSegment(segment) {
  if (typeof segment !== 'string' || segment.length < 1 || segment.length > 12_000
    || !/^[A-Za-z0-9_-]+$/.test(segment)) return null
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

/**
 * Authenticate the specific GitHub Actions workflow with its short-lived OIDC
 * token. No long-lived trigger secret is duplicated between GitHub and Render.
 * The signature, issuer, audience, repository IDs, main ref, workflow file,
 * environment, event type and run identity must all match exactly.
 */
export async function verifyGitHubActionsInventoryOidcToken(token, expected, {
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  if (typeof token !== 'string' || token.length > 16_384) return { verified: false, reason: 'invalid-oidc-token' }
  const parts = token.split('.')
  if (parts.length !== 3) return { verified: false, reason: 'invalid-oidc-token' }
  const header = decodeJwtSegment(parts[0])
  const claims = decodeJwtSegment(parts[1])
  if (!header || !claims || header.alg !== 'RS256'
    || header.typ !== 'JWT' || typeof header.kid !== 'string' || header.kid.length > 256) {
    return { verified: false, reason: 'invalid-oidc-token-header' }
  }

  let jwks
  try {
    jwks = await loadGitHubJwks(fetchImpl, now)
  } catch {
    return { verified: false, reason: 'github-oidc-keys-unavailable' }
  }
  let jwk = jwks.keys.find((key) => key?.kid === header.kid)
  if (!jwk) {
    try {
      jwks = await loadGitHubJwks(fetchImpl, now, true)
      jwk = jwks.keys.find((key) => key?.kid === header.kid)
    } catch {
      return { verified: false, reason: 'github-oidc-keys-unavailable' }
    }
  }
  if (!jwk || jwk.kty !== 'RSA' || (jwk.use && jwk.use !== 'sig') || (jwk.alg && jwk.alg !== 'RS256')) {
    return { verified: false, reason: 'github-oidc-signing-key-not-found' }
  }

  let signatureValid = false
  try {
    const publicKey = createPublicKey({ key: jwk, format: 'jwk' })
    if (publicKey.asymmetricKeyType !== 'rsa'
      || (publicKey.asymmetricKeyDetails?.modulusLength || 0) < 2048) {
      return { verified: false, reason: 'github-oidc-signing-key-invalid' }
    }
    signatureValid = verifySignature(
      'RSA-SHA256',
      Buffer.from(parts[0] + '.' + parts[1], 'utf8'),
      publicKey,
      Buffer.from(parts[2], 'base64url'),
    )
  } catch {
    return { verified: false, reason: 'github-oidc-signature-invalid' }
  }
  if (!signatureValid) return { verified: false, reason: 'github-oidc-signature-invalid' }

  const nowSeconds = Math.floor(now() / 1000)
  const numericTime = (value) => typeof value === 'number' && Number.isSafeInteger(value)
  if (claims.iss !== OIDC_ISSUER
    || claims.aud !== OIDC_AUDIENCE
    || !numericTime(claims.exp) || !numericTime(claims.iat)
    || claims.exp <= nowSeconds || claims.iat > nowSeconds + 30
    || claims.iat < nowSeconds - 600 || claims.exp - claims.iat > 600
    || (claims.nbf !== undefined && (!numericTime(claims.nbf) || claims.nbf > nowSeconds + 30))) {
    return { verified: false, reason: 'github-oidc-standard-claims-invalid' }
  }

  const allowedSubjects = new Set([
    'repo:MyTeleProject2026/trc20-usdt-token-cloner:environment:fireblocks-readonly-sync',
    'repo:MyTeleProject2026@267598483/trc20-usdt-token-cloner@1424901043:environment:fireblocks-readonly-sync',
  ])
  const exactClaims = {
    sub: allowedSubjects.has(claims.sub),
    repository: claims.repository === REPOSITORY,
    repository_id: String(claims.repository_id || '') === REPOSITORY_ID,
    repository_owner: claims.repository_owner === REPOSITORY_OWNER,
    repository_owner_id: String(claims.repository_owner_id || '') === REPOSITORY_OWNER_ID,
    ref: claims.ref === 'refs/heads/main',
    environment: claims.environment === WORKFLOW_ENVIRONMENT,
    event_name: claims.event_name === 'workflow_dispatch',
    workflow_ref: claims.workflow_ref === WORKFLOW_REF,
    workflow: claims.workflow === WORKFLOW_NAME,
    run_id: String(claims.run_id || '') === String(expected?.workflowRunId || ''),
    run_attempt: String(claims.run_attempt || '') === String(expected?.workflowRunAttempt || ''),
    sha: typeof expected?.commitSha === 'string' && claims.sha === expected.commitSha.toLowerCase(),
    jti: typeof claims.jti === 'string' && claims.jti.length >= 8 && claims.jti.length <= 256,
  }
  const failedClaim = Object.keys(exactClaims).find((key) => exactClaims[key] !== true)
  if (failedClaim) return { verified: false, reason: 'github-oidc-claim-mismatch-' + failedClaim }
  return { verified: true }
}

const digits = (value) => typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value)
const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 96)

export function createFireblocksInventorySyncRouter({
  env = process.env,
  fireblocksFactory = (currentEnv) => createFireblocksClient(currentEnv),
  tronFactory = () => new TronWeb({
    fullHost: 'https://api.trongrid.io',
    ...(env.TRONGRID_API_KEY ? { headers: { 'TRON-PRO-API-KEY': env.TRONGRID_API_KEY } } : {}),
  }),
  fetchImpl = globalThis.fetch,
  saveSnapshot = persistFireblocksInventorySnapshot,
  now = () => new Date(),
} = {}) {
  const router = Router()
  router.post('/fireblocks/inventory-sync', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const authHeader = req.get('authorization') || ''
    const oidcToken = /^Bearer ([A-Za-z0-9._~-]{32,16384})$/.exec(authHeader)?.[1] || ''
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    const runId = String(body.workflowRunId || '')
    const attempt = body.workflowRunAttempt
    const commitSha = String(body.commitSha || '').toLowerCase()
    if (body.repository !== REPOSITORY || body.branch !== 'main'
      || !/^[0-9]{1,24}$/.test(runId)
      || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > 100
      || !/^[0-9a-f]{40}$/.test(commitSha)) {
      return res.status(400).json({ success: false, error: 'invalid-inventory-sync-run-context' })
    }

    const oidc = await verifyGitHubActionsInventoryOidcToken(oidcToken, {
      workflowRunId: runId, workflowRunAttempt: attempt, commitSha,
    }, { fetchImpl, now: () => now().getTime() })
    if (!oidc.verified) {
      return res.status(401).json({ success: false, error: 'inventory-sync-unauthorized', reason: oidc.reason })
    }

    const checkedAt = now()
    const cfg = fireblocksConfiguration(env)
    const address = typeof env.TREASURY_ADDRESS === 'string' ? env.TREASURY_ADDRESS.trim() : ''
    const configuration = {
      apiBase: cfg.apiBase, vaultAccountId: cfg.vaultAccountId || null,
      usdtAssetId: cfg.usdtAssetId || null, trxAssetId: cfg.trxAssetId || null,
      treasuryAddress: ADDRESS_PATTERN.test(address) ? address : null,
      secretKeyPath: cfg.secretKeyPath || null, apiKeyConfigured: Boolean(cfg.apiKey),
      rsaKeyConfigured: false, signerMode: 'fireblocks', network: 'mainnet',
      usdtContract: USDT_MAINNET, usdtDecimals: 6, trxDecimals: 6,
    }
    const checks = {
      fireblocksApiAuthenticated: null, vaultAccountVerified: null,
      usdtAssetActivated: null, officialUsdtAssetVerified: null, usdtAddressMatches: null,
      trxAssetActivated: null, nativeTrxAssetVerified: null, trxAddressMatches: null,
      officialUsdtChainVerified: null, treasuryTrxChainBalanceRead: null, databaseReady: false,
    }
    const balances = {
      fireblocksUsdtAvailableBaseUnits: null, chainUsdtBalanceBaseUnits: null,
      fireblocksTrxAvailableBaseUnits: null, chainTrxBalanceSun: null,
    }
    const reasons = [...cfg.providerMissing.map(slug)]
    if (!cfg.usdtAssetId) reasons.push('fireblocks-usdt-asset-id-missing')
    if (!cfg.trxAssetConfigured) reasons.push('fireblocks-trx-asset-id-missing')
    if (!ADDRESS_PATTERN.test(address)) reasons.push('treasury-address-not-configured')

    if (cfg.providerConfigured && cfg.usdtAssetId && cfg.trxAssetConfigured && ADDRESS_PATTERN.test(address)) {
      try {
        const fb = fireblocksFactory(env)
        const tron = tronFactory()
        if (!tron?.isAddress?.(address) || !tron?.address?.toHex || !tron?.trx?.getBalance || !tron?.contract) {
          reasons.push('tron-read-provider-unavailable')
        } else {
          const vault = await fb.getVaultAccount()
          checks.fireblocksApiAuthenticated = true
          configuration.rsaKeyConfigured = true
          checks.vaultAccountVerified = String(vault?.id || '') === cfg.vaultAccountId
          const active = new Set((Array.isArray(vault?.assets) ? vault.assets : [])
            .map((item) => typeof item === 'string' ? item : String(item?.id || '')).filter(Boolean))
          checks.usdtAssetActivated = active.has(cfg.usdtAssetId)
          checks.trxAssetActivated = active.has(cfg.trxAssetId)
          const [usdtMeta, usdtVault, usdtAddr, trxMeta, trxVault, trxAddr] = await Promise.all([
            fb.getAssetMetadata(cfg.usdtAssetId), fb.getVaultAccountAsset(cfg.usdtAssetId), fb.getAssetAddresses(cfg.usdtAssetId),
            fb.getAssetMetadata(cfg.trxAssetId), fb.getVaultAccountAsset(cfg.trxAssetId), fb.getAssetAddresses(cfg.trxAssetId),
          ])
          checks.officialUsdtAssetVerified = fireblocksAssetIdentifierMatches(usdtMeta, cfg.usdtAssetId)
            && (usdtVault?.id === undefined || fireblocksAssetIdentifierMatches(usdtVault, cfg.usdtAssetId))
            && isOfficialFireblocksUsdtAsset(usdtMeta, tron, USDT_MAINNET)
          checks.nativeTrxAssetVerified = isNativeFireblocksTrxAsset(trxMeta, cfg.trxAssetId)
            && (trxVault?.id === undefined || fireblocksAssetIdentifierMatches(trxVault, cfg.trxAssetId))
          const usdtAddresses = [...new Set(extractFireblocksAddresses(usdtAddr))]
          const trxAddresses = [...new Set(extractFireblocksAddresses(trxAddr))]
          checks.usdtAddressMatches = usdtAddresses.length === 1 && usdtAddresses[0] === address
          checks.trxAddressMatches = trxAddresses.length === 1 && trxAddresses[0] === address
          const usdtAvailable = providerAssetAvailableBaseUnits(usdtVault)
          const trxAvailable = providerAssetAvailableBaseUnits(trxVault)
          if (usdtAvailable !== null) balances.fireblocksUsdtAvailableBaseUnits = usdtAvailable
          else reasons.push('fireblocks-usdt-available-balance-unavailable')
          if (trxAvailable !== null) balances.fireblocksTrxAvailableBaseUnits = trxAvailable
          else reasons.push('fireblocks-trx-available-balance-unavailable')

          if (checks.officialUsdtAssetVerified && checks.usdtAddressMatches) {
            const token = await tron.contract(USDT_ABI).at(USDT_MAINNET)
            const [symbol, decimals, raw] = await Promise.all([
              token.symbol().call(), token.decimals().call(), token.balanceOf(address).call(),
            ])
            const value = String(raw)
            checks.officialUsdtChainVerified = String(symbol).toUpperCase() === 'USDT' && Number(decimals) === 6 && digits(value)
            if (checks.officialUsdtChainVerified) balances.chainUsdtBalanceBaseUnits = value
          }
          if (checks.trxAddressMatches) {
            const value = String(await tron.trx.getBalance(address))
            checks.treasuryTrxChainBalanceRead = digits(value)
            if (checks.treasuryTrxChainBalanceRead) balances.chainTrxBalanceSun = value
          }
          if (!checks.vaultAccountVerified) reasons.push('fireblocks-vault-account-id-mismatch')
          if (!checks.usdtAssetActivated) reasons.push('fireblocks-usdt-asset-not-activated')
          if (!checks.officialUsdtAssetVerified) reasons.push('fireblocks-asset-not-official-tron-usdt')
          if (!checks.usdtAddressMatches) reasons.push('fireblocks-usdt-vault-address-mismatch')
          if (!checks.trxAssetActivated) reasons.push('fireblocks-trx-asset-not-activated')
          if (!checks.nativeTrxAssetVerified) reasons.push('fireblocks-asset-not-native-trx')
          if (!checks.trxAddressMatches) reasons.push('fireblocks-trx-vault-address-mismatch')
          if (!checks.officialUsdtChainVerified) reasons.push('official-tron-usdt-chain-check-failed')
          if (!checks.treasuryTrxChainBalanceRead) reasons.push('treasury-trx-chain-balance-unavailable')
        }
      } catch {
        reasons.push('fireblocks-or-chain-read-failed')
      }
    }
    const required = Object.keys(checks).filter((key) => key !== 'databaseReady')
    const verified = required.every((key) => checks[key] === true)
    checks.databaseReady = Boolean(env.DATABASE_URL)
    const status = verified && checks.databaseReady && reasons.length === 0 ? 'verified' : 'blocked'
    let saved = { persisted: false, reason: 'database-not-configured' }
    try {
      saved = await saveSnapshot({
        workflowRunId: runId, workflowRunAttempt: attempt,
        repository: body.repository, branch: body.branch, commitSha,
        verificationStatus: status, checkedAt, configuration, checks, balances, reasons,
      })
    } catch {
      saved = { persisted: false, reason: 'database-persistence-failed' }
    }
    if (!saved.persisted) {
      checks.databaseReady = false
      reasons.push(saved.reason || 'database-persistence-failed')
    }
    const finalStatus = verified && checks.databaseReady && saved.persisted && reasons.length === 0 ? 'verified' : 'blocked'
    return res.json({
      success: true, verificationStatus: finalStatus, snapshotSaved: saved.persisted,
      snapshotId: saved.persisted ? saved.id : null, duplicateRun: saved.duplicate === true,
      checkedAt: checkedAt.toISOString(), configuration, checks, balances,
      reasons: [...new Set(reasons)],
      note: 'Read-only inventory sync. No vault creation, policy approval, signing, transfer submission, or payout activation is performed.',
    })
  })
  return router
}

export default createFireblocksInventorySyncRouter
