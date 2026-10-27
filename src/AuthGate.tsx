import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Activity, Layers, LockKeyhole, RefreshCw, ShieldCheck, Wallet } from 'lucide-react'

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
        const provider = (window as any).tron
        if (!provider || provider.isTronLink !== true || !provider.tronWeb) throw new Error('TronLink is not available to restore this session.')
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
        assertSelectedNetwork(provider.tronWeb, network)
        if (String(provider.tronWeb?.defaultAddress?.base58 || '') !== payload.address) {
          throw new Error('The selected TronLink address differs from the signed-in account. Sign in again.')
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
    window.addEventListener('tron-token-studio:logout', onLogout)
    return () => window.removeEventListener('tron-token-studio:logout', onLogout)
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
      const provider = (window as any).tron
      if (!provider || provider.isTronLink !== true || !provider.tronWeb || typeof provider.request !== 'function') {
        throw new Error('TronLink was not detected. Open this website in a compatible TronLink browser or install/enable the wallet extension.')
      }
      try {
        await provider.request({ method: 'tron_requestAccounts' })
      } catch (caught) {
        const code = Number((caught as any)?.code)
        const message = caught instanceof Error ? caught.message : ''
        if (code === -32601 || /method not found|unsupported method/i.test(message)) {
          await provider.request({ method: 'eth_requestAccounts' })
        } else {
          throw caught
        }
      }
      const tronWeb = provider.tronWeb
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
      assertSelectedNetwork(provider.tronWeb, network)
      if (String(provider.tronWeb?.defaultAddress?.base58 || '') !== address) {
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
      setError(caught instanceof Error ? caught.message : 'Wallet sign-in failed.')
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

  if (session && session.network === network && session.expiresAt > Date.now()) {
    const operatorRoute = window.location.hash === '#/sponsor-operator'
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
      </section>
    </div>
  )
}
