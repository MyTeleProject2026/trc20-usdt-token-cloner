import { createHash } from 'node:crypto'
import { Router } from 'express'
import { TronWeb } from 'tronweb'
import { getWalletAuthSession } from '../database.mjs'
import {
  createFireblocksClient,
  fireblocksConfiguration,
  isNativeFireblocksTrxAsset,
  isOfficialFireblocksUsdtAsset,
} from '../fireblocks-client.mjs'

const USDT_MAINNET = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const OWNER_ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const VAULT_ID_PATTERN = /^\d{1,32}$/
const MAX_VAULT_PAGES = 5
const MAX_ASSET_PAGES = 5
const MAX_ADDRESS_PROBES = 8
const PAGE_SIZE = 200

function bearerToken(req) {
  const value = req.get('authorization') || ''
  return /^Bearer ([A-Za-z0-9_-]{43})$/.exec(value)?.[1] || ''
}

function rowsFrom(value, keys) {
  if (Array.isArray(value)) return value
  for (const key of keys) {
    if (Array.isArray(value?.[key])) return value[key]
  }
  return []
}

function nextCursorFrom(value) {
  const candidates = [
    value?.paging?.pageCursor,
    value?.paging?.after,
    value?.paging?.next,
    value?.pageCursor,
    value?.nextPageCursor,
    value?.after,
    value?.next,
  ]
  return candidates.find((item) => typeof item === 'string' && item.trim()) || ''
}

async function readAllPages(readPage, { keys, maxPages }) {
  const items = []
  const seen = new Set()
  let cursor = ''
  let truncated = false
  for (let page = 0; page < maxPages; page += 1) {
    const response = await readPage(cursor || undefined)
    items.push(...rowsFrom(response, keys))
    const next = nextCursorFrom(response)
    if (!next) return { items, truncated }
    if (seen.has(next)) throw new Error('fireblocks-pagination-cursor-loop')
    seen.add(next)
    cursor = next
  }
  truncated = Boolean(cursor)
  return { items, truncated }
}

function assetIdOf(asset) {
  const id = typeof asset?.id === 'string' ? asset.id
    : typeof asset?.legacyId === 'string' ? asset.legacyId : ''
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) ? id : ''
}

function activeAssetIds(vault) {
  const entries = Array.isArray(vault?.assets) ? vault.assets : []
  return new Set(entries.map((item) => typeof item === 'string' ? item
    : typeof item?.id === 'string' ? item.id : '').filter(Boolean))
}

function safeVaultName(value) {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f]/g, '')
  return normalized ? normalized.slice(0, 120) : null
}

function addressList(value, isValidAddress) {
  const rows = Array.isArray(value) ? value
    : Array.isArray(value?.addresses) ? value.addresses
      : Array.isArray(value?.data) ? value.data : []
  return [...new Set(rows.map((item) => typeof item === 'string' ? item
    : typeof item?.address === 'string' ? item.address
      : typeof item?.addressString === 'string' ? item.addressString
        : typeof item?.address_string === 'string' ? item.address_string : '')
    .filter((address) => OWNER_ADDRESS_PATTERN.test(address) && isValidAddress(address))]
}

function hasExactSymbol(asset, expected) {
  const symbols = [asset?.symbol, asset?.displaySymbol, asset?.onchain?.symbol]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim().toUpperCase())
  return symbols.length > 0 && symbols.every((symbol) => symbol === expected)
}

