import { Router } from 'express'
import { createGasFreeClient } from '../gasfree-client.mjs'
import { createGasFreeChainVerifier } from '../gasfree-chain-verifier.mjs'
import { recordTransferVerification } from '../database.mjs'

const ALLOWED_NETWORKS = ['mainnet', 'nile']
const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const TRACE_ID = /^[A-Za-z0-9_-]{1,128}$/
const UINT256_MAX = (1n << 256n) - 1n

export function createGasFreeRouter(client = createGasFreeClient(), {
  verifyOnChain = createGasFreeChainVerifier(),
  persistVerifiedTrace = async (input) => {
    try {
      return await recordTransferVerification(input)
    } catch {
      return { persisted: false, reason: 'persistence-failed' }
    }
  },
} = {}) {
  const router = Router()
  const capabilityCache = new Map()
  const detailCache = new Map()
  const forcedTraceRefreshAt = new Map()
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

  // Report whether server-side credentials exist without exposing their values.
  // This is configuration diagnostics only: it does not prove provider reachability,
  // sponsor funding, transaction authorization, or permission to submit transfers.
  router.get('/config-status', (_req, res) => {
    const networks = Object.fromEntries(ALLOWED_NETWORKS.map((network) => {
      const configured = typeof client.isConfigured === 'function'
        && client.isConfigured(network) === true
      const requiredEnvironment = network === 'mainnet'
        ? ['GASFREE_MAINNET_API_KEY', 'GASFREE_MAINNET_API_SECRET']
        : ['GASFREE_NILE_API_KEY', 'GASFREE_NILE_API_SECRET']
      return [network, {
        configured,
        status: configured ? 'credentials-configured' : 'credentials-missing',
        ...(!configured ? { requiredEnvironment } : {}),
      }]
    }))
    const allConfigured = Object.values(networks).every((network) => network.configured)
    return res.json({
      success: true,
      status: allConfigured ? 'credentials-configured' : 'credentials-missing',
      networks,
      providerReachabilityVerified: false,
      providerFundingVerified: false,
      canSubmitSponsoredTransfer: false,
      submissionEnabled: false,
      note: 'Credential presence only. Use /capabilities to test provider API access; neither endpoint verifies sponsor funding or enables transfers.',
    })
  })

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

  // Read-only preflight: report whether provider, token, account and token-fee
  // metadata fit the product policy. This endpoint never signs or submits.
  router.post('/preflight', async (req, res) => {
    const body = req.body
    const allowedFields = new Set([
      'network', 'address', 'tokenAddress', 'serviceProvider',
      'receiverAddress', 'amountBaseUnits',
    ])
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => !allowedFields.has(key))) {
      return res.status(400).json({
        success: false,
        status: 'invalid-request',
        message: 'Provide only network, address, tokenAddress, serviceProvider, receiverAddress and amountBaseUnits.',
      })
    }
    const { network, address, tokenAddress, serviceProvider, receiverAddress, amountBaseUnits } = body
    if (typeof network !== 'string' || !ALLOWED_NETWORKS.includes(network)) {
      return res.status(400).json({
        success: false,
        status: 'invalid-network',
        message: 'network must be mainnet or nile. GasFree does not document Shasta support.',
      })
    }
    if (typeof address !== 'string' || !TRON_ADDRESS.test(address)
      || typeof tokenAddress !== 'string' || !TRON_ADDRESS.test(tokenAddress)
      || typeof serviceProvider !== 'string' || !TRON_ADDRESS.test(serviceProvider)
      || typeof receiverAddress !== 'string' || !TRON_ADDRESS.test(receiverAddress)) {
      return res.status(400).json({
        success: false,
        status: 'invalid-address',
        message: 'address, tokenAddress, serviceProvider and receiverAddress must be valid TRON Base58 addresses.',
      })
    }
    if (address === receiverAddress) {
      return res.status(400).json({
        success: false,
        status: 'self-transfer-not-allowed',
        message: 'The receiver must be different from the initiating wallet.',
      })
    }
    if (typeof amountBaseUnits !== 'string'
      || !/^[1-9][0-9]{0,77}$/.test(amountBaseUnits)
      || BigInt(amountBaseUnits) > UINT256_MAX) {
      return res.status(400).json({
        success: false,
        status: 'invalid-amount',
        message: 'amountBaseUnits must be a positive decimal integer string to preserve exact token units.',
      })
    }

    try {
      const [capabilities, accountResult] = await Promise.all([
        client.getCapabilities(network),
        client.getAccount(network, address),
      ])
      if (!capabilities?.configured) {
        return res.status(503).json({
          success: false,
          status: 'credentials-not-configured',
          network,
          canSubmitSponsoredTransfer: false,
          submissionEnabled: false,
          message: 'GasFree API credentials are not configured for this network. No transfer was submitted.',
        })
      }
      if (!capabilities?.reachable || !Array.isArray(capabilities.providers) || !Array.isArray(capabilities.tokens)) {
        return res.status(502).json({
          success: false,
          status: capabilities?.reason || 'provider-capabilities-unavailable',
          network,
          canSubmitSponsoredTransfer: false,
          submissionEnabled: false,
          message: 'GasFree provider and token discovery could not be verified. No transfer was submitted.',
        })
      }
      if (!accountResult?.configured) {
        return res.status(503).json({
          success: false,
          status: accountResult?.reason || 'account-lookup-not-configured',
          network,
          canSubmitSponsoredTransfer: false,
          submissionEnabled: false,
          message: 'GasFree account lookup is not configured. No transfer was submitted.',
        })
      }
      if (!accountResult?.reachable || !accountResult?.account
        || accountResult.account.accountAddress !== address
        || !Array.isArray(accountResult.account.assets)) {
        return res.status(502).json({
          success: false,
          status: accountResult?.reason || 'account-metadata-unavailable',
          network,
          canSubmitSponsoredTransfer: false,
          submissionEnabled: false,
          message: 'GasFree account metadata could not be verified for the requested wallet. No transfer was submitted.',
        })
      }

      const provider = capabilities.providers.find((item) => item?.address === serviceProvider)
      const token = capabilities.tokens.find((item) => item?.tokenAddress === tokenAddress)
      const account = accountResult.account
      const accountAsset = account.assets.find((item) => item?.tokenAddress === tokenAddress)
      const validFee = (value) => typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value)
      const activationCandidate = accountAsset?.activationFeeBaseUnits ?? token?.activationFeeBaseUnits
      const transferCandidate = accountAsset?.transferFeeBaseUnits ?? token?.transferFeeBaseUnits
      const activationFeeBaseUnits = validFee(activationCandidate) ? activationCandidate : null
      const transferFeeBaseUnits = validFee(transferCandidate) ? transferCandidate : null
      const activationFeeApplicable = account.active !== true
      const feeDataKnown = transferFeeBaseUnits !== null
        && (!activationFeeApplicable || activationFeeBaseUnits !== null)
      const requiredActivationFee = activationFeeApplicable ? activationFeeBaseUnits : '0'
      const estimatedTokenFeeBaseUnits = feeDataKnown
        ? (BigInt(requiredActivationFee) + BigInt(transferFeeBaseUnits)).toString()
        : null
      const tokenFeePolicyCompatible = feeDataKnown && estimatedTokenFeeBaseUnits === '0'
      const providerListed = Boolean(provider)
      const tokenSupported = token?.supported === true
      const accountAllowsSubmit = account.allowSubmit === true
      const transferPolicyPreflightPassed = providerListed && tokenSupported
        && accountAllowsSubmit && tokenFeePolicyCompatible

      const blockers = []
      if (!providerListed) blockers.push('selected-service-provider-not-listed')
      if (!token) blockers.push('token-contract-not-listed-by-provider')
      else if (!tokenSupported) blockers.push('token-not-supported-by-provider')
      if (!accountAllowsSubmit) blockers.push('provider-account-does-not-allow-submit')
      if (!feeDataKnown) blockers.push('token-fee-metadata-incomplete')
      else if (!tokenFeePolicyCompatible) blockers.push('token-denominated-fees-conflict-with-external-sponsor-only-policy')
      // The current app deliberately does not sign EIP-712 authorizations or
      // submit them to GasFree. Keep the final operational gates explicit.
      blockers.push('gasfree-account-token-balance-not-independently-verified')
      blockers.push('wallet-eip712-authorization-flow-not-integrated')
      blockers.push('external-sponsor-agreement-and-funded-budget-not-verified')
      blockers.push('provider-submission-adapter-disabled')

      return res.json({
        success: true,
        status: transferPolicyPreflightPassed
          ? 'policy-preflight-passed-submission-still-disabled'
          : 'policy-preflight-blocked',
        network,
        address,
        tokenAddress,
        serviceProvider,
        receiverAddress,
        amountBaseUnits,
        providerListed,
        tokenListed: Boolean(token),
        tokenSupported,
        account: {
          active: account.active === true,
          allowSubmit: accountAllowsSubmit,
          nonce: Number.isSafeInteger(account.nonce) && account.nonce >= 0 ? account.nonce : null,
        },
        fees: {
          currency: 'transferred-token',
          activationFeeApplicable,
          activationFeeBaseUnits,
          transferFeeBaseUnits,
          estimatedTokenFeeBaseUnits,
          externalSponsorOnlyCompatible: tokenFeePolicyCompatible,
        },
        transferPolicyPreflightPassed,
        canPrepareWalletAuthorization: false,
        canSubmitSponsoredTransfer: false,
        submissionEnabled: false,
        providerFundingVerified: false,
        providerSubmissionAttempted: false,
        transactionBroadcast: false,
        unpaidFallbackToUserFunds: false,
        blockers,
        note: 'Preflight only. Provider metadata is not an on-chain balance proof, sponsorship agreement, user signature, transfer submission or settlement record.',
        checkedAt: new Date().toISOString(),
      })
    } catch {
      return res.status(502).json({
        success: false,
        status: 'preflight-unavailable',
        network,
        canSubmitSponsoredTransfer: false,
        submissionEnabled: false,
        message: 'GasFree preflight failed safely. No transfer was submitted.',
      })
    }
  })

  // Explicit, fail-closed submission contract. This route deliberately does not
  // validate or forward a user signature, call the provider, reserve budgets, or
  // broadcast a transaction. GasFree's published token-denominated fees do not
  // satisfy the project's external-sponsor-only policy without a separately
  // verified sponsor agreement and fee funding model.
  router.post('/submit', (_req, res) => {
    return res.status(503).json({
      success: false,
      status: 'sponsored-submission-disabled',
      enabled: false,
      providerSubmissionAttempted: false,
      transactionBroadcast: false,
      providerFundingVerified: false,
      externalSponsorConfirmed: false,
      feePolicyConfirmed: false,
      canSubmitSponsoredTransfer: false,
      submissionEnabled: false,
      unpaidFallbackToUserFunds: false,
      requiredBeforeEnablement: [
        'verified-external-sponsor-agreement-and-funded-account',
        'fee-policy-compatible-with-external-sponsor-only',
        'wallet-side-authorization-and-reviewed-signature-validation',
        'provider-token-network-and-amount-allowlists',
        'nonce-deadline-replay-and-idempotency-protection',
        'atomic-separate-fee-and-principal-budget-reservation',
        'Nile-end-to-end-tests-and-solidified-chain-reconciliation',
        'security-review-and-explicit-Mainnet-operator-approval',
      ],
      message: 'Sponsored submission is disabled. This endpoint does not call GasFree, reserve funds, sign, or broadcast a transaction. No user-funded fallback is permitted.',
    })
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
    const forceRefresh = req.query?.refresh === '1'
    const cached = getCached(detailCache, key)
    const lastForcedRefreshAt = forcedTraceRefreshAt.get(key) || 0
    const refreshIsThrottled = forceRefresh
      && lastForcedRefreshAt > 0
      && Date.now() - lastForcedRefreshAt < detailCacheTtlMs

    // The UI's explicit retry may bypass the cached trace once per TTL window.
    // This both allows a real finality re-check and prevents one trace ID from
    // causing unbounded provider calls. Ordinary reads remain cache-first.
    if (cached && (!forceRefresh || refreshIsThrottled)) {
      return res.status(cached.httpStatus).json(cached.body)
    }
    if (forceRefresh) {
      if (refreshIsThrottled) {
        return res.status(429).json({
          success: false,
          status: 'trace-refresh-rate-limited',
          network,
          retryAfterMs: Math.max(0, detailCacheTtlMs - (Date.now() - lastForcedRefreshAt)),
          message: 'This trace was freshly rechecked recently. Retry after the refresh interval; do not resubmit the transfer.',
        })
      }
      if (forcedTraceRefreshAt.size >= maxCacheEntries && !forcedTraceRefreshAt.has(key)) {
        const oldestKey = forcedTraceRefreshAt.keys().next().value
        if (oldestKey !== undefined) forcedTraceRefreshAt.delete(oldestKey)
      }
      forcedTraceRefreshAt.set(key, Date.now())
    }

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
      // The provider trace is only a transaction locator. Verify any reported
      // transaction hash against the selected network's solidified transaction
      // body and receipt before marking it verified or persisting it.
      const sourceTrace = result.trace && typeof result.trace === 'object' ? result.trace : null
      let chainVerification = {
        verified: false,
        status: 'not-attempted',
        reason: 'provider-trace-missing',
      }
      if (sourceTrace) {
        try {
          chainVerification = await verifyOnChain({ network, trace: sourceTrace })
        } catch {
          chainVerification = {
            verified: false,
            status: 'verification-unavailable',
            reason: 'solidified-chain-verification-failed',
          }
        }
      }

      let verificationPersistence = { persisted: false, reason: 'transfer-not-verified' }
      if (chainVerification?.verified === true) {
        try {
          const saved = await persistVerifiedTrace({
            network,
            transactionHash: chainVerification.txId || sourceTrace?.transactionId,
            tokenContract: chainVerification.tokenContractAddress,
            fromAddress: chainVerification.fromAddress,
            toAddress: chainVerification.toAddress,
            amountBaseUnits: chainVerification.amountSun,
            status: 'verified-on-chain',
            logIndex: chainVerification.logIndex,
            result: chainVerification,
          })
          verificationPersistence = saved?.persisted === true
            ? { persisted: true }
            : { persisted: false, reason: saved?.reason || 'persistence-unavailable' }
        } catch {
          verificationPersistence = { persisted: false, reason: 'persistence-failed' }
        }
      }

      const verifiedTrace = sourceTrace
        ? {
            ...sourceTrace,
            verifiedOnChain: chainVerification?.verified === true,
            chainVerification,
            verificationPersistence,
          }
        : null
      const body = {
        ...result,
        ...(verifiedTrace ? { trace: verifiedTrace } : { chainVerification }),
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
