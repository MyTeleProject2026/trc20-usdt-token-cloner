const TRON_MAINNET_HOST = 'api.trongrid.io'
const TRONLINK_RDNS = 'org.tronlink.www'
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/

function isTronLinkProvider(provider) {
  return Boolean(provider && provider.isTronLink === true && typeof provider.request === 'function')
}

function injectedProvider(windowRef) {
  const candidates = [windowRef?.tron, windowRef?.tronLink]
  return candidates.find(isTronLinkProvider) || null
}

/**
 * Prefer TIP-6963 discovery and retain a guarded compatibility fallback for
 * TronLink versions that only expose window.tron / window.tronLink.
 */
export function discoverTronLink(windowRef = globalThis.window, timeoutMs = 700) {
  if (!windowRef) return Promise.resolve(null)

  const fallback = injectedProvider(windowRef)
  if (typeof windowRef.addEventListener !== 'function'
    || typeof windowRef.dispatchEvent !== 'function') {
    return Promise.resolve(fallback)
  }

  return new Promise((resolve) => {
    let announced = null
    let settled = false
    let timer = null
    const finish = (provider) => {
      if (settled) return
      settled = true
      windowRef.removeEventListener?.('TIP6963:announceProvider', onAnnounce)
      if (timer !== null) clearTimeout(timer)
      resolve(provider || fallback)
    }
    const onAnnounce = (event) => {
      const info = event?.detail?.info
      const candidate = event?.detail?.provider
      if ((info?.rdns === TRONLINK_RDNS || info?.name === 'TronLink') && isTronLinkProvider(candidate)) {
        announced = candidate
        finish(announced)
      }
    }

    windowRef.addEventListener('TIP6963:announceProvider', onAnnounce)
    const EventConstructor = windowRef.Event || globalThis.Event
    if (typeof EventConstructor === 'function') {
      windowRef.dispatchEvent(new EventConstructor('TIP6963:requestProvider'))
    }
    if (!settled) timer = setTimeout(() => finish(announced), Math.max(0, timeoutMs))
    if (fallback) finish(fallback)
  })
}

/** Request account access using the current method; only fall back when unsupported. */
export async function requestTronLinkAccounts(provider) {
  if (!isTronLinkProvider(provider)) throw new Error('TronLink is not available in this browser context.')

  try {
    return await provider.request({ method: 'eth_requestAccounts' })
  } catch (error) {
    const code = Number(error?.code)
    const message = String(error?.message || error || '')
    if (code === -32601 || code === 4200 || /method not found|unsupported method|method not supported/i.test(message)) {
      return provider.request({ method: 'tron_requestAccounts' })
    }
    throw error
  }
}

/** Enforce an HTTPS TronGrid Mainnet connection before using this wallet. */
export function readTronLinkMainnetContext(provider) {
  if (!isTronLinkProvider(provider)) throw new Error('TronLink is not connected. Connect your wallet first.')

  const tronWeb = provider.tronWeb && typeof provider.tronWeb === 'object'
    ? provider.tronWeb
    : null
  if (!tronWeb) throw new Error('TronLink did not expose an authorized TronWeb session. Unlock the wallet and reconnect.')

  const address = String(tronWeb.defaultAddress?.base58 || '').trim()
  if (!ADDRESS_PATTERN.test(address)) throw new Error('TronLink has not exposed a valid active TRON account.')

  const node = String(tronWeb.fullNode?.host || tronWeb.fullNode?.nodeUrl || '')
  let parsed
  try { parsed = new URL(node) } catch {
    throw new Error('Cannot verify the wallet network. Select TRON Mainnet in TronLink and reconnect.')
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== TRON_MAINNET_HOST
    || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash
    || (parsed.pathname !== '' && parsed.pathname !== '/')) {
    throw new Error('Network mismatch. Tron Transfer requires TRON Mainnet through https://api.trongrid.io.')
  }

  if (typeof tronWeb.trx?.signMessageV2 !== 'function') {
    throw new Error('This TronLink session cannot sign wallet identity messages. Update TronLink and reconnect.')
  }

  return {
    provider,
    tronWeb,
    address,
    network: 'mainnet',
    nodeUrl: parsed.origin,
  }
}

/** Connect, request account authorization, and return a verified Mainnet context. */
export async function connectTronLinkMainnet({ windowRef = globalThis.window, timeoutMs = 700 } = {}) {
  const provider = await discoverTronLink(windowRef, timeoutMs)
  if (!provider) {
    throw new Error('TronLink was not detected. Open Tron Transfer in the TronLink DApp browser or install TronLink.')
  }

  const response = await requestTronLinkAccounts(provider)
  const context = readTronLinkMainnetContext(provider)
  if (Array.isArray(response) && response.length > 0 && !response.includes(context.address)) {
    throw new Error('The account returned by TronLink does not match its active TronWeb account. Reconnect and retry.')
  }
  if (typeof response === 'string' && response && response !== context.address) {
    throw new Error('The account returned by TronLink does not match its active TronWeb account. Reconnect and retry.')
  }
  return context
}

/** Subscribe to wallet changes so stale account and balance state can be cleared. */
export function subscribeTronLink(provider, { onAccountsChanged, onChainChanged, onDisconnect } = {}) {
  if (!provider || typeof provider.on !== 'function') return () => {}
  const listeners = [
    ['accountsChanged', onAccountsChanged],
    ['chainChanged', onChainChanged],
    ['disconnect', onDisconnect],
  ].filter(([, listener]) => typeof listener === 'function')

  for (const [event, listener] of listeners) provider.on(event, listener)
  return () => {
    for (const [event, listener] of listeners) {
      if (typeof provider.removeListener === 'function') provider.removeListener(event, listener)
      else if (typeof provider.off === 'function') provider.off(event, listener)
    }
  }
}
