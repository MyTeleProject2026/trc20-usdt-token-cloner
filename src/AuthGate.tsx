import { useEffect, useRef, useState } from 'react'
import type { ReactNode, FormEvent } from 'react'
import { Activity, AlertTriangle, CheckCircle2, Info, Layers, LockKeyhole, RefreshCw, ShieldCheck, LogOut, X } from 'lucide-react'

type OwnerSession = { address: string; expiresAt: number; sessionToken: string }
type OwnerConsoleConfig = {
  configured: boolean
  requiredEnvironment: string[]
  hostedUiOriginAllowed: boolean
  packagedUiOriginAllowed: boolean
}
type AuthToast = { id: number; kind: 'success' | 'error' | 'info'; message: string }

const API_BASE = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? '' : 'https://trc20-usdt-token-cloner-api.onrender.com')).replace(/\/+$/, '')
const SESSION_KEY = 'tron-token-studio:owner-session:v1'
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/

export default function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<OwnerSession | null>(null)
  const [checking, setChecking] = useState(true)
  const [busy, setBusy] = useState(false)
  const [address, setAddress] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [ownerConfig, setOwnerConfig] = useState<OwnerConsoleConfig | null>(null)
  const [configError, setConfigError] = useState('')
  const [toast, setToast] = useState<AuthToast | null>(null)
  const toastSequence = useRef(0)

  function showAuthToast(kind: AuthToast['kind'], message: string) {
    const clean = String(message || '').trim()
    if (!clean) return
    setToast({ id: ++toastSequence.current, kind, message: clean })
  }

  function renderAuthToast() {
    if (!toast) return null
    return (
      <div className={'wallet-vault-toast wallet-vault-toast--' + toast.kind} role={toast.kind === 'error' ? 'alert' : 'status'} aria-live={toast.kind === 'error' ? 'assertive' : 'polite'} aria-atomic="true">
        <span className="wallet-vault-toast-icon" aria-hidden="true">
          {toast.kind === 'error' ? <AlertTriangle size={20} /> : toast.kind === 'success' ? <CheckCircle2 size={20} /> : <Info size={20} />}
        </span>
        <div className="wallet-vault-toast-content">
          <strong>{toast.kind === 'error' ? 'Action needs attention' : toast.kind === 'success' ? 'Action completed' : 'Status update'}</strong>
          <p>{toast.message}</p>
        </div>
        <button type="button" className="wallet-vault-toast-dismiss" aria-label="Dismiss notification" onClick={() => setToast(null)}><X size={17} /></button>
      </div>
    )
  }

  useEffect(() => {
    if (configError) showAuthToast('error', configError)
  }, [configError])

  useEffect(() => {
    if (ownerConfig && !ownerConfig.configured) {
      showAuthToast('error', 'Owner sign-in setup is incomplete: ' + ownerConfig.requiredEnvironment.join(', '))
    }
  }, [ownerConfig])

  useEffect(() => {
    if (error) showAuthToast(/^signed out\.?$/i.test(error) ? 'info' : 'error', error)
  }, [error])

  useEffect(() => {
    if (!toast) return
    const timeoutId = window.setTimeout(() => {
      setToast(current => current?.id === toast.id ? null : current)
    }, toast.kind === 'error' ? 6500 : 4200)
    return () => window.clearTimeout(timeoutId)
  }, [toast])

  function clearSession() {
    try {
      const token = window.sessionStorage.getItem(SESSION_KEY)
      window.sessionStorage.removeItem(SESSION_KEY)
      if (token) {
        void fetch(API_BASE + '/api/auth/owner/logout', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token },
          credentials: 'omit',
          cache: 'no-store',
        }).catch(() => undefined)
      }
    } catch {
      // Clear in-memory session even when storage is unavailable.
    }
  }

  useEffect(() => {
    let cancelled = false
    async function readOwnerConfig() {
      try {
        const response = await fetch(API_BASE + '/api/auth/owner/config', {
          headers: { Accept: 'application/json' },
          credentials: 'omit',
          cache: 'no-store',
        })
        const payload = await response.json().catch(() => null)
        const config = payload?.ownerConsole
        if (!response.ok || payload?.success !== true
          || typeof config?.configured !== 'boolean'
          || !Array.isArray(config?.requiredEnvironment)
          || typeof config?.hostedUiOriginAllowed !== 'boolean'
          || typeof config?.packagedUiOriginAllowed !== 'boolean') {
          throw new Error('Owner configuration response is unavailable or invalid.')
        }
        if (!cancelled) {
          setOwnerConfig({
            configured: config.configured,
            requiredEnvironment: config.requiredEnvironment
              .filter((item: unknown): item is string => typeof item === 'string')
              .slice(0, 8),
            hostedUiOriginAllowed: config.hostedUiOriginAllowed,
            packagedUiOriginAllowed: config.packagedUiOriginAllowed,
          })
          setConfigError('')
        }
      } catch {
        if (!cancelled) setConfigError('Could not check backend owner-login configuration. Check the API connection and retry.')
      }
    }
    void readOwnerConfig()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    async function restore() {
      try {
        const token = window.sessionStorage.getItem(SESSION_KEY)
        if (!token) return
        const response = await fetch(API_BASE + '/api/auth/owner/session', {
          headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
          credentials: 'omit',
          cache: 'no-store',
        })
        const payload = await response.json().catch(() => null)
        if (!response.ok || payload?.success !== true || payload?.authenticated !== true
          || !ADDRESS_PATTERN.test(String(payload.address || '')) || payload.network !== 'mainnet'
          || !Number.isFinite(payload.expiresAt) || payload.expiresAt <= Date.now()) {
          throw new Error('Owner session expired. Sign in again.')
        }
        if (!cancelled) setSession({ address: payload.address, expiresAt: payload.expiresAt, sessionToken: token })
      } catch {
        try { window.sessionStorage.removeItem(SESSION_KEY) } catch { /* no-op */ }
      } finally {
        if (!cancelled) setChecking(false)
      }
    }
    void restore()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!session) return
    const timeout = window.setTimeout(() => {
      clearSession()
      setSession(null)
      setPassword('')
      setError('Your owner session expired. Sign in again.')
    }, Math.max(0, session.expiresAt - Date.now()))
    return () => window.clearTimeout(timeout)
  }, [session])

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch(API_BASE + '/api/auth/owner/login', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: address.trim(), password }),
        credentials: 'omit',
        cache: 'no-store',
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.success !== true || payload?.authenticated !== true
        || payload.network !== 'mainnet' || !ADDRESS_PATTERN.test(String(payload.address || ''))
        || typeof payload.sessionToken !== 'string' || !Number.isFinite(payload.expiresAt)) {
        throw new Error(payload?.message || (payload?.error === 'owner-auth-not-configured'
          ? 'Owner login is not configured on the backend yet.'
          : 'Owner address or password is incorrect.'))
      }
      window.sessionStorage.setItem(SESSION_KEY, payload.sessionToken)
      setSession({ address: payload.address, expiresAt: payload.expiresAt, sessionToken: payload.sessionToken })
      showAuthToast('success', 'Owner identity verified. Your authenticated session is active for 30 minutes.')
      setPassword('')
      setAddress(payload.address)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Owner sign-in failed. Check the backend and try again.')
    } finally {
      setBusy(false)
      setChecking(false)
    }
  }

  function signOut() {
    clearSession()
    setSession(null)
    setPassword('')
    setError('Signed out.')
  }

  // The primary Wallet Vault has its own unified top bar with session identity,
  // Settings, and Logout. Keep the legacy session strip only on secondary routes.
  const isPrimaryOwnerWalletRoute = !window.location.hash || window.location.hash === '#/wallet'

  if (session && session.expiresAt > Date.now()) {
    return (
      <>
        {!isPrimaryOwnerWalletRoute && (
          <div className="studio-auth-session-strip">
            <span><ShieldCheck size={14} aria-hidden="true" /> Owner session · {session.address.slice(0, 7)}…{session.address.slice(-5)} · Mainnet</span>
            <button type="button" onClick={signOut}><LogOut size={14} aria-hidden="true" /> Sign out</button>
          </div>
        )}
        {children}
        {renderAuthToast()}
      </>
    )
  }

  return (
    <div className="studio-auth-screen">
      <section className="studio-auth-card" aria-labelledby="studio-auth-title">
        <div className="studio-auth-brand">
          <span className="studio-logo"><Layers size={22} aria-hidden="true" /></span>
          <span><strong>TRON Token Studio</strong><small>PRIVATE OWNER CONSOLE</small></span>
        </div>
        <p className="studio-eyebrow">OWNER AUTHENTICATION</p>
        <h1 id="studio-auth-title">Sign in to your owner panel</h1>
        <p className="studio-auth-lead">Access is restricted to the single owner address configured on the backend. There is no public sign-up or account creation. Your password is verified by the server and is never stored in browser storage.</p>
        <form onSubmit={(event) => void signIn(event)} noValidate>
          <div className="studio-field-block">
            <label htmlFor="owner-address">Owner TRON address</label>
            <input id="owner-address" name="address" type="text" inputMode="text" autoComplete="username" spellCheck={false}
              placeholder="T..." value={address} onChange={(event) => setAddress(event.target.value)} required maxLength={34} />
          </div>
          <div className="studio-field-block">
            <label htmlFor="owner-password">Owner password</label>
            <input id="owner-password" name="password" type="password" autoComplete="current-password"
              placeholder="Enter your owner password" value={password} onChange={(event) => setPassword(event.target.value)} required maxLength={1024} />
            <p className="studio-field-hint">Use the password configured for the owner on the backend. Do not share it or commit it to GitHub.</p>
          </div>
          {checking ? (
            <div className="studio-auth-loading" role="status"><RefreshCw className="studio-spin" size={18} aria-hidden="true" /> Checking saved owner session…</div>
          ) : (
            <button type="submit" className="studio-button studio-button--primary studio-auth-submit" disabled={busy || !address.trim() || !password || (ownerConfig !== null && !ownerConfig.configured)}>
              <LockKeyhole size={17} aria-hidden="true" /> {busy ? 'Verifying owner…' : 'Sign in securely'}
            </button>
          )}
        </form>
        {configError && <p className="studio-inline-error" role="status">{configError}</p>}
        {ownerConfig && !ownerConfig.configured && (
          <div className="studio-inline-error" role="status">
            <strong>Owner login configuration is incomplete.</strong>
            <p>Missing or invalid backend settings: {ownerConfig.requiredEnvironment.length
              ? ownerConfig.requiredEnvironment.join(', ')
              : 'Required application origins are not allowlisted.'}</p>
            <p>Set the listed variables on the Render backend API service, save the environment, and reload this page after deployment. This status check never returns secret values.</p>
          </div>
        )}
        {error && <p className="studio-inline-error" role="alert">{error}</p>}
        <div className="studio-auth-points">
          <p><ShieldCheck size={16} aria-hidden="true" /><span><strong>One owner only.</strong> The server checks the configured wallet address and password hash; no public account creation exists.</span></p>
          <p><LockKeyhole size={16} aria-hidden="true" /><span><strong>Short-lived sessions.</strong> Owner sessions expire after 30 minutes; sign out when finished.</span></p>
          <p><Activity size={16} aria-hidden="true" /><span><strong>Authentication is not funding.</strong> Login cannot create genuine USDT or bypass on-chain balance requirements.</span></p>
        </div>
        <p className="studio-auth-footnote">If login is still blocked, configure the missing backend settings listed above: OWNER_WALLET_ADDRESS, OWNER_PASSWORD_HASH, DATABASE_URL, the exact hosted FRONTEND_ORIGIN, and PACKAGED_APP_ORIGINS including https://localhost for Android. Store secrets only in the backend environment; never paste plaintext passwords, API tokens, or private keys into chat or GitHub.</p>
      </section>
      {renderAuthToast()}
    </div>
  )
}
