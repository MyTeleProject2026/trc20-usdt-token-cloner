import { Router } from 'express'
import { TronWeb } from 'tronweb'
import { isValidTronAddress } from '../tron-address.mjs'

const NETWORKS = Object.freeze({
  mainnet: { tronGrid: 'https://api.trongrid.io', tatum: 'https://tron-mainnet.gateway.tatum.io' },
  nile: { tronGrid: 'https://nile.trongrid.io', tatum: 'https://tron-nile.gateway.tatum.io' },
  shasta: { tronGrid: 'https://api.shasta.trongrid.io', tatum: 'https://tron-shasta.gateway.tatum.io' },
})
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const CACHE_TTL_MS = 15_000
const MAX_CACHE_ENTRIES = 500
const TOKEN_ABI = [
  { constant: true, inputs: [{ name: 'owner', type: 'address' }], name: 'balanceOf', outputs: [{ name: 'balance', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { constant: true, inputs: [], name: 'decimals', outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view', type: 'function' },
  { constant: true, inputs: [], name: 'symbol', outputs: [{ name: '', type: 'string' }], stateMutability: 'view', type: 'function' },
  { constant: true, inputs: [], name: 'name', outputs: [{ name: '', type: 'string' }], stateMutability: 'view', type: 'function' },
  { constant: true, inputs: [], name: 'totalSupply', outputs: [{ name: 'balance', type: 'uint256' }], stateMutability: 'view', type: 'function' },
]

function isRateLimited(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status)
  const message = String(error?.message || '')
  return status === 429 || /\\b429\\b|rate.?limit|too many requests/i.test(message)
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function retryRead(operation, attempts = 3) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (!isRateLimited(error) || attempt === attempts - 1) throw error
      await delay(250 * (attempt + 1))
    }
  }
  throw lastError
}

function parseInteger(value, field) {
  let parsed
  try { parsed = BigInt(String(value)) } catch { throw new Error('invalid-' + field) }
  if (parsed < 0n || parsed > ((1n << 256n) - 1n)) throw new Error('invalid-' + field)
  return parsed.toString()
}

/**
 * Server-side, read-only TRC-20 inspection. The browser sends only public
 * addresses; provider credentials stay in the backend environment. Successful
 * results are briefly cached to reduce public-node request bursts.
 */
export function createChainTokenInspectionRouter({
  env = process.env,
  tronWebFactory = async (network) => {
    const tronGridKey = typeof env.TRONGRID_API_KEY === 'string' ? env.TRONGRID_API_KEY.trim() : ''
    const tatumKey = typeof env.TATUM_API_KEY === 'string' ? env.TATUM_API_KEY.trim() : ''
    if (tronGridKey) {
      return new TronWeb({ fullHost: NETWORKS[network].tronGrid, headers: { 'TRON-PRO-API-KEY': tronGridKey } })
    }
    if (tatumKey) {
      return new TronWeb({ fullHost: NETWORKS[network].tatum, headers: { 'x-api-key': tatumKey } })
    }
    // Read-only fallback. Provider credentials remain server-side; deploy a
    // provider key in production to avoid public endpoint rate limits.
    return new TronWeb({ fullHost: NETWORKS[network].tronGrid })
  },
  now = () => Date.now(),
} = {}) {
  const router = Router()
  const cache = new Map()
  const inFlight = new Map()

  function cacheSet(key, value) {
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value
      if (oldest) cache.delete(oldest)
    }
    cache.set(key, { expiresAt: now() + CACHE_TTL_MS, value })
  }

  router.get('/inspect-token', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    res.setHeader('Pragma', 'no-cache')
    const { network, contract, owner } = req.query || {}
    if (typeof network !== 'string' || !Object.hasOwn(NETWORKS, network)) {
      return res.status(400).json({ success: false, error: 'invalid-network' })
    }
    if (typeof contract !== 'string' || !ADDRESS_PATTERN.test(contract) || !isValidTronAddress(contract)) {
      return res.status(400).json({ success: false, error: 'invalid-contract-address' })
    }
    if (typeof owner !== 'string' || !ADDRESS_PATTERN.test(owner) || !isValidTronAddress(owner)) {
      return res.status(400).json({ success: false, error: 'invalid-owner-address' })
    }

    const key = network + ':' + contract + ':' + owner
    const cached = cache.get(key)
    if (cached && cached.expiresAt > now()) {
      return res.status(200).json({ ...cached.value, cache: 'hit' })
    }
    if (inFlight.has(key)) {
      try {
        const value = await inFlight.get(key)
        return res.status(200).json({ ...value, cache: 'shared-request' })
      } catch (error) {
        return respondProviderFailure(res, error)
      }
    }

    const work = (async () => {
      const tronWeb = await tronWebFactory(network)
      if (!tronWeb?.isAddress?.(contract) || !tronWeb?.isAddress?.(owner)
        || typeof tronWeb?.trx?.getContract !== 'function' || typeof tronWeb?.contract !== 'function') {
        throw new Error('provider-unavailable')
      }
      const deployed = await retryRead(() => tronWeb.trx.getContract(contract))
      const bytecode = typeof deployed?.bytecode === 'string' ? deployed.bytecode.replace(/^0x/i, '') : ''
      if (!bytecode || /^0+$/.test(bytecode)) throw Object.assign(new Error('contract-not-deployed'), { safeCode: 'contract-not-deployed' })

      const token = await retryRead(() => tronWeb.contract(TOKEN_ABI, contract))
      // Keep RPC calls sequential to avoid the burst that commonly triggers
      // HTTP 429 responses from public nodes on repeated manual verification.
      const rawBalance = await retryRead(() => token.balanceOf(owner).call())
      const rawDecimals = await retryRead(() => token.decimals().call())
      const rawSymbol = await retryRead(() => token.symbol().call())
      const rawName = await retryRead(() => token.name().call())
      const rawSupply = await retryRead(() => token.totalSupply().call())
      const balanceBaseUnits = parseInteger(rawBalance, 'balance')
      const totalSupplyBaseUnits = parseInteger(rawSupply, 'supply')
      const decimals = Number(String(rawDecimals))
      const symbol = String(rawSymbol || '').trim().slice(0, 32)
      const name = String(rawName || '').trim().slice(0, 80)
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36 || !symbol || !name) {
        throw Object.assign(new Error('invalid-token-metadata'), { safeCode: 'invalid-token-metadata' })
      }
      return {
        success: true,
        network,
        contractAddress: contract,
        ownerAddress: owner,
        onChainContractDeployed: true,
        onChainMetadataReadable: true,
        tokenType: 'trc20',
        tokenName: name,
        tokenSymbol: symbol,
        tokenDecimals: decimals,
        balanceBaseUnits,
        totalSupplyBaseUnits,
        checkedAt: new Date(now()).toISOString(),
      }
    })()
    inFlight.set(key, work)
    try {
      const value = await work
      cacheSet(key, value)
      return res.status(200).json({ ...value, cache: 'miss' })
    } catch (error) {
      return respondProviderFailure(res, error)
    } finally {
      if (inFlight.get(key) === work) inFlight.delete(key)
    }
  })

  function respondProviderFailure(res, error) {
    if (error?.safeCode === 'contract-not-deployed') {
      return res.status(404).json({ success: false, error: 'contract-not-deployed', message: 'No deployed contract bytecode was returned for this address on the selected network.' })
    }
    if (error?.safeCode === 'invalid-token-metadata') {
      return res.status(422).json({ success: false, error: 'invalid-token-metadata', message: 'The contract did not return valid TRC-20 metadata.' })
    }
    if (isRateLimited(error)) {
      return res.status(503).json({ success: false, error: 'chain-provider-rate-limited', retryable: true, message: 'The chain provider is rate limiting requests. Wait briefly and retry; no token verification or transfer was performed.' })
    }
    return res.status(503).json({ success: false, error: 'chain-provider-unavailable', retryable: true, message: 'Live token inspection is temporarily unavailable. No token verification or transfer was performed.' })
  }

  return router
}

export default createChainTokenInspectionRouter
