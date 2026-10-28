import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { LockKeyhole, ShieldCheck, LogOut } from 'lucide-react'

const API = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? '' : 'https://trc20-usdt-token-cloner-api.onrender.com')).replace(/\/+$/, '')
const KEY = 'tron-token-studio:owner-session:v1'
const ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const TOKEN = /^[A-Za-z0-9_-]{43}$/

type Session = { address: string; expiresAt: number; token: string }
type Props = { children: ReactNode }

export default function OwnerGate({ children }: Props) {
  const [address, setAddress] = useState('')
  const [password, setPassword] = useState('')
  const [session, setSession] = useState<Session | null>(null)
  const [configured, setConfigured] = useState(false)
  const [setup, setSetup] = useState<string[]>([])
  const [checking, setChecking] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    async function restore() {
      try {
        const response = await fetch(API + '/api/owner-auth/config', { cache: 'no-store', credentials: 'omit' })
        const config = await response.json()
        if (!cancelled) {
          setConfigured(config.configured === true)
          setSetup(Array.isArray(config.requiredEnvironment) ? config.requiredEnvironment : [])
          if (ADDRESS.test(String(config.ownerAddress || ''))) setAddress(String(config.ownerAddress))
        }
      } catch {
        if (!cancelled) setError('Cannot reach the owner-authentication API.')
      }
      let token = ''
      try { token = sessionStorage.getItem(KEY) || '' } catch {}
      if (!TOKEN.test(token)) {
        if (!cancelled) setChecking(false)
        return
      }
      try {
        const response = await fetch(API + '/api/owner-auth/session', {
          headers: { Authorization: 'Bearer ' + token }, cache: 'no-store', credentials: 'omit',
        })
        const payload = await response.json()
        if (!response.ok || payload.success !== true || payload.authenticated !== true
          || payload.network !== 'mainnet' || !ADDRESS.test(String(payload.address || ''))
          || !Number.isFinite(payload.expiresAt) || payload.expiresAt <= Date.now()) throw new Error('expired')
        if (!cancelled) setSession({ address: payload.address, expiresAt: payload.expiresAt, token })
      } catch {
        try { sessionStorage.removeItem(KEY) } catch {}
      } finally {
        if (!cancelled) setChecking(false)
      }
    }
    void restore()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!session) return
    const timer = window.setTimeout(() => {
      try { sessionStorage.removeItem(KEY) } catch {}
      setSession(null)
      setError('Owner session expired. Sign in again.')
    }, Math.max(0, session.expiresAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [session])

  async function login(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const response = await fetch(API + '/api/owner-auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ address: address.trim(), password }),
        cache: 'no-store', credentials: 'omit',
      })
      const payload = await response.json()
      setPassword('')
      if (!response.ok || payload.success !== true || payload.authenticated !== true
        || payload.network !== 'mainnet' || !ADDRESS.test(String(payload.address || ''))
        || !TOKEN.test(String(payload.sessionToken || '')) || !Number.isFinite(payload.expiresAt)) {
        throw new Error(payload.message || 'Owner address or password was rejected.')
      }
      sessionStorage.setItem(KEY, payload.sessionToken)
      setSession({ address: payload.address, expiresAt: payload.expiresAt, token: payload.sessionToken })
      setConfigured(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Owner sign-in failed.')
    } finally {
      setBusy(false)
    }
  }

  async function logout() {
    try {
      if (session) await fetch(API + '/api/owner-auth/logout', {
        method: 'POST', headers: { Authorization: 'Bearer ' + session.token },
        cache: 'no-store', credentials: 'omit',
      })
    } catch {}
    try { sessionStorage.removeItem(KEY) } catch {}
    setSession(null)
    setPassword('')
  }

  if (checking) return <main className="owner-login"><section className="owner-login-card"><ShieldCheck /><h1>TRON Token Studio</h1><p>Checking private owner session…</p></section></main>

  if (!session) return (
    <main className="owner-login">
      <section className="owner-login-card">
        <div className="owner-login-mark"><ShieldCheck size={28} /></div>
        <p className="owner-login-kicker">Private owner console</p>
        <h1>TRON Token Studio</h1>
        <p>Sign in with the single owner account configured by the service administrator.</p>
        <div className="owner-login-notice">Registration is disabled. This password grants console access only; it does not generate USDT or authorize transfers.</div>
        {!configured && <div className="owner-login-warning"><strong>Backend setup required</strong><p>Configure the owner address, password hash and database.</p>{setup.length > 0 && <p>{setup.join(', ')}</p>}</div>}
        <form onSubmit={(event) => void login(event)}>
          <label htmlFor="owner-address">Owner TRON address</label>
          <input id="owner-address" value={address} onChange={(event) => setAddress(event.target.value)} maxLength={34} autoComplete="username" spellCheck={false} required />
          <label htmlFor="owner-password">Owner password</label>
          <input id="owner-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} maxLength={1024} autoComplete="current-password" required />
          {error && <p className="owner-login-error" role="alert">{error}</p>}
          <button type="submit" disabled={busy || !configured}><LockKeyhole size={16} /> {busy ? 'Verifying…' : 'Sign in'}</button>
        </form>
        <p className="owner-login-footnote">No public registration. Password and session verification run on the backend.</p>
      </section>
    </main>
  )

  return <div className="owner-authenticated">
    <div className="owner-authenticated-bar"><span><ShieldCheck size={17} /> Owner console <small>{session.address.slice(0, 8)}…{session.address.slice(-5)}</small></span><nav><a href="#/wallet">Wallet</a><a href="#/watch-wallets">Watch-only</a><a href="#/exchange-deposit">Exchange deposits</a><a href="#/okx-deposit-status">OKX records</a></nav><button type="button" onClick={() => void logout()}><LogOut size={14} /> Sign out</button></div>
    {children}
  </div>
}
