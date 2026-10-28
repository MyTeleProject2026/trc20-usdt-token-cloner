import { useEffect, useState } from 'react'
import type { ReactNode, FormEvent } from 'react'
import { Activity, Download, Layers, LockKeyhole, Plus, RefreshCw, ShieldCheck, LogOut } from 'lucide-react'
import { TronWeb } from 'tronweb'
import { encryptWalletPrivateKey, isEncryptedWalletRecord } from './wallet-vault-crypto.mjs'

type OwnerSession = { address: string; expiresAt: number; sessionToken: string }
type OwnerConsoleConfig = {
  configured: boolean
  requiredEnvironment: string[]
  hostedUiOriginAllowed: boolean
  packagedUiOriginAllowed: boolean
}
type EncryptedLocalWallet = {
  format: string
  version: number
  address: string
  createdAt: number
  kdf: { name: string; hash: string; iterations: number; salt: string }
  cipher: { name: string; iv: string; tagLength: number }
  ciphertext: string
}

const API_BASE = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? '' : 'https://trc20-usdt-token-cloner-api.onrender.com')).replace(/\/+$/, '')
const SESSION_KEY = 'tron-token-studio:owner-session:v1'
const VAULT_KEY = 'tron-token-studio:encrypted-wallet-vault:v1'
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/

function readLocalEncryptedWallets(): EncryptedLocalWallet[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(VAULT_KEY) || '{}')
    if (parsed?.version !== 1 || !Array.isArray(parsed.wallets)) return []
    return parsed.wallets.filter(isEncryptedWalletRecord).slice(0, 50) as EncryptedLocalWallet[]
  } catch {
    return []
  }
}

function currentVaultForWrite(): EncryptedLocalWallet[] {
  let parsed: any
  try {
    const stored = window.localStorage.getItem(VAULT_KEY)
    parsed = stored ? JSON.parse(stored) : { version: 1, wallets: [] }
  } catch {
    throw new Error('The saved wallet vault cannot be parsed. Export or restore a valid backup before changing it.')
  }
  if (parsed?.version !== 1 || !Array.isArray(parsed.wallets)
    || parsed.wallets.some((record: unknown) => !isEncryptedWalletRecord(record))) {
    throw new Error('The saved wallet vault contains unsupported or invalid records. It was left unchanged.')
  }
  return parsed.wallets as EncryptedLocalWallet[]
}

