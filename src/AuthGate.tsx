import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Activity, ExternalLink, Eye, Layers, LockKeyhole, RefreshCw, ShieldCheck, Wallet } from 'lucide-react'

type NetworkId = 'nile' | 'shasta'
type WalletSession = { address: string; network: NetworkId; expiresAt: number; sessionToken: string }

const API_BASE = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? '' : 'https://trc20-usdt-token-cloner-api.onrender.com')).replace(/\/+$/, '')
const SESSION_KEY = 'tron-token-studio:auth-session:v1'
const NETWORK_KEY = 'tron-token-studio:auth-network:v1'
const HOSTS: Record<NetworkId, string> = {
  nile: 'nile.trongrid.io',
  shasta: 'api.shasta.trongrid.io',
}
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/

function savedNetwork(): NetworkId {
  try { return window.sessionStorage.getItem(NETWORK_KEY) === 'shasta' ? 'shasta' : 'nile' } catch { return 'nile' }
}

function getTronProvider(): any {
  const candidates = [(window as any).tron, (window as any).tronLink]
  return candidates.find(provider => provider && provider.isTronLink === true
    && typeof provider.request === 'function') || null
}

async function requestTronAccounts(provider: any): Promise<unknown> {
  try {
    return await provider.request({ method: 'eth_requestAccounts' })
  } catch (caught) {
    const code = Number((caught as any)?.code)
    const rawMessage = typeof caught === 'string' ? caught : String((caught as any)?.message || '')
    if (code === -32601 || code === 4200 || /method not found|unsupported method|method not supported/i.test(rawMessage)) {
      return provider.request({ method: 'tron_requestAccounts' })
    }
    throw caught
  }
}

function walletErrorMessage(caught: unknown): string {
  const code = Number((caught as any)?.code)
  const raw = (typeof caught === 'string' ? caught : String((caught as any)?.message || '')).trim()
  if (code === 4001 || /confirmation declined by user|user rejected the request|request rejected/i.test(raw)) {
    return 'The wallet request was declined. Retry and approve the connection or the clearly labelled sign-in message in TronLink.'
  }
  if (code === -32002 || /already pending|request is already pending|already processing a request/i.test(raw)) {
    return 'A TronLink request is already open. Finish or close that wallet prompt before trying again.'
  }
  if (/user has not unlocked wallet|wallet is locked|wallet not unlocked/i.test(raw)) {
    return 'Unlock TronLink, select the intended account and testnet, then retry sign-in.'
  }
  if (/invalid transaction provided|transaction integrity check failed/i.test(raw)) {
    return 'TronLink could not sign the login message. Update/unlock TronLink and retry; no transfer was submitted.'
  }
  return raw.slice(0, 240) || 'Wallet sign-in failed. Confirm TronLink is available and try again.'
}

function assertSelectedNetwork(tronWeb: any, network: NetworkId) {
  const host = String(tronWeb?.fullNode?.host || tronWeb?.fullNode?.nodeUrl || '')
  let parsed: URL
  try { parsed = new URL(host) } catch { throw new Error('TronLink network could not be verified. Select the requested testnet and reconnect.') }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== HOSTS[network]
    || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash
    || (parsed.pathname !== '' && parsed.pathname !== '/')) {
    throw new Error('Network mismatch. Select ' + (network === 'nile' ? 'Nile' : 'Shasta') + ' in TronLink and try again.')
  }
}

