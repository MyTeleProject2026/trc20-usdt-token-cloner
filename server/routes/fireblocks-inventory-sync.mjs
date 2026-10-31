import { timingSafeEqual } from 'node:crypto'
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
const USDT_ABI = [
  { constant: true, inputs: [{ name: 'owner', type: 'address' }], name: 'balanceOf', outputs: [{ name: 'balance', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { constant: true, inputs: [], name: 'decimals', outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view', type: 'function' },
  { constant: true, inputs: [], name: 'symbol', outputs: [{ name: '', type: 'string' }], stateMutability: 'view', type: 'function' },
]

export function matchesFireblocksInventoryBearer(header, secret) {
  if (typeof header !== 'string' || typeof secret !== 'string' || secret.length < 32) return false
  const match = /^Bearer ([A-Za-z0-9._~-]{32,512})$/.exec(header)
  if (!match) return false
  const left = Buffer.from(match[1])
  const right = Buffer.from(secret)
  return left.length === right.length && timingSafeEqual(left, right)
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
  saveSnapshot = persistFireblocksInventorySnapshot,
  now = () => new Date(),
} = {}) {
  const router = Router()
  router.post('/fireblocks/inventory-sync', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const token = env.FIREBLOCKS_SYNC_TRIGGER_TOKEN || ''
    if (!matchesFireblocksInventoryBearer(req.get('authorization'), token)) {
      return res.status(401).json({ success: false, error: 'inventory-sync-unauthorized' })
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    const runId = String(body.workflowRunId || '')
    const attempt = body.workflowRunAttempt
    const commitSha = String(body.commitSha || '').toLowerCase()
    if (body.repository !== 'MyTeleProject2026/trc20-usdt-token-cloner'
      || body.branch !== 'main' || !/^[0-9]{1,24}$/.test(runId)
      || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > 100
      || !/^[0-9a-f]{40}$/.test(commitSha)) {
      return res.status(400).json({ success: false, error: 'invalid-inventory-sync-run-context' })
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
    const finalStatus = verified && saved.persisted && reasons.length === 0 ? 'verified' : 'blocked'
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
