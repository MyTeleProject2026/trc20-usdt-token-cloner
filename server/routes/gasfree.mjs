import { Router } from 'express'
import { createGasFreeClient } from '../gasfree-client.mjs'

const ALLOWED_NETWORKS = ['mainnet', 'nile']
const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const TRACE_ID = /^[A-Za-z0-9_-]{1,128}$/

export function createGasFreeRouter(client = createGasFreeClient()) {
  const router = Router()
  const capabilityCache = new Map()
  const detailCache = new Map()
  const cacheTtlMs = 30_000
  const detailCacheTtlMs = 5_000
  const maxCacheEntries = 500

  function getCached(cache, key) {
    const entry = cache.get(key)
    if (!entry) return null
    if (entry.expiresAt <= Date.now()) {
      cache.delete(key)
      return null
    }
    return entry
  }

  function setCached(cache, key, value, ttl) {
    if (cache.size >= maxCacheEntries && !cache.has(key)) {
      const oldestKey = cache.keys().next().value
      if (oldestKey !== undefined) cache.delete(oldestKey)
    }
    cache.set(key, { ...value, expiresAt: Date.now() + ttl })
  }

  // Provider discovery is read-only. This route never signs, submits, or
  // broadcasts any transfer and never returns server-side API credentials.
  router.get('/capabilities', async (req, res) => {
    const network = req.query?.network
    if (typeof network !== 'string' || !ALLOWED_NETWORKS.includes(network)) {
      return res.status(400).json({
        success: false,
        status: 'invalid-network',
        message: "network must be mainnet or nile. GasFree's documented provider endpoints do not include Shasta.",
      })
    }

    try {
      const cached = getCached(capabilityCache, network)
      if (cached) return res.status(cached.httpStatus).json(cached.body)

      const result = await client.getCapabilities(network)
      if (!result.configured) {
        const body = {
          success: false,
          status: 'not-configured',
          ...result,
          message: 'GasFree API access is not configured. Apply for provider API credentials; keep the API secret server-side.',
        }
        setCached(capabilityCache, network, { body, httpStatus: 503 }, 10_000)
        return res.status(503).json(body)
      }
      if (!result.reachable) {
        const body = {
          success: false,
          status: result.reason || 'provider-unreachable',
          ...result,
          message: 'GasFree provider discovery could not be verified. No transfer was submitted.',
        }
        setCached(capabilityCache, network, { body, httpStatus: 502 }, 5_000)
        return res.status(502).json(body)
      }
      const body = {
        ...result,
        success: true,
        status: 'provider-capabilities-read',
        checkedAt: new Date().toISOString(),
        // This router exposes discovery only. Never allow provider data or a
        // future adapter to turn a read-only response into send authorization.
        providerFundingVerified: false,
        canSubmitSponsoredTransfer: false,
        submissionEnabled: false,
      }
      setCached(capabilityCache, network, { body, httpStatus: 200 }, cacheTtlMs)
      return res.json(body)
    } catch {
      return res.status(502).json({
        success: false,
        status: 'provider-unreachable',
        network,
        message: 'GasFree provider discovery failed. No transfer was submitted.',
      })
    }
  })

  // Provider account metadata is useful for building a future wallet-signed
  // flow, but it is not a spendable balance ledger or independent chain proof.
  router.get('/account', async (req, res) => {
    const network = req.query?.network
    const address = req.query?.address
    if (typeof network !== 'string' || !ALLOWED_NETWORKS.includes(network)) {
      return res.status(400).json({ success: false, status: 'invalid-network', message: 'network must be mainnet or nile.' })
    }
    if (typeof address !== 'string' || !TRON_ADDRESS.test(address)) {
      return res.status(400).json({ success: false, status: 'invalid-address', message: 'Provide a valid TRON Base58 wallet address.' })
    }

    const key = `account:${network}:${address}`
    const cached = getCached(detailCache, key)
    if (cached) return res.status(cached.httpStatus).json(cached.body)

    try {
      const result = await client.getAccount(network, address)
      if (!result.configured) {
        const status = result.reason === 'invalid-account-address' ? 400 : 503
        const body = {
          success: false,
          status: result.reason || 'not-configured',
          network,
          message: status === 503
            ? 'GasFree API access is not configured for this network. No transfer was submitted.'
            : 'The account address is invalid.',
          ...(result.requiredEnvironment ? { requiredEnvironment: result.requiredEnvironment } : {}),
        }
        setCached(detailCache, key, { body, httpStatus: status }, 5_000)
        return res.status(status).json(body)
      }
      if (!result.reachable) {
        const body = {
          success: false, status: result.reason || 'provider-unreachable', network,
          message: 'GasFree account metadata could not be verified. No transfer was submitted.',
          ...(result.providerStatus ? { providerStatus: result.providerStatus } : {}),
        }
        setCached(detailCache, key, { body, httpStatus: 502 }, 3_000)
        return res.status(502).json(body)
      }
      const body = {
        ...result,
        success: true,
        status: 'provider-account-read',
        checkedAt: new Date().toISOString(),
        providerFundingVerified: false,
        canSubmitSponsoredTransfer: false,
        submissionEnabled: false,
      }
      setCached(detailCache, key, { body, httpStatus: 200 }, detailCacheTtlMs)
      return res.json(body)
    } catch {
      return res.status(502).json({
        success: false, status: 'provider-unreachable', network,
        message: 'GasFree account lookup failed. No transfer was submitted.',
      })
    }
  })

  // A trace ID is an opaque, provider-issued identifier. It is constrained to
  // safe path characters before the fixed-host provider client uses it.
  router.get('/trace', async (req, res) => {
    const network = req.query?.network
    const traceId = req.query?.traceId
    if (typeof network !== 'string' || !ALLOWED_NETWORKS.includes(network)) {
      return res.status(400).json({ success: false, status: 'invalid-network', message: 'network must be mainnet or nile.' })
    }
    if (typeof traceId !== 'string' || !TRACE_ID.test(traceId)) {
      return res.status(400).json({ success: false, status: 'invalid-trace-id', message: 'Provide a valid provider trace ID.' })
    }

    const key = `trace:${network}:${traceId}`
    const cached = getCached(detailCache, key)
    if (cached) return res.status(cached.httpStatus).json(cached.body)

    try {
      const result = await client.getTrace(network, traceId)
      if (!result.configured) {
        const status = result.reason === 'invalid-trace-id' ? 400 : 503
        const body = {
          success: false, status: result.reason || 'not-configured', network,
          message: status === 503
            ? 'GasFree API access is not configured for this network.'
            : 'The provider trace ID is invalid.',
          ...(result.requiredEnvironment ? { requiredEnvironment: result.requiredEnvironment } : {}),
        }
        setCached(detailCache, key, { body, httpStatus: status }, 5_000)
        return res.status(status).json(body)
      }
      if (!result.reachable) {
        const body = {
          success: false, status: result.reason || 'provider-unreachable', network,
          message: 'GasFree transfer status could not be verified. A trace failure is not proof that a transaction succeeded or failed on-chain.',
          ...(result.providerStatus ? { providerStatus: result.providerStatus } : {}),
        }
        setCached(detailCache, key, { body, httpStatus: 502 }, 3_000)
        return res.status(502).json(body)
      }
      const body = {
        ...result,
        success: true,
        status: 'provider-trace-read',
        checkedAt: new Date().toISOString(),
        providerFundingVerified: false,
        canSubmitSponsoredTransfer: false,
        submissionEnabled: false,
      }
      setCached(detailCache, key, { body, httpStatus: 200 }, detailCacheTtlMs)
      return res.json(body)
    } catch {
      return res.status(502).json({
        success: false, status: 'provider-unreachable', network,
        message: 'GasFree trace lookup failed. Query the same trace ID again later; do not infer success from a timeout.',
      })
    }
  })

  return router
}

export default createGasFreeRouter()
