import { useEffect, useState } from 'react'
import './owner-wallet-access.css'
import { KeyRound, LockKeyhole, ShieldCheck, Upload } from 'lucide-react'
import {
  createOwnerTronWeb, deriveOwnerAccount, getSavedOwnerWalletAddress, hasSavedOwnerWallet,
  removeSavedOwnerWallet, saveOwnerWalletVault, unlockOwnerWalletVault, migrateOwnerWalletVault,\n  saveOwnerDeviceWallet, unlockOwnerDeviceWallet, hasOwnerDeviceWallet, removeOwnerDeviceWallet,
} from './owner-wallet-vault.mjs'
import { createManagedWalletAuthClient, OWNER_ADMIN_LOGIN_EMAIL } from './managed-wallet-auth-client.mjs'

const modes = [['private-key', 'Private key'], ['keystore', 'V3 Keystore JSON'], ['mnemonic', 'Mnemonic phrase']]
const ownerAuth = createManagedWalletAuthClient({ role: 'owner' })

export default function OwnerWalletAccess({ onUnlock, onClose }) {
  const [enrolled, setEnrolled] = useState(null)
  const [expectedOwnerAddress, setExpectedOwnerAddress] = useState('')
  const [authenticated, setAuthenticated] = useState(false)
  const [authPassword, setAuthPassword] = useState('')
  const [loginEmail, setLoginEmail] = useState(OWNER_ADMIN_LOGIN_EMAIL)
  const [initialAuthPassword, setInitialAuthPassword] = useState('')
  const [confirmAuthPassword, setConfirmAuthPassword] = useState('')
  const [enrollmentToken, setEnrollmentToken] = useState('')
  const [recoveryToken, setRecoveryToken] = useState('')
  const [confirmRecoveryPassword, setConfirmRecoveryPassword] = useState('')
  const [recoveryMode, setRecoveryMode] = useState(false)
  const [mode, setMode] = useState('private-key')
  const [credential, setCredential] = useState('')
  const [keystorePassword, setKeystorePassword] = useState('')
  const [vaultPassword, setVaultPassword] = useState('')
  const [unlockPassword, setUnlockPassword] = useState('')
  const [legacyVaultPassword, setLegacyVaultPassword] = useState('')
  const [vaultMigrationRequired, setVaultMigrationRequired] = useState(false)
  const [saved, setSaved] = useState(hasSavedOwnerWallet())
  const [replace, setReplace] = useState(!hasSavedOwnerWallet())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('Checking Owner account session…')

  useEffect(() => {
    let active = true
    Promise.all([ownerAuth.status(), ownerAuth.session().catch(() => null)]).then(async ([status, session]) => {
      if (!active) return
      const configuredOwnerAddress = String(status.ownerAddress || '')
      if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(configuredOwnerAddress) || status.identityMatches === false) {
        setExpectedOwnerAddress(configuredOwnerAddress)
        setEnrolled(null)
        setError(status.identityMatches === false
          ? 'OWNER_ENROLLED_ADDRESS_MISMATCH'
          : 'OWNER_MAINNET_ADDRESS_NOT_CONFIGURED')
        setMessage('The Resource API has not verified a configured Owner Mainnet address. Owner authentication and signing are disabled.')
        return
      }
      setExpectedOwnerAddress(configuredOwnerAddress)
      setEnrolled(Boolean(status.enrolled))
      if (session?.success && session.role === 'owner' && session.address === configuredOwnerAddress) {
        setAuthenticated(true)
        setMessage('Owner application session is active. Unlock the encrypted local Owner Wallet to enable local signing.')
      } else {
        setMessage(status.enrolled
          ? 'Sign in to the configured Owner application account, then unlock the independent local Owner Wallet.'
          : 'First-time setup requires the existing Owner initial password configured on the Resource API, then a new Owner account password.')
      }
    }).catch(cause => {
      if (!active) return
      setEnrolled(null)
      setError(cause?.message || 'OWNER_AUTH_STATUS_UNAVAILABLE')
      setMessage('The Resource API Owner account could not be reached.')
    })
    return () => { active = false }
  }, [])

  async function authenticate(event) {
    event.preventDefault()
    setBusy(true); setError('')
    try {
      const result = recoveryMode
        ? await ownerAuth.recoverPassword(recoveryToken.trim(), authPassword)
        : enrolled
          ? await ownerAuth.login(authPassword, loginEmail)
          : await ownerAuth.enroll(authPassword, enrollmentToken.trim(), initialAuthPassword)
      if (recoveryMode) {
        setRecoveryMode(false); setRecoveryToken(''); setConfirmRecoveryPassword('')
        setEnrolled(true); setMessage('Owner password recovered. Sign in with the new password.')
        setAuthPassword('')
        return
      }
      if (!expectedOwnerAddress || result.address !== expectedOwnerAddress) {
        await ownerAuth.logout().catch(() => {})
        throw new Error('The authenticated Owner account does not match the configured TRON Mainnet Owner address.')
      }
      setAuthenticated(true)
      setEnrolled(true)
      setUnlockPassword(authPassword)
      setVaultPassword(authPassword)
      setAuthPassword(''); setInitialAuthPassword(''); setConfirmAuthPassword(''); setEnrollmentToken('')
      setMessage('Owner Admin authenticated. Activating the configured Owner wallet without a second password prompt.')
      if (saved && !replace) {
        try {
          const account = vaultMigrationRequired
            ? await migrateOwnerWalletVault(legacyVaultPassword, authPassword)
            : await unlockOwnerWalletVault(authPassword)
          await activate(account, authPassword)
          return
        } catch (vaultError) {
          setVaultMigrationRequired(true)
          setMessage('Owner Admin sign-in succeeded. This older local vault needs its previous vault password once to migrate; it will not be requested on later sign-ins.')
          if (vaultMigrationRequired) throw vaultError
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Owner account authentication failed.')
    } finally { setBusy(false) }
  }

  async function activate(account, sessionPassword = '', configuredAddress = expectedOwnerAddress) {
    const tronWeb = createOwnerTronWeb(account.privateKey)
    const derived = tronWeb.address.fromPrivateKey(account.privateKey)
    if (!configuredAddress || derived !== configuredAddress || account.address !== configuredAddress) {
      throw new Error('Imported address does not match the configured TRON TRANSFER Owner Wallet. Expected ' + (configuredAddress || 'an unconfigured address') + '.')
    }
    if (new URL(String(tronWeb.fullNode?.host || '')).hostname !== 'api.trongrid.io') {
      throw new Error('Owner signer is not connected to TRON Mainnet.')
    }
    if (typeof tronWeb.trx?.sign !== 'function') throw new Error('Local Owner transaction signing is unavailable in this browser.')
    onUnlock({
      address: derived, tronWeb, provider: null, managedSession: true,
      signerType: 'encrypted-local-owner-vault', authClient: ownerAuth, ownerAdminPassword: sessionPassword,
    })
  }

  async function importWallet(event) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const account = await deriveOwnerAccount({ mode, value: credential, secretPassword: keystorePassword })
      if (!expectedOwnerAddress || account.address !== expectedOwnerAddress) throw new Error('Imported address does not match the configured Owner Wallet. Expected ' + (expectedOwnerAddress || 'an unconfigured address') + '.')
      const ownerSession = await ownerAuth.session()
      if (!ownerSession?.success || ownerSession.address !== expectedOwnerAddress) throw new Error('OWNER_ADMIN_SESSION_REQUIRED')
      const localVaultPassword = globalThis.crypto?.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('')
      await saveOwnerWalletVault(account, localVaultPassword)
      await saveOwnerDeviceWallet(account).catch(() => {})
      setSaved(true); setCredential(''); setKeystorePassword('')
      await activate(account, vaultPassword)
      setVaultPassword('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Owner Wallet import failed.') }
    finally { setBusy(false) }
  }

  async function unlockWallet(event) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const authenticatedOwner = await ownerAuth.login(unlockPassword, loginEmail)
      if (authenticatedOwner.address !== expectedOwnerAddress) throw new Error('OWNER_ADMIN_REAUTHENTICATION_FAILED')
      let account
      try {
        account = vaultMigrationRequired
          ? await migrateOwnerWalletVault(legacyVaultPassword, unlockPassword)
          : await unlockOwnerWalletVault(unlockPassword)
      } catch (cause) {
        if (!vaultMigrationRequired) {
          setVaultMigrationRequired(true)
          throw new Error('This saved vault uses an older password. Enter its previous vault password once to migrate it to your Owner Admin password.')
        }
        throw cause
      }
      await activate(account, unlockPassword)
      setUnlockPassword(''); setLegacyVaultPassword(''); setVaultMigrationRequired(false)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Owner Wallet unlock failed.') }
    finally { setBusy(false) }
  }

  function removeBackup() {
    if (!window.confirm('Permanently remove the encrypted Owner Wallet backup from this browser? This does not change the on-chain wallet. Ensure you have your own offline recovery backup.')) return
    try { removeSavedOwnerWallet(); void removeOwnerDeviceWallet().catch(() => {}); setSaved(false); setReplace(true); setUnlockPassword('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not remove the local backup.') }
  }

  return <div role="dialog" aria-modal="true" aria-labelledby="owner-wallet-title" className="owner-vault-backdrop">
    <section className="owner-vault-card">
      <div className="owner-vault-heading"><ShieldCheck/><div><span>TRON TRANSFER · OWNER AUTHENTICATION</span><h2 id="owner-wallet-title">Owner Admin workspace</h2><p>One application sign-in · protected local Mainnet signing · no TronLink connection required</p></div></div>
      {!authenticated ? <>
        <div className="owner-vault-warning">The managed Owner password authenticates application access only. The separate encrypted local Owner vault holds the transaction-signing key. Never send wallet credentials to the Resource API.</div>
        <p className="owner-vault-address">{message}</p>
        <form onSubmit={authenticate}>
          {enrolled && !recoveryMode && <label>Owner Admin email<input type="email" autoComplete="username" value={loginEmail} onChange={event => setLoginEmail(event.target.value)} required/></label>}
          {!enrolled && !recoveryMode && <label>Existing Owner password<input type="password" autoComplete="current-password" value={initialAuthPassword} onChange={event => setInitialAuthPassword(event.target.value)} required/></label>}
          {recoveryMode && <label>One-time Owner recovery token<input type="password" autoComplete="off" value={recoveryToken} onChange={event => setRecoveryToken(event.target.value)} required/></label>}
          <label>{recoveryMode || !enrolled ? 'New Owner account password' : 'Owner account password'}<input type="password" minLength={8} autoComplete={recoveryMode || !enrolled ? 'new-password' : 'current-password'} value={authPassword} onChange={event => setAuthPassword(event.target.value)} required/></label>
          {!enrolled && !recoveryMode && <label>Confirm new Owner password<input type="password" minLength={8} autoComplete="new-password" value={confirmAuthPassword} onChange={event => setConfirmAuthPassword(event.target.value)} required/></label>}
          {recoveryMode && <label>Confirm new Owner password<input type="password" minLength={8} autoComplete="new-password" value={confirmRecoveryPassword} onChange={event => setConfirmRecoveryPassword(event.target.value)} required/></label>}
          <button className="owner-vault-primary" disabled={busy || authPassword.length < 8 || enrolled === null || (recoveryMode ? recoveryToken.length < 32 || confirmRecoveryPassword !== authPassword : !enrolled && (initialAuthPassword.length < 12 || confirmAuthPassword !== authPassword))}><LockKeyhole size={16}/>{busy ? 'Working…' : recoveryMode ? 'Recover Owner password' : enrolled ? 'Sign in to Owner workspace' : 'Create Owner account'}</button>
          <div className="owner-vault-actions">{enrolled && <button type="button" onClick={() => {setRecoveryMode(value => !value);setAuthPassword('');setRecoveryToken('');setConfirmRecoveryPassword('')}}>{recoveryMode ? 'Back to Owner login' : 'Recover Owner password'}</button>}<button type="button" onClick={onClose}>Close</button></div>
        </form>
      </> : saved && !replace ? <form onSubmit={unlockWallet}>
        <p className="owner-vault-address">Saved Owner Wallet: <b>{getSavedOwnerWalletAddress()}</b></p>
        <label>Owner Admin application password<input type="password" minLength={8} autoComplete="current-password" value={unlockPassword} onChange={event=>setUnlockPassword(event.target.value)} required/></label>
        {vaultMigrationRequired && <label>Previous Owner vault password (one-time migration)<input type="password" autoComplete="current-password" value={legacyVaultPassword} onChange={event=>setLegacyVaultPassword(event.target.value)} required/></label>}
        <button className="owner-vault-primary" disabled={busy || !unlockPassword}><LockKeyhole size={16}/>{busy ? 'Unlocking…' : 'Unlock Owner Wallet'}</button>
        <div className="owner-vault-actions"><button type="button" onClick={()=>setReplace(true)}>Replace wallet</button><button type="button" onClick={removeBackup}>Remove encrypted backup</button><button type="button" onClick={onClose}>Close</button></div>
      </form> : <form onSubmit={importWallet}>
        <div className="owner-vault-warning">Import only the existing configured Owner Wallet. Credentials are processed in this browser and encrypted before local storage. The private key is never sent to the Resource API. Browser-local custody is not a hardware wallet or audited HSM.</div>
        <label>Import format<select value={mode} onChange={event=>setMode(event.target.value)}>{modes.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
        <label>{mode === 'private-key' ? 'Owner private key' : mode === 'mnemonic' ? 'Owner recovery phrase' : 'V3 Keystore JSON'}<textarea rows={mode === 'mnemonic' ? 3 : 4} value={credential} onChange={event=>setCredential(event.target.value)} required autoComplete="off" spellCheck="false"/></label>
        {mode === 'keystore' && <label>Select V3 Keystore JSON file<input type="file" accept=".json,application/json" onChange={async event=>{const file=event.target.files?.[0];if(file){try{setCredential(await file.text())}catch{setError('Could not read the selected keystore file.')}}}}/></label>}
        {mode === 'keystore' && <label>Keystore password<input type="password" value={keystorePassword} onChange={event=>setKeystorePassword(event.target.value)}/></label>}
        <button className="owner-vault-primary" disabled={busy || !credential}><Upload size={16}/>{busy ? 'Encrypting and verifying…' : 'Import and unlock Owner Wallet'}</button>
        {saved && <button type="button" className="owner-vault-secondary" onClick={()=>{setReplace(false);setCredential('');setVaultPassword('')}}>Cancel replacement</button>}
      </form>}
      {error && <p role="alert" className="owner-vault-error">{error}</p>}
      <p className="owner-vault-footnote"><KeyRound size={14}/> Configured Owner: {expectedOwnerAddress || 'not configured'}. Local signing is followed by backend signature/permission verification, durable persistence and Mainnet receipt reconciliation. Every write remains subject to the configured execution gates.</p>
    </section>
  </div>
}