export default function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<OwnerSession | null>(null)
  const [checking, setChecking] = useState(true)
  const [busy, setBusy] = useState(false)
  const [address, setAddress] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [ownerConfig, setOwnerConfig] = useState<OwnerConsoleConfig | null>(null)
  const [configError, setConfigError] = useState('')
  const [localWallets, setLocalWallets] = useState<EncryptedLocalWallet[]>(readLocalEncryptedWallets)
  const [localWalletPassword, setLocalWalletPassword] = useState('')
  const [localWalletPasswordConfirm, setLocalWalletPasswordConfirm] = useState('')
  const [localWalletBusy, setLocalWalletBusy] = useState(false)
  const [localWalletError, setLocalWalletError] = useState('')
  const [localWalletNotice, setLocalWalletNotice] = useState('')

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

  async function createLocalOwnerWallet() {
    if (localWalletBusy) return
    setLocalWalletBusy(true)
    setLocalWalletError('')
    setLocalWalletNotice('')
    try {
      if (localWalletPassword.length < 12 || localWalletPassword.length > 128) {
        throw new Error('Use a local wallet-encryption password between 12 and 128 characters.')
      }
      if (localWalletPassword !== localWalletPasswordConfirm) {
        throw new Error('The local wallet password confirmation does not match.')
      }
      // Account generation and encryption happen on this device only. The
      // private key is not put in React state, localStorage, a request, or logs.
      const web = new TronWeb({ fullHost: 'https://api.trongrid.io' })
      const account = await web.createAccount()
      const privateKey = String(account?.privateKey || '').replace(/^0x/i, '')
      const publicAddress = String(account?.address?.base58 || '')
      if (!/^[0-9a-f]{64}$/i.test(privateKey)
        || !ADDRESS_PATTERN.test(publicAddress)
        || !web.isAddress(publicAddress)) {
        throw new Error('The wallet SDK did not return a valid local TRON account. Nothing was saved.')
      }
      const encrypted = await encryptWalletPrivateKey(privateKey, publicAddress, localWalletPassword) as EncryptedLocalWallet
      const previous = currentVaultForWrite()
      const next = [...previous.filter((record) => record.address !== publicAddress), encrypted]
      window.localStorage.setItem(VAULT_KEY, JSON.stringify({ version: 1, wallets: next }))
      setLocalWallets(next.slice(-50))
      setAddress(publicAddress)
      setLocalWalletPassword('')
      setLocalWalletPasswordConfirm('')
      setLocalWalletNotice('Local wallet created and encrypted on this device. Use its public address as OWNER_WALLET_ADDRESS; this did not create or fund USDT.')
    } catch (caught) {
      setLocalWalletError(caught instanceof Error ? caught.message : 'Local owner wallet setup failed. No wallet was added.')
    } finally {
      setLocalWalletBusy(false)
    }
  }

  function downloadEncryptedWalletBackup(record: EncryptedLocalWallet) {
    try {
      const blob = new Blob([JSON.stringify({ wallet: record }, null, 2)], { type: 'application/json' })
      const url = window.URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = 'tron-token-studio-wallet-' + record.address.slice(0, 8) + '.json'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.URL.revokeObjectURL(url)
      setLocalWalletNotice('Encrypted backup export started. Keep it offline; it still requires the local wallet-encryption password.')
      setLocalWalletError('')
    } catch {
      setLocalWalletError('Could not export the encrypted backup. The encrypted wallet remains on this device.')
    }
  }

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

  if (session && session.expiresAt > Date.now()) {
    return (
      <>
        <div className="studio-auth-session-strip">
          <span><ShieldCheck size={14} aria-hidden="true" /> Owner session · {session.address.slice(0, 7)}…{session.address.slice(-5)} · Mainnet</span>
          <button type="button" onClick={signOut}><LogOut size={14} aria-hidden="true" /> Sign out</button>
        </div>
        {children}
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
        <p className="studio-auth-lead">Access is restricted to the single owner address configured on the backend. There is no public backend registration. Your owner-console password is verified by the server and is never stored in browser storage.</p>
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
        {ownerConfig && !ownerConfig.configured && (
          <section className="studio-auth-points" aria-labelledby="local-owner-wallet-heading">
            <h2 id="local-owner-wallet-heading">First-time local owner wallet setup</h2>
            <p>Create a wallet address entirely on this device if you do not already have one. The private key is encrypted with a separate local password and is never sent to the backend. Generating an address does not create USDT or activate owner login.</p>
            <div className="studio-field-block">
              <label htmlFor="local-wallet-password">Local wallet-encryption password</label>
              <input id="local-wallet-password" type="password" autoComplete="new-password"
                value={localWalletPassword} onChange={(event) => setLocalWalletPassword(event.target.value)}
                placeholder="At least 12 characters" maxLength={128} />
            </div>
            <div className="studio-field-block">
              <label htmlFor="local-wallet-password-confirm">Confirm local wallet password</label>
              <input id="local-wallet-password-confirm" type="password" autoComplete="new-password"
                value={localWalletPasswordConfirm} onChange={(event) => setLocalWalletPasswordConfirm(event.target.value)}
                placeholder="Repeat local wallet password" maxLength={128} />
            </div>
            <button type="button" className="studio-button studio-button--primary" disabled={localWalletBusy || localWalletPassword.length < 12 || localWalletPassword !== localWalletPasswordConfirm}
              onClick={() => void createLocalOwnerWallet()}>
              <Plus size={16} aria-hidden="true" /> {localWalletBusy ? 'Creating and encrypting locally…' : 'Create local owner wallet'}
            </button>
            {localWallets.length > 0 && (
              <div>
                <strong>Encrypted wallet addresses saved on this device</strong>
                {localWallets.map((record) => (
                  <div key={record.address} className="studio-field-block">
                    <label htmlFor={'local-owner-address-' + record.address}>Public address</label>
                    <input id={'local-owner-address-' + record.address} type="text" readOnly value={record.address} spellCheck={false} />
                    <div className="studio-inline-actions">
                      <button type="button" className="studio-button studio-button--secondary" onClick={() => setAddress(record.address)}>Use address for owner login</button>
                      <button type="button" className="studio-button studio-button--secondary" onClick={() => downloadEncryptedWalletBackup(record)}><Download size={15} aria-hidden="true" /> Download encrypted backup</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {localWalletError && <p className="studio-inline-error" role="alert">{localWalletError}</p>}
            {localWalletNotice && <p className="studio-auth-footnote" role="status">{localWalletNotice}</p>}
            <p className="studio-auth-footnote">Next, set the selected public address as OWNER_WALLET_ADDRESS in the Render backend. Generate OWNER_PASSWORD_HASH locally with the repository helper. Use the same owner address for TREASURY_OWNER_ADDRESS if you later configure treasury-backed payouts. Never upload the private key or send it to support.</p>
          </section>
        )}
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
          <p><ShieldCheck size={16} aria-hidden="true" /><span><strong>One owner only.</strong> The server checks the configured wallet address and password hash; local wallet setup never grants access to the owner panel.</span></p>
          <p><LockKeyhole size={16} aria-hidden="true" /><span><strong>Short-lived sessions.</strong> Owner sessions expire after 15 minutes and can be signed out.</span></p>
          <p><Activity size={16} aria-hidden="true" /><span><strong>Authentication is not funding.</strong> Login cannot create genuine USDT or bypass on-chain balance requirements.</span></p>
        </div>
        <p className="studio-auth-footnote">If login is not configured, the backend administrator must set OWNER_WALLET_ADDRESS and OWNER_PASSWORD_HASH in the private service environment. Never send the plaintext password or a private key to support.</p>
      </section>
    </div>
  )
}
