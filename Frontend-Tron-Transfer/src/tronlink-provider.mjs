const DEFAULT_DISCOVERY_TIMEOUT_MS = 1500
const DEFAULT_PROVIDER_READY_TIMEOUT_MS = 7000
const DEFAULT_POLL_INTERVAL_MS = 100

function hasTronSigner(provider) {
  const tronWeb = provider?.tronWeb || provider?.tronLink?.tronWeb || provider?.wallet?.tronWeb
  return Boolean(tronWeb?.trx && typeof tronWeb.trx.sign === 'function'
    && typeof tronWeb.isAddress === 'function')
}

function isTronAnnouncement(info, provider) {
  const name = typeof info?.name === 'string' ? info.name.toLowerCase() : ''
  const rdns = typeof info?.rdns === 'string' ? info.rdns.toLowerCase() : ''
  return name.includes('tron') || rdns.includes('tron') || hasTronSigner(provider)
}

export function isTronWalletProvider(provider) {
  return Boolean(provider && typeof provider.request === 'function' && hasTronSigner(provider))
}

function isPendingTronProvider(provider) {
  return Boolean(provider && typeof provider.request === 'function'
    && (provider.isTronLink === true || provider.tronLink?.isTronLink === true))
}

// Backwards-compatible detection also accepts official TronLink providers
// whose TronWeb signer is initialized only after account authorization.
export const isTronLinkProvider = provider => isTronWalletProvider(provider) || isPendingTronProvider(provider)

function getInjectedProviders(windowObject) {
  const candidates = [
    windowObject?.tron,
    windowObject?.tronLink,
    windowObject?.okxwallet?.tronLink,
    windowObject?.okxwallet,
    windowObject?.bitkeep?.tronLink,
    windowObject?.bitkeep,
    windowObject?.tokenpocket?.tronLink,
    windowObject?.tokenpocket,
    windowObject?.trustwallet?.tronLink,
    windowObject?.trustwallet,
  ]
  const unique = [...new Set(candidates.filter(provider => isTronWalletProvider(provider) || isPendingTronProvider(provider)))]
  if (unique.length === 0 && windowObject?.tronWeb?.trx
    && typeof windowObject.tronWeb.trx.sign === 'function') {
    const requestProvider = [windowObject?.tron, windowObject?.tronLink,
      windowObject?.okxwallet, windowObject?.bitkeep, windowObject?.tokenpocket]
      .find(candidate => candidate && typeof candidate.request === 'function')
    if (requestProvider) unique.push(Object.assign(Object.create(requestProvider), { tronWeb: windowObject.tronWeb }))
  }
  return unique
}

/** Discover injected TRON wallets via TIP-6963 and common DApp-browser globals. */
export async function discoverTronLinkProvider(
  windowObject = globalThis.window,
  { timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS } = {},
) {
  if (!windowObject) return null
  const existing = getInjectedProviders(windowObject)
  if (existing.length) return existing[0]
  if (typeof windowObject.addEventListener !== 'function'
    || typeof windowObject.removeEventListener !== 'function'
    || typeof windowObject.dispatchEvent !== 'function') return null

  return new Promise(resolve => {
    let settled = false
    const announced = []
    const finish = provider => {
      if (settled) return
      settled = true
      windowObject.removeEventListener('TIP6963:announceProvider', onAnnouncement)
      clearTimeout(timer)
      resolve(provider || getInjectedProviders(windowObject)[0] || null)
    }
    const onAnnouncement = event => {
      const detail = event?.detail || {}
      if (isTronAnnouncement(detail.info, detail.provider)
        && (isTronWalletProvider(detail.provider) || isPendingTronProvider(detail.provider))) {
        announced.push(detail.provider)
        finish(announced[0])
      }
    }
    windowObject.addEventListener('TIP6963:announceProvider', onAnnouncement)
    const timer = setTimeout(() => finish(announced[0] || null), timeoutMs)
    try {
      const EventConstructor = windowObject.Event || globalThis.Event
      if (typeof EventConstructor !== 'function') return finish(null)
      windowObject.dispatchEvent(new EventConstructor('TIP6963:requestProvider'))
    } catch { finish(null) }
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
  if (code === 4001) return new Error('Wallet connection was rejected. Approve the connection request in your TRON wallet and try again.')
  if (code === -32000) return new Error('The TRON wallet is locked or rate-limited. Unlock it, wait briefly, then retry once.')
  if (code === 4000) return new Error('A wallet connection request is already pending. Finish or close it before retrying.')
  return error instanceof Error ? error : new Error(String(error || 'TRON wallet authorization failed.'))
}

async function requestAccounts(provider) {
  let lastUnsupported
  for (const method of ['tron_requestAccounts', 'eth_requestAccounts']) {
    try {
      const result = await provider.request({ method })
      if (result && typeof result === 'object' && !Array.isArray(result) && result.code) {
        const code = Number(result.code)
        if (code === 4001 || code === 4000) throw authorizationError({ code })
      }
      const values = Array.isArray(result) ? result
        : typeof result === 'string' && result ? [result]
          : Array.isArray(result?.accounts) ? result.accounts : []
      const accounts = values.filter(value => typeof value === 'string' && value)
      if (accounts.length || hasTronSigner(provider)) return accounts
      throw new Error('The wallet did not return a TRON account address.')
    } catch (error) {
      if (!unsupportedMethod(error)) throw authorizationError(error)
      lastUnsupported = error
    }
  }
  throw authorizationError(lastUnsupported || new Error('No supported TRON account authorization method was found.'))
}

/** Authorize the selected account and wait for a usable signer; never signs or broadcasts. */
export async function requestTronLinkConnection(
  provider,
  windowObject = globalThis.window,
  { readyTimeoutMs = DEFAULT_PROVIDER_READY_TIMEOUT_MS, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS } = {},
) {
  // A wallet may expose its signer only after the account-authorization request.
  // Require a request-capable provider here; discovery still filters candidates
  // to known TRON providers, and the ready signer is validated below.
  if (!provider || typeof provider.request !== 'function') throw new Error('A compatible injected TRON wallet provider was not found.')
  const accounts = await requestAccounts(provider)
  const deadline = Date.now() + readyTimeoutMs
  while (Date.now() <= deadline) {
    const candidate = provider.tronWeb || provider.tronLink?.tronWeb
      || provider.wallet?.tronWeb || windowObject?.tronWeb
    const address = String(candidate?.defaultAddress?.base58 || accounts[0] || '')
    const ready = candidate && candidate.ready !== false && candidate.trx
      && typeof candidate.trx.sign === 'function' && typeof candidate.isAddress === 'function'
    if (ready && address && candidate.isAddress(address)) {
      return { address, tronWeb: candidate, provider, accounts }
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }
  throw new Error('The TRON wallet authorized access but did not expose a ready account signer. Reopen its DApp browser, unlock it, select an account, and reconnect.')
}
