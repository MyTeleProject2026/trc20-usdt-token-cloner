const NETWORKS = Object.freeze({
  mainnet: { host: 'https://tron-mainnet.gateway.tatum.io', addressEnv: 'SPONSOR_MAINNET_ADDRESS' },
  shasta: { host: 'https://tron-shasta.gateway.tatum.io', addressEnv: 'SPONSOR_SHASTA_ADDRESS' },
  nile: { host: 'https://tron-nile.gateway.tatum.io', addressEnv: 'SPONSOR_NILE_ADDRESS' },
})

const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const OFFICIAL_MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const TOKEN_ASSETS = Object.freeze(['USDT', 'VTRC'])

function formatSun(value) {
  const sun = BigInt(value)
  const whole = sun / 1_000_000n
  const fraction = (sun % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

function readTokenAllowlist(env, network) {
  const tokens = []
  for (const asset of TOKEN_ASSETS) {
    // Mainnet USDT has one well-known official Tether contract. Never let a
    // configurable symbol map a different contract to official USDT.
    const contracts = asset === 'USDT' && network === 'mainnet'
      ? [OFFICIAL_MAINNET_USDT]
      : String(env[`SPONSOR_${asset}_${network.toUpperCase()}_CONTRACTS`] || '')
        .split(',').map((value) => value.trim()).filter(Boolean)
    for (const contract of [...new Set(contracts)]) {
      if (!ADDRESS_PATTERN.test(contract)) {
        return { valid: false, reason: 'invalid-token-contract-allowlist' }
      }
      tokens.push({ asset, contract })
      if (tokens.length > 10) return { valid: false, reason: 'token-contract-allowlist-too-large' }
    }
  }
  return { valid: true, tokens }
}

export function createSponsorFundingReader({
  env = process.env,
  fetchImpl = globalThis.fetch,
  tronWebFactory = async (host) => {
    const { TronWeb } = await import('tronweb')
    return new TronWeb({ fullHost: host })
  },
} = {}) {
  const cache = new Map()
  const inFlight = new Map()
  const forcedRefreshAt = new Map()
  const cacheTtlMs = 10_000
  const failureCacheTtlMs = 3_000
  async function readFreshSponsorFundingStatus(network) {
    const config = typeof network === 'string' && Object.hasOwn(NETWORKS, network)
      ? NETWORKS[network] : null
    if (!config) return { configured: false, network: network ?? null, status: 'invalid-network', onChainBalanceRead: false }
    const sponsorAddress = typeof env[config.addressEnv] === 'string' ? env[config.addressEnv].trim() : ''
    if (!sponsorAddress) {
      return {
        configured: false,
        network,
        status: 'sponsor-address-not-configured',
        requiredEnvironment: [config.addressEnv],
        onChainBalanceRead: false,
        sponsorFundingVerified: false,
        sponsorAgreementVerified: false,
        canSubmitSponsoredTransfer: false,
        submissionEnabled: false,
      }
    }
    if (!ADDRESS_PATTERN.test(sponsorAddress)) {
      return {
        configured: false,
        network,
        status: 'invalid-sponsor-address',
        requiredEnvironment: [config.addressEnv],
        onChainBalanceRead: false,
        sponsorFundingVerified: false,
        canSubmitSponsoredTransfer: false,
        submissionEnabled: false,
      }
    }
    if (typeof env.TATUM_API_KEY !== 'string' || !env.TATUM_API_KEY.trim()) {
      return {
        configured: true,
        network,
        status: 'provider-credentials-missing',
        sponsorAddress,
        requiredEnvironment: ['TATUM_API_KEY'],
        onChainBalanceRead: false,
        sponsorFundingVerified: false,
        canSubmitSponsoredTransfer: false,
        submissionEnabled: false,
      }
    }
    if (typeof fetchImpl !== 'function') {
      return {
        configured: true,
        network,
        status: 'provider-unavailable',
        sponsorAddress,
        onChainBalanceRead: false,
        sponsorFundingVerified: false,
        canSubmitSponsoredTransfer: false,
        submissionEnabled: false,
      }
    }

    try {
      const tronWeb = await tronWebFactory(config.host)
      if (typeof tronWeb?.isAddress !== 'function'
        || !tronWeb.isAddress(sponsorAddress)
        || typeof tronWeb?.address?.toHex !== 'function') {
        return {
          configured: false, network, status: 'invalid-sponsor-address',
          requiredEnvironment: [config.addressEnv], onChainBalanceRead: false,
          sponsorFundingVerified: false, canSubmitSponsoredTransfer: false, submissionEnabled: false,
        }
      }
      const headers = {
        'content-type': 'application/json',
        'x-api-key': env.TATUM_API_KEY.trim(),
      }
      const accountResponse = await fetchImpl(config.host + '/walletsolidity/getaccount', {
        method: 'POST',
        headers,
        body: JSON.stringify({ address: tronWeb.address.toHex(sponsorAddress), visible: false }),
        signal: AbortSignal.timeout(8000),
      })
      if (!accountResponse.ok) throw new Error('native-balance-unavailable')
      const account = await accountResponse.json()
      let balanceSun
      if (!account || typeof account !== 'object' || Array.isArray(account)) throw new Error('invalid-native-balance-response')
      const expectedAccountHex = tronWeb.address.toHex(sponsorAddress).replace(/^0x/i, '').toLowerCase()
      const accountExists = typeof account.address === 'string' && account.address.length > 0
      if (account.address !== undefined && !accountExists) throw new Error('invalid-native-balance-response')
      if (accountExists && account.address.replace(/^0x/i, '').toLowerCase() !== expectedAccountHex) {
        throw new Error('sponsor-account-identity-mismatch')
      }
      if (!accountExists && account.balance !== undefined) throw new Error('invalid-native-balance-response')
      if (!accountExists) {
        // SolidityNode returns an empty object for an address without an account.
        balanceSun = '0'
      } else {
        balanceSun = String(account.balance ?? '')
        if (!/^(0|[1-9][0-9]{0,77})$/.test(balanceSun)) throw new Error('invalid-native-balance-response')
      }

      const tokenConfig = readTokenAllowlist(env, network)
      if (!tokenConfig.valid) {
        return {
          configured: true, network, status: tokenConfig.reason, sponsorAddress,
          onChainBalanceRead: true,
          native: { status: 'verified', asset: 'TRX', balanceSun, balanceTRX: formatSun(balanceSun), accountExists: accountExists },
          tokens: [],
          tokenBalancesComplete: false,
          tokenBalanceScope: tokenConfig.reason,
          sponsorFundingVerified: false,
          sponsorAgreementVerified: false,
          canSubmitSponsoredTransfer: false,
          submissionEnabled: false,
        }
      }

      const tokenResults = await Promise.all(tokenConfig.tokens.map(async ({ asset, contract }) => {
        const displayAsset = asset === 'USDT' && network !== 'mainnet' ? 'USDT (testnet)' : asset
        try {
          if (!tronWeb.isAddress(contract)) return { asset, tokenContract: contract, status: 'invalid-token-contract' }
          const contractHex = tronWeb.address.toHex(contract).replace(/^41/i, '')
          const addressHex = tronWeb.address.toHex(sponsorAddress).replace(/^41/i, '')
          const ownerHex = tronWeb.address.toHex(sponsorAddress)
          const readConstant = async (selector, parameter = '') => {
            const response = await fetchImpl(config.host + '/walletsolidity/triggerconstantcontract', {
              method: 'POST',
              headers,
              body: JSON.stringify({
                owner_address: ownerHex,
                contract_address: '41' + contractHex,
                function_selector: selector,
                parameter,
                visible: false,
              }),
              signal: AbortSignal.timeout(8000),
            })
            if (!response.ok) throw new Error('token-balance-unavailable')
            const payload = await response.json()
            if (payload?.Error || payload?.result?.result === false
              || !Array.isArray(payload?.constant_result)
              || typeof payload.constant_result[0] !== 'string'
              || !/^[0-9a-f]{64}$/i.test(payload.constant_result[0])) {
              throw new Error('token-balance-unavailable')
            }
            return payload.constant_result[0]
          }
          const [balanceHex, decimalsHex] = await Promise.all([
            readConstant('balanceOf(address)', addressHex.padStart(64, '0')),
            readConstant('decimals()'),
          ])
          const decimals = Number(BigInt('0x' + decimalsHex))
          if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('invalid-token-decimals')
          if (asset === 'USDT' && network === 'mainnet' && decimals !== 6) {
            throw new Error('official-mainnet-usdt-decimals-mismatch')
          }
          return {
            asset: displayAsset,
            tokenContract: contract,
            status: 'verified',
            balanceBaseUnits: BigInt('0x' + balanceHex).toString(),
            decimals,
          }
        } catch {
          return { asset: displayAsset, tokenContract: contract, status: 'unavailable' }
        }
      }))

      const tokenBalancesComplete = tokenResults.length > 0 && tokenResults.every((item) => item.status === 'verified')
      return {
        configured: true,
        network,
        status: 'solidified-sponsor-balances-read',
        source: 'Tatum TRON SolidityNode account and constant-contract queries',
        checkedAt: new Date().toISOString(),
        sponsorAddress,
        onChainBalanceRead: true,
        native: {
          status: 'verified',
          asset: 'TRX',
          balanceSun,
          balanceTRX: formatSun(balanceSun),
          accountExists: Boolean(account.address),
        },
        tokens: tokenResults,
        tokenBalancesComplete,
        tokenBalanceScope: tokenConfig.tokens.length ? 'configured-contracts-only' : 'no-token-contracts-configured',
        // An on-chain snapshot is not proof of sponsor consent, spend authority,
        // a separate accounting budget, or eligibility for the intended transfer.
        sponsorFundingVerified: false,
        sponsorAgreementVerified: false,
        canSubmitSponsoredTransfer: false,
        submissionEnabled: false,
        unpaidFallbackToUserFunds: false,
        note: 'Read-only solidified balance snapshot only. It does not verify sponsor consent, signing authority, budget reservation, fee coverage, or transfer eligibility.',
      }
    } catch {
      // Do not return provider bodies, auth headers, or API credentials.
      return {
        configured: true,
        network,
        status: 'solidified-balance-read-failed',
        sponsorAddress,
        onChainBalanceRead: false,
        sponsorFundingVerified: false,
        canSubmitSponsoredTransfer: false,
        submissionEnabled: false,
        unpaidFallbackToUserFunds: false,
      }
    }
  }

  // Short-lived per-network snapshots avoid multiplying provider calls on page
  // refreshes. Requests in flight for the same network share the same promise.
  // Only successful solidified account reads are cached; errors remain retryable.
  return async function readSponsorFundingStatus(network, { refresh = false } = {}) {
    if (typeof network !== 'string' || !Object.hasOwn(NETWORKS, network)) {
      return readFreshSponsorFundingStatus(network)
    }
    const now = Date.now()
    const cached = cache.get(network)
    const lastForcedAt = forcedRefreshAt.get(network) || 0
    const forceRefreshThrottled = refresh && lastForcedAt > 0 && now - lastForcedAt < cacheTtlMs
    if (forceRefreshThrottled && (!cached || cached.expiresAt <= now)) {
      const pendingRead = inFlight.get(network)
      if (pendingRead) {
        const pendingResult = await pendingRead
        return { ...pendingResult, cache: { status: 'refresh-throttled', ageMs: 0, refreshThrottled: true } }
      }
      return {
        configured: true,
        network,
        status: 'refresh-rate-limited',
        onChainBalanceRead: false,
        sponsorFundingVerified: false,
        canSubmitSponsoredTransfer: false,
        submissionEnabled: false,
        refreshThrottled: true,
        retryAfterMs: Math.max(0, cacheTtlMs - (now - lastForcedAt)),
      }
    }
    if (cached && cached.expiresAt > now && (!refresh || forceRefreshThrottled)) {
      return {
        ...cached.result,
        cache: {
          status: forceRefreshThrottled ? 'refresh-throttled' : 'cached',
          ageMs: Math.max(0, now - cached.checkedAt),
          ...(forceRefreshThrottled ? { refreshThrottled: true } : {}),
        },
      }
    }
    if (refresh) forcedRefreshAt.set(network, now)

    let pending = inFlight.get(network)
    if (!pending) {
      pending = readFreshSponsorFundingStatus(network)
      inFlight.set(network, pending)
    }
    try {
      const result = await pending
      const checkedAt = Date.now()
      const cacheTtl = result?.onChainBalanceRead === true ? cacheTtlMs
        : result?.configured === true ? failureCacheTtlMs : 0
      if (cacheTtl > 0) {
        cache.set(network, { result, checkedAt, expiresAt: checkedAt + cacheTtl })
      }
      return { ...result, cache: { status: 'fresh', ageMs: 0 } }
    } finally {
      if (inFlight.get(network) === pending) inFlight.delete(network)
    }
  }
}
