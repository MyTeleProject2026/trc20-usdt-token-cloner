const DEFAULT_DISCOVERY_TIMEOUT_MS = 1200
const DEFAULT_PROVIDER_READY_TIMEOUT_MS = 5000
const DEFAULT_POLL_INTERVAL_MS = 100

function isTronLinkAnnouncement(info, provider) {
  const name = typeof info?.name === 'string' ? info.name.toLowerCase() : ''
  const rdns = typeof info?.rdns === 'string' ? info.rdns.toLowerCase() : ''
  return name === 'tronlink' || rdns.includes('tronlink') || provider?.isTronLink === true
}

export function isTronLinkProvider(provider) {
  return Boolean(provider && typeof provider.request === 'function'
    && (provider.isTronLink === true || provider.tronWeb !== undefined))
}

function getGlobalProvider(windowObject) {
  const candidates = [windowObject?.tron, windowObject?.tronLink]
  return candidates.find(isTronLinkProvider) || null
}

/**
 * Discover TronLink using TIP-6963 first, with the injected globals retained
 * as a compatibility fallback for older DApp browser versions.
 */
export async function discoverTronLinkProvider(
  windowObject = globalThis.window,
  { timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS } = {},
) {
  if (!windowObject) return null
  const existing = getGlobalProvider(windowObject)
  if (existing) return existing
  if (typeof windowObject.addEventListener !== 'function'
    || typeof windowObject.removeEventListener !== 'function'
    || typeof windowObject.dispatchEvent !== 'function') return null

  return new Promise((resolve) => {
    let settled = false
    const finish = (provider) => {
      if (settled) return
      settled = true
      windowObject.removeEventListener('TIP6963:announceProvider', onAnnouncement)
      clearTimeout(timer)
      resolve(isTronLinkProvider(provider) ? provider : getGlobalProvider(windowObject))
    }
    const onAnnouncement = (event) => {
      const detail = event?.detail || {}
      if (isTronLinkAnnouncement(detail.info, detail.provider)) finish(detail.provider)
    }
    windowObject.addEventListener('TIP6963:announceProvider', onAnnouncement)
    const timer = setTimeout(() => finish(getGlobalProvider(windowObject)), timeoutMs)

    try {
      const EventConstructor = windowObject.Event || globalThis.Event
      if (typeof EventConstructor !== 'function') {
        finish(getGlobalProvider(windowObject))
        return
      }
      windowObject.dispatchEvent(new EventConstructor('TIP6963:requestProvider'))
    } catch {
      finish(getGlobalProvider(windowObject))
    }
  })
}

function unsupportedMethod(error) {
  const code = Number(error?.code)
  const message = String(error?.message || error || '')
  return code === -32601 || code === 4200
    || /method not found|unsupported method|method not supported/i.test(message)
}

function authorizationError(error) {
  const code = Number(error?.code)
  if (code === 4001) return new Error('TronLink connection was rejected. Approve the connection request in the TronLink window and try again.')
  if (code === -32000) return new Error('TronLink is locked or rate-limited this connection request. Unlock the wallet, wait at least 20 seconds, then retry once.')
  if (code === 4000) return new Error('A TronLink connection request is already pending. Finish or close that request before retrying.')
  return error instanceof Error ? error : new Error(String(error || 'TronLink authorization failed.'))
}

/**
 * Ask the wallet to authorize this origin once, then wait for its TronWeb
 * signer/account binding to become available. This function never signs or
 * broadcasts a blockchain transaction.
 */
export async function requestTronLinkConnection(
  provider,
  windowObject = globalThis.window,
  {
    readyTimeoutMs = DEFAULT_PROVIDER_READY_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  } = {},
) {
  if (!isTronLinkProvider(provider)) throw new Error('A valid TronLink provider was not found.')

  let accountResult
  try {
    accountResult = await provider.request({ method: 'eth_requestAccounts' })
  } catch (error) {
    if (!unsupportedMethod(error)) throw authorizationError(error)
    try {
      accountResult = await provider.request({ method: 'tron_requestAccounts' })
    } catch (legacyError) {
      throw authorizationError(legacyError)
    }
  }

  if (accountResult && typeof accountResult === 'object' && !Array.isArray(accountResult)) {
    const code = Number(accountResult.code)
    if (code === 4001) throw authorizationError({ code })
    if (code === 4000) throw authorizationError({ code })
  }

  const accounts = Array.isArray(accountResult)
    ? accountResult.filter((value) => typeof value === 'string')
    : typeof accountResult === 'string' && accountResult
      ? [accountResult]
      : []
  const deadline = Date.now() + readyTimeoutMs

  while (Date.now() <= deadline) {
    const candidate = provider.tronWeb && provider.tronWeb !== false
      ? provider.tronWeb
      : windowObject?.tronWeb
    const address = String(candidate?.defaultAddress?.base58
      || accounts[0]
      || '')
    const signerReady = candidate && candidate.ready !== false
      && candidate.trx && typeof candidate.trx.sign === 'function'
    if (signerReady && address) return { address, tronWeb: candidate, provider, accounts }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }

  const latest = provider.tronWeb && provider.tronWeb !== false
    ? provider.tronWeb
    : windowObject?.tronWeb
  const account = String(latest?.defaultAddress?.base58 || accounts[0] || '')
  if (!account) {
    throw new Error('TronLink authorization did not expose a selected account. Unlock TronLink, select the owner account, and retry from its DApp browser.')
  }
  throw new Error('TronLink exposed the account but its transaction signer is not ready yet. Keep TronLink unlocked, wait a few seconds, then reconnect.')
}
