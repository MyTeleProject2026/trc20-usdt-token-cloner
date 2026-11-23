import { useEffect, useState } from 'react'
import './owner-wallet-access.css'
import { KeyRound, LockKeyhole, ShieldCheck, Upload } from 'lucide-react'
import {
  createOwnerTronWeb, deriveOwnerAccount, getSavedOwnerWalletAddress, hasSavedOwnerWallet,
  removeSavedOwnerWallet, saveOwnerWalletVault, unlockOwnerWalletVault,
} from './owner-wallet-vault.mjs'
import { createManagedWalletAuthClient } from './managed-wallet-auth-client.mjs'

const EXPECTED_OWNER_ADDRESS = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const modes = [['private-key', 'Private key'], ['keystore', 'V3 Keystore JSON'], ['mnemonic', 'Mnemonic phrase']]
const ownerAuth = createManagedWalletAuthClient({ role: 'owner' })

export default function OwnerWalletAccess({ onUnlock, onClose }) {
  const [enrolled, setEnrolled] = useState(null)
  const [authenticated, setAuthenticated] = useState(false)
  const [authPassword, setAuthPassword] = useState('')
  const [enrollmentToken, setEnrollmentToken] = useState('')
  const [recoveryToken, setRecoveryToken] = useState('')
  const [confirmRecoveryPassword, setConfirmRecoveryPassword] = useState('')
  const [recoveryMode, setRecoveryMode] = useState(false)
  const [mode, setMode] = useState('private-key')
  const [credential, setCredential] = useState('')
  const [keystorePassword, setKeystorePassword] = useState('')
  const [vaultPassword, setVaultPassword] = useState('')
  const [unlockPassword, setUnlockPassword] = useState('')
  const [saved, setSaved] = useState(hasSavedOwnerWallet())
  const [replace, setReplace] = useState(!hasSavedOwnerWallet())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('Checking Owner account session…')

  useEffect(() => {
    let active = true
    Promise.all([ownerAuth.status(), ownerAuth.session().catch(() => null)]).then(([status, session]) => {
      if (!active) return
      setEnrolled(Boolean(status.enrolled))
      if (session?.success && session.address === EXPECTED_OWNER_ADDRESS) {
        setAuthenticated(true)
        setMessage('Owner application session is active. Unlock the encrypted local Owner Wallet to enable local signing.')
      } else {
        setMessage(status.enrolled
          ? 'Sign in to the Owner application account, then unlock the independent local Owner Wallet.'
          : 'First-time setup requires the one-time Owner enrollment token, then import the existing Owner Wallet.')
      }
    }).catch(cause => {
      if (!active) return
      setEnrolled(false)
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
          ? await ownerAuth.login(authPassword)
          : await ownerAuth.enroll(authPassword, enrollmentToken.trim())
      if (recoveryMode) {
        setRecoveryMode(false); setRecoveryToken(''); setConfirmRecoveryPassword('')
        setEnrolled(true); setMessage('Owner password recovered. Sign in with the new password.')
        setAuthPassword('')
        return
      }
      if (result.address !== EXPECTED_OWNER_ADDRESS) {
        await ownerAuth.logout().catch(() => {})
        throw new Error('The authenticated Owner account does not match the configured TRON Mainnet Owner address.')
      }
      setAuthenticated(true)
      setEnrolled(true)
      setAuthPassword(''); setEnrollmentToken('')
      setMessage('Owner application session authenticated. Unlock or import the independent local Owner Wallet.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Owner account authentication failed.')
    } finally { setBusy(false) }
  }

  async function activate(account) {
    const tronWeb = createOwnerTronWeb(account.privateKey)
    const derived = tronWeb.address.fromPrivateKey(account.privateKey)
    if (derived !== EXPECTED_OWNER_ADDRESS || account.address !== EXPECTED_OWNER_ADDRESS) {
      throw new Error('Imported address does not match the configured TRON TRANSFER Owner Wallet. Expected ' + EXPECTED_OWNER_ADDRESS + '.')
    }
    if (new URL(String(tronWeb.fullNode?.host || '')).hostname !== 'api.trongrid.io') {
      throw new Error('Owner signer is not connected to TRON Mainnet.')
    }
    if (typeof tronWeb.trx?.sign !== 'function') throw new Error('Local Owner transaction signing is unavailable in this browser.')
    onUnlock({
      address: derived, tronWeb, provider: null, managedSession: true,
      signerType: 'encrypted-local-owner-vault', authClient: ownerAuth,
    })
  }

  async function importWallet(event) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const account = await deriveOwnerAccount({ mode, value: credential, secretPassword: keystorePassword })
      if (account.address !== EXPECTED_OWNER_ADDRESS) throw new Error('Imported address does not match the configured Owner Wallet. Expected ' + EXPECTED_OWNER_ADDRESS + '.')
      await saveOwnerWalletVault(account, vaultPassword)
      setSaved(true); setCredential(''); setKeystorePassword(''); setVaultPassword('')
      await activate(account)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Owner Wallet import failed.') }
    finally { setBusy(false) }
  }

  async function unlockWallet(event) {
    event.preventDefault(); setBusy(true); setError('')
    try { await activate(await unlockOwnerWalletVault(unlockPassword)); setUnlockPassword('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Owner Wallet unlock failed.') }
    finally { setBusy(false) }
  }

  function removeBackup() {
    if (!window.confirm('Permanently remove the encrypted Owner Wallet backup from this browser? This does not change the on-chain wallet. Ensure you have your own offline recovery backup.')) return
    try { removeSavedOwnerWallet(); setSaved(false); setReplace(true); setUnlockPassword('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not remove the local backup.') }
  }

  return <div role="dialog" aria-modal="true" aria-labelledby="owner-wallet-title" className="owner-vault-backdrop">
    <section className="owner-vault-card">
      <div className="owner-vault-heading"><ShieldCheck/><div><span>TRON TRANSFER · OWNER AUTHENTICATION</span><h2 id="owner-wallet-title">Independent Owner Wallet</h2><p>Encrypted local Mainnet signing · no TronLink connection required</p></div></div>
      {!authenticated ? <>
        <div className="owner-vault-warning">The managed Owner password authenticates application access only. The separate encrypted local Owner vault holds the transaction-signing key. Never send wallet credentials to the Resource API.</div>
        <p className="owner-vault-address">{message}</p>
        <form onSubmit={authenticate}>
          {!enrolled && !recoveryMode && <label>One-time Owner enrollment token<input type="password" autoComplete="off" value={enrollmentToken} onChange={event => setEnrollmentToken(event.target.value)} required/></label>}
          {recoveryMode && <label>One-time Owner recovery token<input type="password" autoComplete="off" value={recoveryToken} onChange={event => setRecoveryToken(event.target.value)} required/></label>}
          <label>{recoveryMode ? 'New Owner account password' : 'Owner account password'}<input type="password" minLength={12} autoComplete={recoveryMode || !enrolled ? 'new-password' : 'current-password'} value={authPassword} onChange={event => setAuthPassword(event.target.value)} required/></label>
          {recoveryMode && <label>Confirm new Owner password<input type="password" minLength={12} autoComplete="new-password" value={confirmRecoveryPassword} onChange={event => setConfirmRecoveryPassword(event.target.value)} required/></label>}
          <button className="owner-vault-primary" disabled={busy || authPassword.length < 12 || enrolled === null || (recoveryMode ? recoveryToken.length < 32 || confirmRecoveryPassword !== authPassword : !enrolled && enrollmentToken.length < 32)}><LockKeyhole size={16}/>{busy ? 'Working…' : recoveryMode ? 'Recover Owner password' : enrolled ? 'Sign in to Owner workspace' : 'Enroll Owner password'}</button>
          <div className="owner-vault-actions">{enrolled && <button type="button" onClick={() => {setRecoveryMode(value => !value);setAuthPassword('');setRecoveryToken('');setConfirmRecoveryPassword('')}}>{recoveryMode ? 'Back to Owner login' : 'Recover Owner password'}</button>}<button type="button" onClick={onClose}>Close</button></div>
        </form>
      </> : saved && !replace ? <form onSubmit={unlockWallet}>
        <p className="owner-vault-address">Saved Owner Wallet: <b>{getSavedOwnerWalletAddress()}</b></p>
        <label>Owner vault password<input type="password" autoComplete="current-password" value={unlockPassword} onChange={event=>setUnlockPassword(event.target.value)} required/></label>
        <button className="owner-vault-primary" disabled={busy || !unlockPassword}><LockKeyhole size={16}/>{busy ? 'Unlocking…' : 'Unlock Owner Wallet'}</button>
        <div className="owner-vault-actions"><button type="button" onClick={()=>setReplace(true)}>Replace wallet</button><button type="button" onClick={removeBackup}>Remove encrypted backup</button><button type="button" onClick={onClose}>Close</button></div>
      </form> : <form onSubmit={importWallet}>
        <div className="owner-vault-warning">Import only the existing configured Owner Wallet. Credentials are processed in this browser and encrypted before local storage. The private key is never sent to the Resource API. Browser-local custody is not a hardware wallet or audited HSM.</div>
        <label>Import format<select value={mode} onChange={event=>setMode(event.target.value)}>{modes.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
        <label>{mode === 'private-key' ? 'Owner private key' : mode === 'mnemonic' ? 'Owner recovery phrase' : 'V3 Keystore JSON'}<textarea rows={mode === 'mnemonic' ? 3 : 4} value={credential} onChange={event=>setCredential(event.target.value)} required autoComplete="off" spellCheck="false"/></label>
        {mode === 'keystore' && <label>Select V3 Keystore JSON file<input type="file" accept=".json,application/json" onChange={async event=>{const file=event.target.files?.[0];if(file){try{setCredential(await file.text())}catch{setError('Could not read the selected keystore file.')}}}}/></label>}
        {mode === 'keystore' && <label>Keystore password<input type="password" value={keystorePassword} onChange={event=>setKeystorePassword(event.target.value)}/></label>}
        <label>New local vault password (minimum 12 characters)<input type="password" minLength={12} value={vaultPassword} onChange={event=>setVaultPassword(event.target.value)} required autoComplete="new-password"/></label>
        <button className="owner-vault-primary" disabled={busy || !credential || vaultPassword.length < 12}><Upload size={16}/>{busy ? 'Encrypting and verifying…' : 'Import and unlock Owner Wallet'}</button>
        {saved && <button type="button" className="owner-vault-secondary" onClick={()=>{setReplace(false);setCredential('');setVaultPassword('')}}>Cancel replacement</button>}
      </form>}
      {error && <p role="alert" className="owner-vault-error">{error}</p>}
      <p className="owner-vault-footnote"><KeyRound size={14}/> Expected Owner: {EXPECTED_OWNER_ADDRESS}. Local signing is followed by backend signature/permission verification, durable persistence and Mainnet receipt reconciliation. Every write remains subject to the configured execution gates.</p>
    </section>
  </div>
}
