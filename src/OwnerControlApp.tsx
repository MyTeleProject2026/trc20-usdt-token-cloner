import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { KeyRound, Layers, LockKeyhole, LogOut, ShieldCheck, UserRound, Wallet } from 'lucide-react'
import WalletVault from './WalletVault'

type OwnerSession = { email: string; expiresAt: number; sessionToken: string }
type Mode = 'login' | 'setup'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? '' : 'https://trc20-usdt-token-cloner-api.onrender.com')).replace(/\/+$/, '')
const SESSION_KEY = 'tron-token-studio:owner-session:v1'

async function readPayload(response: Response) {
  return response.json().catch(() => null)
}

export default function OwnerControlApp() {
  const [owner, setOwner] = useState<OwnerSession | null>(null)
  const [checking, setChecking] = useState(true)
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [setupKey, setSetupKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let cancelled = false
    const restore = async () => {
      let token = ''
      try { token = window.sessionStorage.getItem(SESSION_KEY) || '' } catch {}
      if (!token) {
        if (!cancelled) setChecking(false)
        return
      }
      try {
        const response = await fetch(API_BASE + '/api/owner-auth/session', {
          method: 'GET',
          headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
          credentials: 'omit',
          cache: 'no-store',
        })
        const payload = await readPayload(response)
        if (!response.ok || payload?.success !== true || payload?.authenticated !== true
          || typeof payload.email !== 'string' || !Number.isFinite(payload.expiresAt)
          || payload.expiresAt <= Date.now()) throw new Error('Owner session expired.')
        if (!cancelled) setOwner({ email: payload.email, expiresAt: payload.expiresAt, sessionToken: token })
      } catch {
        try { window.sessionStorage.removeItem(SESSION_KEY) } catch {}
      } finally {
        if (!cancelled) setChecking(false)
      }
    }
    void restore()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!owner) return
    const timeout = window.setTimeout(() => {
      try { window.sessionStorage.removeItem(SESSION_KEY) } catch {}
      setOwner(null)
      setError('Your owner session expired. Sign in again to unlock the workspace.')
      setNotice('')
    }, Math.max(0, owner.expiresAt - Date.now()))
    return () => window.clearTimeout(timeout)
  }, [owner])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setNotice('')
    const normalizedEmail = email.trim().toLowerCase()
    if (!/^[^\s@]{1,128}@[^\s@]{1,190}$/.test(normalizedEmail)) {
      setError('Enter a valid owner email address.')
      return
    }
    if (password.length < 12) {
      setError('Use a password with at least 12 characters.')
      return
    }
    if (mode === 'setup' && password !== confirmPassword) {
      setError('The password confirmation does not match.')
      return
    }
    if (mode === 'setup' && setupKey.length < 32) {
      setError('Owner setup requires the setup key configured on the backend.')
      return
    }

    setBusy(true)
    try {
      const response = await fetch(API_BASE + '/api/owner-auth/' + (mode === 'setup' ? 'setup' : 'login'), {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'setup'
          ? { email: normalizedEmail, password, setupKey }
          : { email: normalizedEmail, password }),
        credentials: 'omit',
        cache: 'no-store',
      })
      const payload = await readPayload(response)
      if (mode === 'setup') {
        if (!response.ok || payload?.success !== true || payload?.accountCreated !== true) {
          throw new Error(payload?.message || (payload?.error === 'owner-account-already-initialized'
            ? 'The single owner account already exists. Use Sign in.'
            : 'Owner account setup could not be completed (HTTP ' + response.status + ').'))
        }
        setMode('login')
        setEmail(normalizedEmail)
        setPassword('')
        setConfirmPassword('')
        setSetupKey('')
        setNotice('Owner account created. Sign in to access your private wallet workspace.')
      } else {
        if (!response.ok || payload?.success !== true || payload?.authenticated !== true
          || typeof payload.sessionToken !== 'string' || !Number.isFinite(payload.expiresAt)
          || payload.expiresAt <= Date.now() || payload.email !== normalizedEmail) {
          throw new Error(payload?.message || (payload?.error === 'owner-auth-storage-unavailable'
            ? 'Owner sign-in storage is unavailable. Check the backend database.'
            : 'Owner sign-in failed (HTTP ' + response.status + ').'))
        }
        try { window.sessionStorage.setItem(SESSION_KEY, payload.sessionToken) } catch {
          throw new Error('Secure session storage is unavailable in this browser. Enable session storage and retry.')
        }
        setOwner({ email: payload.email, expiresAt: payload.expiresAt, sessionToken: payload.sessionToken })
        setPassword('')
        setConfirmPassword('')
        setSetupKey('')
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The owner authentication service could not be reached.')
    } finally {
      setBusy(false)
    }
  }

  async function signOut() {
    const token = owner?.sessionToken
    try {
      if (token) await fetch(API_BASE + '/api/owner-auth/logout', {
        method: 'POST',
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
        credentials: 'omit',
        cache: 'no-store',
      })
    } catch {
      // Local sign-out must still lock the UI when the backend is unreachable.
    }
    try { window.sessionStorage.removeItem(SESSION_KEY) } catch {}
    setOwner(null)
    setPassword('')
    setConfirmPassword('')
    setSetupKey('')
    setError('')
    setNotice('Signed out. The owner workspace is locked.')
  }

  if (checking) {
    return <main className="studio-auth-screen"><section className="studio-auth-card"><p className="studio-auth-loading">Verifying the owner session…</p></section></main>
  }

  if (!owner) {
    return (
      <main className="studio-auth-screen owner-auth-screen">
        <section className="studio-auth-card owner-auth-card" aria-labelledby="owner-auth-title">
          <div className="studio-auth-brand">
            <span className="studio-logo"><Layers size={22} aria-hidden="true" /></span>
            <span><strong>TRON Token Studio</strong><small>PRIVATE OWNER WORKSPACE</small></span>
          </div>
          <p className="studio-eyebrow">SINGLE-OWNER ACCESS</p>
          <h1 id="owner-auth-title">{mode === 'setup' ? 'Create your owner account' : 'Unlock your workspace'}</h1>
          <p className="studio-auth-lead">
            {mode === 'setup'
              ? 'Initialize one owner account for this installation. Public sign-up is disabled; the backend setup key is required and only one account can be created.'
              : 'Sign in with your private owner account. This login does not require TronLink; your wallet keys remain separately encrypted in the local vault.'}
          </p>
          {error && <p className="studio-inline-error" role="alert">{error}</p>}
          {notice && <p className="studio-inline-note" role="status">{notice}</p>}
          <form onSubmit={event => void submit(event)} className="owner-auth-form">
            <label className="owner-auth-label">
              Owner email
              <span className="owner-auth-input-wrap"><UserRound size={16} aria-hidden="true" /><input type="email" required autoComplete="username" maxLength={190} value={email} onChange={event => setEmail(event.target.value)} placeholder="owner@example.com" /></span>
            </label>
            <label className="owner-auth-label">
              {mode === 'setup' ? 'Create password' : 'Password'}
              <span className="owner-auth-input-wrap"><LockKeyhole size={16} aria-hidden="true" /><input type="password" required minLength={12} maxLength={1024} autoComplete={mode === 'setup' ? 'new-password' : 'current-password'} value={password} onChange={event => setPassword(event.target.value)} placeholder="At least 12 characters" /></span>
            </label>
            {mode === 'setup' && <>
              <label className="owner-auth-label">
                Confirm password
                <span className="owner-auth-input-wrap"><LockKeyhole size={16} aria-hidden="true" /><input type="password" required minLength={12} maxLength={1024} autoComplete="new-password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} placeholder="Repeat your password" /></span>
              </label>
              <label className="owner-auth-label">
                One-time setup key
                <span className="owner-auth-input-wrap"><KeyRound size={16} aria-hidden="true" /><input type="password" required minLength={32} maxLength={512} autoComplete="off" value={setupKey} onChange={event => setSetupKey(event.target.value)} placeholder="OWNER_SETUP_KEY from API environment" /></span>
              </label>
              <p className="owner-auth-hint">Configure OWNER_SETUP_KEY on the backend with a high-entropy secret of at least 32 characters. Never commit it to source control.</p>
            </>}
            <button type="submit" className="studio-button studio-button--primary studio-auth-submit" disabled={busy}>
              <ShieldCheck size={17} aria-hidden="true" /> {busy ? 'Please wait…' : mode === 'setup' ? 'Create single owner account' : 'Sign in to owner workspace'}
            </button>
          </form>
          <div className="owner-auth-switch">
            {mode === 'login'
              ? <>First-time setup? <button type="button" disabled={busy} onClick={() => { setMode('setup'); setError(''); setNotice('') }}>Initialize the owner account</button></>
              : <>Already initialized? <button type="button" disabled={busy} onClick={() => { setMode('login'); setError(''); setNotice('') }}>Return to sign in</button></>}
          </div>
          <div className="studio-auth-points">
            <p><ShieldCheck size={16} aria-hidden="true" /><span><strong>One owner only.</strong> The backend atomically creates a single account; additional sign-ups are rejected.</span></p>
            <p><LockKeyhole size={16} aria-hidden="true" /><span><strong>No TronLink required for app login.</strong> The owner login authenticates the workspace, not an on-chain transaction.</span></p>
            <p><Wallet size={16} aria-hidden="true" /><span><strong>Self-custody remains local.</strong> Wallet creation, wallet password, and transaction signing are separate from this account password.</span></p>
          </div>
        </section>
      </main>
    )
  }

  return (
    <div className="owner-console">
      <header className="owner-console-topbar">
        <div className="owner-console-brand">
          <span className="studio-logo"><Layers size={20} aria-hidden="true" /></span>
          <span><strong>TRON Token Studio</strong><small>OWNER CONTROL PANEL</small></span>
        </div>
        <div className="owner-console-session">
          <span><ShieldCheck size={15} aria-hidden="true" /> {owner.email}</span>
          <button type="button" onClick={() => void signOut()}><LogOut size={15} aria-hidden="true" /> Sign out</button>
        </div>
      </header>
      <section className="owner-console-intro">
        <div>
          <p className="studio-eyebrow">PRIVATE WORKSPACE</p>
          <h1>Owner wallet control</h1>
          <p>Create or import your own software wallet, read balances from the selected TRON network, verify token contracts, and review real transactions from one screen.</p>
        </div>
        <span className="owner-console-status"><ShieldCheck size={15} aria-hidden="true" /> Owner session active</span>
      </section>
      <div className="owner-console-guidance" role="note">
        <LockKeyhole size={17} aria-hidden="true" />
        <p><strong>Real asset rule:</strong> the app can transfer only assets that exist at the sending address or are actually supplied by an authorized funded treasury. No UI or compiler can mint genuine Tether USDT or make an external exchange credit a fabricated deposit.</p>
      </div>
      <WalletVault />
      <footer className="owner-console-footer">Owner account session · expires {new Date(owner.expiresAt).toLocaleString()} · Wallet keys remain encrypted in this device’s local vault.</footer>
    </div>
  )
}