export default function AuthGate({ children }: { children: ReactNode }) {
  const [network, setNetwork] = useState<NetworkId>(savedNetwork)
  const [session, setSession] = useState<WalletSession | null>(null)
  const [checking, setChecking] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [readOnlyMode, setReadOnlyMode] = useState(false)
  const operatorRoute = window.location.hash === '#/sponsor-operator'

  function clearStoredSession() {
    try {
      const token = window.sessionStorage.getItem(SESSION_KEY)
      window.sessionStorage.removeItem(SESSION_KEY)
      window.sessionStorage.removeItem(NETWORK_KEY)
      if (token) {
        void fetch(API_BASE + '/api/auth/tron/logout', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token },
          credentials: 'omit',
          cache: 'no-store',
        }).catch(() => undefined)
      }
    } catch {
      // Continue clearing the in-memory identity if browser storage is unavailable.
    }
  }

  useEffect(() => {
    let cancelled = false
    const restore = async () => {
      try {
        const token = window.sessionStorage.getItem(SESSION_KEY)
        if (!token) return
        // The app identity is the server-verified signature session, not whichever
        // account happens to be active in the wallet today. This allows operators
        // to switch between their distinct fee/principal wallets without losing
        // the app session; signing actions re-verify the active account separately.
        const response = await fetch(API_BASE + '/api/auth/tron/session', {
          headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
          credentials: 'omit',
          cache: 'no-store',
        })
        const payload = await response.json().catch(() => null)
        if (!response.ok || payload?.success !== true || payload?.authenticated !== true
          || !ADDRESS_PATTERN.test(String(payload.address || ''))
          || !['nile', 'shasta'].includes(payload.network)
          || payload.network !== network || !Number.isFinite(payload.expiresAt)
          || payload.expiresAt <= Date.now()) {
          throw new Error('The saved wallet session is invalid or expired. Sign in again.')
        }
        if (cancelled) return
        setSession({ address: payload.address, network: payload.network, expiresAt: payload.expiresAt, sessionToken: token })
        setError('')
      } catch {
        clearStoredSession()
      } finally {
        if (!cancelled) setChecking(false)
      }
    }
    void restore()
    return () => { cancelled = true }
  }, [network])

  useEffect(() => {
    const onLogout = () => {
      clearStoredSession()
      setSession(null)
      setChecking(false)
      setError('Signed out. Connect and verify a wallet to continue.')
    }
    const onNetworkChange = (event: Event) => {
      const requested = (event as CustomEvent<unknown>).detail
      if (requested !== 'nile' && requested !== 'shasta') return
      setSession(null)
      setChecking(false)
      setError('Network changed. Connect and sign in again on the selected testnet.')
      setNetwork(requested)
    }
    const onWalletAuthenticated = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail as Partial<WalletSession> | null
      if (!detail || typeof detail.address !== 'string' || !ADDRESS_PATTERN.test(detail.address)
        || (detail.network !== 'nile' && detail.network !== 'shasta')
        || typeof detail.sessionToken !== 'string' || !Number.isFinite(detail.expiresAt)
        || (detail.expiresAt as number) <= Date.now()) return
      setSession({
        address: detail.address,
        network: detail.network,
        sessionToken: detail.sessionToken,
        expiresAt: detail.expiresAt as number,
      })
      setNetwork(detail.network)
      setReadOnlyMode(false)
      setChecking(false)
      setError('')
    }
    window.addEventListener('tron-token-studio:logout', onLogout)
    window.addEventListener('tron-token-studio:network-change', onNetworkChange)
    window.addEventListener('tron-token-studio:wallet-authenticated', onWalletAuthenticated)
    return () => {
      window.removeEventListener('tron-token-studio:logout', onLogout)
      window.removeEventListener('tron-token-studio:network-change', onNetworkChange)
      window.removeEventListener('tron-token-studio:wallet-authenticated', onWalletAuthenticated)
    }
  }, [])

  useEffect(() => {
    if (!session) return
    const timeout = window.setTimeout(() => {
      clearStoredSession()
      setSession(null)
      setError('Wallet login expired. Sign in again to continue.')
    }, Math.max(0, session.expiresAt - Date.now()))
    return () => window.clearTimeout(timeout)
  }, [session])

  const signIn = async () => {
    setBusy(true)
    setError('')
    try {
      const provider = getTronProvider()
      if (!provider) {
        throw new Error('TronLink was not detected. Open this website in a browser where the TronLink extension or wallet browser is enabled.')
      }
      await requestTronAccounts(provider)
      const tronWeb = provider.tronWeb || (window as any).tronWeb
      if (!tronWeb || typeof tronWeb !== 'object') {
        throw new Error('TronLink approved the connection but did not expose TronWeb yet. Unlock the wallet, close any pending wallet prompt, and click Connect again.')
      }
      assertSelectedNetwork(tronWeb, network)
      const address = String(tronWeb?.defaultAddress?.base58 || '')
      if (!ADDRESS_PATTERN.test(address) || (typeof tronWeb.isAddress === 'function' && !tronWeb.isAddress(address))) {
        throw new Error('TronLink did not provide a valid authorized TRON address.')
      }
      const challengeResponse = await fetch(API_BASE + '/api/auth/tron/challenge', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, network }),
        credentials: 'omit',
        cache: 'no-store',
      })
      const challenge = await challengeResponse.json().catch(() => null)
      if (!challengeResponse.ok || challenge?.success !== true || typeof challenge.message !== 'string' || typeof challenge.nonce !== 'string') {
        throw new Error(challenge?.message || challenge?.error || 'Wallet sign-in challenge failed (HTTP ' + challengeResponse.status + ').')
      }
      if (typeof tronWeb?.trx?.signMessageV2 !== 'function') throw new Error('This TronLink version does not support signMessageV2.')
      const signature = await tronWeb.trx.signMessageV2(challenge.message)
      if (typeof signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(signature)) throw new Error('TronLink returned an invalid login signature.')
      const currentTronWeb = provider.tronWeb || (window as any).tronWeb
      assertSelectedNetwork(currentTronWeb, network)
      if (String(currentTronWeb?.defaultAddress?.base58 || '') !== address) {
        throw new Error('The active TronLink address changed during sign-in. Retry with the intended account.')
      }
      const verifyResponse = await fetch(API_BASE + '/api/auth/tron/verify', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, network, nonce: challenge.nonce, signature }),
        credentials: 'omit',
        cache: 'no-store',
      })
      const verified = await verifyResponse.json().catch(() => null)
      if (!verifyResponse.ok || verified?.success !== true || verified?.authenticated !== true
        || verified.address !== address || verified.network !== network
        || typeof verified.sessionToken !== 'string' || !Number.isFinite(verified.expiresAt)) {
        throw new Error(verified?.message || verified?.error || 'Wallet signature verification failed (HTTP ' + verifyResponse.status + ').')
      }
      window.sessionStorage.setItem(SESSION_KEY, verified.sessionToken)
      window.sessionStorage.setItem(NETWORK_KEY, network)
      setSession({ address, network, expiresAt: verified.expiresAt, sessionToken: verified.sessionToken })
    } catch (caught) {
      setError(walletErrorMessage(caught))
    } finally {
      setBusy(false)
      setChecking(false)
    }
  }

  const selectNetwork = (next: NetworkId) => {
    if (next === network) return
    clearStoredSession()
    setSession(null)
    setError('')
    setNetwork(next)
  }

  const signOut = () => {
    clearStoredSession()
    setSession(null)
    setChecking(false)
    setError('Signed out. Connect and verify a wallet to continue.')
  }

  if (readOnlyMode && !operatorRoute) {
    return <>{children}</>
  }

  if (session && session.network === network && session.expiresAt > Date.now()) {
    return (
      <>
        {operatorRoute && (
          <div className="studio-auth-session-strip">
            <span><ShieldCheck size={14} aria-hidden="true" /> Session verified · {session.address.slice(0, 7)}…{session.address.slice(-5)} · {session.network}</span>
            <button type="button" onClick={signOut}>Sign out</button>
          </div>
        )}
        {children}
      </>
    )
  }

  return (
    <div className="studio-auth-screen">
      <section className="studio-auth-card" aria-labelledby="studio-auth-title">
        <div className="studio-auth-brand">
          <span className="studio-logo"><Layers size={22} aria-hidden="true" /></span>
          <span><strong>TRON Token Studio</strong><small>WALLET IDENTITY · TESTNET ONLY</small></span>
        </div>
        <p className="studio-eyebrow">SECURE SIGN-IN</p>
        <h1 id="studio-auth-title">Sign in to your workspace</h1>
        <p className="studio-auth-lead">Verify control of your TRON address with a one-time message signature in TronLink. The same login gate protects the transfer workspace and sponsor operator console.</p>
        <div className="studio-auth-network" role="group" aria-label="Choose testnet">
          <button type="button" aria-pressed={network === 'nile'} className={network === 'nile' ? 'is-selected' : ''} onClick={() => selectNetwork('nile')}>Nile testnet</button>
          <button type="button" aria-pressed={network === 'shasta'} className={network === 'shasta' ? 'is-selected' : ''} onClick={() => selectNetwork('shasta')}>Shasta testnet</button>
        </div>

        <div className="studio-auth-readonly" role="note">
          <p><strong>Try the platform without real USDT</strong></p>
          <p>Use test tokens on the selected {network === 'nile' ? 'Nile' : 'Shasta'} testnet. Testnet coins have no monetary value and cannot be deposited or transferred to a Mainnet exchange account. Keep TronLink on the same testnet selected here.</p>
          <p>
            <a href={network === 'nile' ? 'https://nileex.io/join/getJoinPage' : 'https://shasta.tronex.io/join/getJoinPage'} target="_blank" rel="noopener noreferrer">
              Open {network === 'nile' ? 'Nile' : 'Shasta'} testnet faucet <ExternalLink size={14} aria-hidden="true" />
            </a>
          </p>
          <p><a href="https://developers.tron.network/docs/getting-testnet-tokens-on-tron" target="_blank" rel="noopener noreferrer">TRON’s official test-token guide <ExternalLink size={14} aria-hidden="true" /></a></p>
        </div>
        {checking ? (
          <div className="studio-auth-loading" role="status"><RefreshCw className="studio-spin" size={18} aria-hidden="true" /> Checking saved wallet session…</div>
        ) : (
          <button type="button" className="studio-button studio-button--primary studio-auth-submit" onClick={() => void signIn()} disabled={busy}>
            <Wallet size={17} aria-hidden="true" /> {busy ? 'Waiting for TronLink…' : 'Connect TronLink & sign in'}
          </button>
        )}
        {error && <p className="studio-inline-error" role="alert">{error}</p>}
        <div className="studio-auth-points">
          <p><ShieldCheck size={16} aria-hidden="true" /><span><strong>Address ownership is verified.</strong> The backend checks a fresh signature and short-lived nonce.</span></p>
          <p><LockKeyhole size={16} aria-hidden="true" /><span><strong>No private keys or recovery phrases.</strong> The site never asks you to paste them.</span></p>
          <p><Activity size={16} aria-hidden="true" /><span><strong>Sign-in is not a transfer.</strong> It does not authorize sponsor spending or broadcast a transaction.</span></p>
        </div>
        <p className="studio-auth-footnote">A public address alone cannot authenticate an account. Sponsor wallets may still need to be selected individually for any wallet-signed action; account selection does not imply sponsor authority.</p>
        {!operatorRoute && (
          <div className="studio-auth-readonly">
            <p><strong>Using a regular browser without a connected wallet?</strong> Continue in watch-only mode to inspect a public TRON address and token contracts. This is not authenticated wallet login and cannot sign, broadcast, or access the sponsor operator console.</p>
            <button type="button" className="studio-button studio-button--secondary studio-auth-submit" onClick={() => { setReadOnlyMode(true); setError('') }}>
              <Eye size={16} aria-hidden="true" /> Continue in watch-only mode
            </button>
          </div>
        )}
      </section>
    </div>
  )
}