export function createFireblocksDiscoveryRouter({
  env = process.env,
  getSession = getWalletAuthSession,
  fireblocksFactory = (currentEnv) => createFireblocksClient(currentEnv),
  tronWebFactory = () => new TronWeb({ fullHost: 'https://api.trongrid.io' }),
  isValidAddress = (value) => OWNER_ADDRESS_PATTERN.test(value),
  now = () => Date.now(),
} = {}) {
  const router = Router()

  router.get('/fireblocks/discovery', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Vary', 'Authorization, Origin')

    const ownerAddress = typeof env.OWNER_WALLET_ADDRESS === 'string' ? env.OWNER_WALLET_ADDRESS.trim() : ''
    const treasuryOwnerAddress = typeof env.TREASURY_OWNER_ADDRESS === 'string' ? env.TREASURY_OWNER_ADDRESS.trim() : ''
    if (!OWNER_ADDRESS_PATTERN.test(ownerAddress) || ownerAddress !== treasuryOwnerAddress
      || !isValidAddress(ownerAddress)) {
      return res.status(503).json({ success: false, error: 'treasury-owner-configuration-invalid' })
    }

    const token = bearerToken(req)
    const origin = req.get('origin')
    if (!token || !origin || origin.length > 512) {
      return res.status(401).json({ success: false, error: 'owner-session-required' })
    }

    let sessionResult
    try {
      sessionResult = await getSession({
        tokenHash: createHash('sha256').update(token, 'utf8').digest('hex'),
        origin,
        nowMs: now(),
      })
    } catch {
      sessionResult = null
    }
    if (sessionResult?.success !== true || !sessionResult.session) {
      return res.status(503).json({ success: false, error: 'owner-session-storage-unavailable' })
    }
    const session = sessionResult.session
    if (session.network !== 'mainnet' || session.origin !== origin) {
      return res.status(401).json({ success: false, error: 'owner-session-invalid-or-expired' })
    }
    if (session.address !== ownerAddress) {
      return res.status(403).json({ success: false, error: 'owner-wallet-not-authorized' })
    }

    const providerConfig = fireblocksConfiguration(env)
    if (!providerConfig.credentialsConfigured) {
      return res.status(200).json({
        success: true,
        discoveryStatus: 'credentials-required',
        checkedAt: new Date(now()).toISOString(),
        configuration: {
          apiBase: providerConfig.apiBase,
          credentialsConfigured: false,
          credentialsMissing: providerConfig.credentialsMissing,
          vaultAccountIdConfigured: Boolean(providerConfig.vaultAccountId),
          usdtAssetIdConfigured: Boolean(providerConfig.usdtAssetId),
          trxAssetIdConfigured: Boolean(providerConfig.trxAssetId),
        },
        vaultAccounts: [],
        officialUsdtAssets: [],
        nativeTrxAssets: [],
        candidateVaults: [],
        suggestedConfiguration: null,
        note: 'Read-only discovery requires the sponsor-issued Fireblocks API key and mounted API authentication key file. No vault or asset setting is guessed.',
      })
    }

    try {
      const fireblocks = fireblocksFactory(env)
      const [vaultResult, usdtResult, trxResult] = await Promise.all([
        readAllPages((cursor) => fireblocks.getPagedVaultAccounts({
          limit: PAGE_SIZE,
          orderBy: 'ASC',
          ...(cursor ? { after: cursor } : {}),
        }), { keys: ['accounts', 'vaultAccounts', 'items', 'data'], maxPages: MAX_VAULT_PAGES }),
        readAllPages((cursor) => fireblocks.getAssets({
          symbol: 'USDT',
          pageSize: 500,
          ...(cursor ? { pageCursor: cursor } : {}),
        }), { keys: ['assets', 'items', 'data'], maxPages: MAX_ASSET_PAGES }),
        readAllPages((cursor) => fireblocks.getAssets({
          symbol: 'TRX',
          pageSize: 500,
          ...(cursor ? { pageCursor: cursor } : {}),
        }), { keys: ['assets', 'items', 'data'], maxPages: MAX_ASSET_PAGES }),
      ])

      const tronWeb = tronWebFactory()
      if (!tronWeb?.address?.toHex) {
        return res.status(503).json({ success: false, error: 'tron-address-validation-unavailable' })
      }

      const officialUsdtAssets = [...new Map(usdtResult.items
        .filter((asset) => hasExactSymbol(asset, 'USDT')
          && isOfficialFireblocksUsdtAsset(asset, tronWeb, USDT_MAINNET))
        .map((asset) => [assetIdOf(asset), asset])
        .filter(([id]) => Boolean(id))).entries()]
        .map(([id, asset]) => ({ id, symbol: 'USDT', contractAddress: USDT_MAINNET, decimals: 6,
          name: safeVaultName(asset?.name) }))
      const nativeTrxAssets = [...new Map(trxResult.items
        .filter((asset) => isNativeFireblocksTrxAsset(asset, assetIdOf(asset)))
        .map((asset) => [assetIdOf(asset), asset])
        .filter(([id]) => Boolean(id))).entries()]
        .map(([id, asset]) => ({ id, symbol: 'TRX', decimals: 6, name: safeVaultName(asset?.name) }))

      const accounts = vaultResult.items.filter((vault) => VAULT_ID_PATTERN.test(String(vault?.id || '')))
      const candidates = accounts.map((vault) => {
        const active = activeAssetIds(vault)
        const usdtIds = officialUsdtAssets.filter((asset) => active.has(asset.id)).map((asset) => asset.id)
        const trxIds = nativeTrxAssets.filter((asset) => active.has(asset.id)).map((asset) => asset.id)
        return {
          vaultAccountId: String(vault.id),
          name: safeVaultName(vault.name),
          hiddenOnUI: vault.hiddenOnUI === true,
          officialUsdtAssetIds: usdtIds,
          nativeTrxAssetIds: trxIds,
          candidate: usdtIds.length > 0 && trxIds.length > 0,
          configuredVaultMatch: String(vault.id) === providerConfig.vaultAccountId,
        }
      }).filter((vault) => vault.candidate)
        .sort((a, b) => Number(b.configuredVaultMatch) - Number(a.configuredVaultMatch)
          || a.vaultAccountId.localeCompare(b.vaultAccountId, undefined, { numeric: true }))

      const probedCandidates = []
      for (const candidate of candidates.slice(0, MAX_ADDRESS_PROBES)) {
        const addressChecks = []
        for (const usdtAssetId of candidate.officialUsdtAssetIds) {
          for (const trxAssetId of candidate.nativeTrxAssetIds) {
            const [usdtAddressResponse, trxAddressResponse] = await Promise.all([
              fireblocks.getAssetAddresses(usdtAssetId, candidate.vaultAccountId, { credentialsOnly: true }),
              fireblocks.getAssetAddresses(trxAssetId, candidate.vaultAccountId, { credentialsOnly: true }),
            ])
            const usdtAddresses = addressList(usdtAddressResponse, isValidAddress)
            const trxAddresses = addressList(trxAddressResponse, isValidAddress)
            const addressMatches = usdtAddresses.length === 1 && trxAddresses.length === 1
              && usdtAddresses[0] === trxAddresses[0]
            addressChecks.push({
              usdtAssetId,
              trxAssetId,
              providerAddressVerified: addressMatches,
              usdtAddressCount: usdtAddresses.length,
              trxAddressCount: trxAddresses.length,
              treasuryAddressCandidate: addressMatches ? usdtAddresses[0] : null,
              configuredUsdtAssetMatch: usdtAssetId === providerConfig.usdtAssetId,
              configuredTrxAssetMatch: trxAssetId === providerConfig.trxAssetId,
            })
          }
        }
        const uniqueVerified = addressChecks.filter((item) => item.providerAddressVerified)
        probedCandidates.push({
          ...candidate,
          addressChecks,
          unambiguousAddressPair: uniqueVerified.length === 1 && addressChecks.length === 1,
          ...(uniqueVerified.length === 1 ? {
            treasuryAddressCandidate: uniqueVerified[0].treasuryAddressCandidate,
            suggestedUsdtAssetId: uniqueVerified[0].usdtAssetId,
            suggestedTrxAssetId: uniqueVerified[0].trxAssetId,
          } : {}),
        })
      }

      const suggested = probedCandidates.filter((item) => item.unambiguousAddressPair)
      const singleSuggestion = probedCandidates.length === 1 && candidates.length === 1 && suggested.length === 1
        ? suggested[0] : null
      const truncated = vaultResult.truncated || usdtResult.truncated || trxResult.truncated
        || candidates.length > MAX_ADDRESS_PROBES
      return res.json({
        success: true,
        discoveryStatus: truncated ? 'partial' : singleSuggestion ? 'single-unambiguous-candidate' : 'review-required',
        checkedAt: new Date(now()).toISOString(),
        configuration: {
          apiBase: providerConfig.apiBase,
          credentialsConfigured: true,
          credentialsMissing: [],
          vaultAccountIdConfigured: Boolean(providerConfig.vaultAccountId),
          usdtAssetIdConfigured: Boolean(providerConfig.usdtAssetId),
          trxAssetIdConfigured: Boolean(providerConfig.trxAssetId),
        },
        vaultAccounts: accounts.slice(0, 100).map((vault) => ({
          vaultAccountId: String(vault.id),
          name: safeVaultName(vault.name),
          activeAssetCount: activeAssetIds(vault).size,
        })),
        officialUsdtAssets,
        nativeTrxAssets,
        candidateVaults: probedCandidates,
        suggestedConfiguration: singleSuggestion ? {
          vaultAccountId: singleSuggestion.vaultAccountId,
          usdtAssetId: singleSuggestion.suggestedUsdtAssetId,
          trxAssetId: singleSuggestion.suggestedTrxAssetId,
          treasuryAddress: singleSuggestion.treasuryAddressCandidate,
        } : null,
        discoveryTruncated: truncated,
        note: 'Read-only discovery only. A suggestion is not an approved treasury configuration, sponsor release, balance check, transaction policy approval, or permission to transfer funds.',
      })
    } catch {
      return res.status(503).json({
        success: false,
        error: 'fireblocks-discovery-unavailable',
        note: 'The authorized Fireblocks workspace could not be enumerated. No configuration was changed.',
      })
    }
  })

  return router
}

export default createFireblocksDiscoveryRouter
