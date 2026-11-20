import { useState } from 'react'
import { KeyRound, LockKeyhole, ShieldCheck, Upload, Wallet } from 'lucide-react'
import {
  createOwnerTronWeb, deriveOwnerAccount, getSavedOwnerWalletAddress, hasSavedOwnerWallet,
  removeSavedOwnerWallet, saveOwnerWalletVault, unlockOwnerWalletVault,
} from './owner-wallet-vault.mjs'

const EXPECTED_OWNER_ADDRESS = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const modes = [['private-key', 'Private key'], ['keystore', 'V3 Keystore JSON'], ['mnemonic', 'Mnemonic phrase']]

export default function OwnerWalletAccess({ onUnlock, onClose }) {
  const [mode, setMode] = useState('private-key')
  const [credential, setCredential] = useState('')
  const [keystorePassword, setKeystorePassword] = useState('')
  const [vaultPassword, setVaultPassword] = useState('')
  const [unlockPassword, setUnlockPassword] = useState('')
  const [saved, setSaved] = useState(hasSavedOwnerWallet())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [replace, setReplace] = useState(!hasSavedOwnerWallet())

  async function activate(account) {
    const tronWeb = createOwnerTronWeb(account.privateKey)
    const derived = tronWeb.address.fromPrivateKey(account.privateKey)
    if (derived !== EXPECTED_OWNER_ADDRESS) throw new Error('Imported address does not match the configured TRON TRANSFER Owner Wallet. Expected ' + EXPECTED_OWNER_ADDRESS + '.')
    if (new URL(String(tronWeb.fullNode?.host || '')).hostname !== 'api.trongrid.io') throw new Error('Owner signer is not connected to TRON Mainnet.')
    onUnlock({ address: derived, tronWeb, provider: null, signerType: 'encrypted-local-owner-vault' })
  }
  async function importWallet(event) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const account = await deriveOwnerAccount({ mode, value: credential, secretPassword: keystorePassword })
      if (account.address !== EXPECTED_OWNER_ADDRESS) throw new Error('Imported address does not match the configured Owner Wallet. Expected ' + EXPECTED_OWNER_ADDRESS + '.')
      await saveOwnerWalletVault(account, vaultPassword)
      setSaved(true); setCredential(''); setKeystorePassword(''); setVaultPassword('')
      await activate(account)
    } catch (e) { setError(e instanceof Error ? e.message : 'Owner Wallet import failed.') }
    finally { setBusy(false) }
  }
  async function unlockWallet(event) {
    event.preventDefault(); setBusy(true); setError('')
    try { await activate(await unlockOwnerWalletVault(unlockPassword)); setUnlockPassword('') }
    catch (e) { setError(e instanceof Error ? e.message : 'Owner Wallet unlock failed.') }
    finally { setBusy(false) }
  }
  function removeBackup() {
    if (!window.confirm('Permanently remove the encrypted Owner Wallet backup from this browser? This does not change the on-chain wallet. Ensure you have your own offline recovery backup.')) return
    try { removeSavedOwnerWallet(); setSaved(false); setReplace(true); setUnlockPassword('') }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not remove the local backup.') }
  }

  return <div role="dialog" aria-modal="true" aria-labelledby="owner-wallet-title" className="owner-vault-backdrop">
    <section className="owner-vault-card">
      <div className="owner-vault-heading"><ShieldCheck/><div><span>TRON TRANSFER · OWNER AUTHENTICATION</span><h2 id="owner-wallet-title">Independent Owner Wallet</h2><p>Local Mainnet signing · no TronLink connection required</p></div></div>
      {saved && !replace ? <form onSubmit={unlockWallet}>
        <p className="owner-vault-address">Saved Owner Wallet: <b>{getSavedOwnerWalletAddress()}</b></p>
        <label>Owner vault password<input type="password" autoComplete="current-password" value={unlockPassword} onChange={e=>setUnlockPassword(e.target.value)} required/></label>
        <button className="owner-vault-primary" disabled={busy || !unlockPassword}><LockKeyhole size={16}/>{busy ? 'Unlocking…' : 'Unlock Owner Wallet'}</button>
        <div className="owner-vault-actions"><button type="button" onClick={()=>setReplace(true)}>Replace wallet</button><button type="button" onClick={removeBackup}>Remove encrypted backup</button><button type="button" onClick={onClose}>Close</button></div>
      </form> : <form onSubmit={importWallet}>
        <div className="owner-vault-warning">Import only your existing configured Owner Wallet. The key is encrypted in this browser and is never sent to the Resource API. Browser-local custody is not a hardware wallet or audited HSM.</div>
        <label>Import format<select value={mode} onChange={e=>setMode(e.target.value)}>{modes.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
        <label>{mode === 'private-key' ? 'Owner private key' : mode === 'mnemonic' ? 'Owner recovery phrase' : 'V3 Keystore JSON'}{mode === 'keystore' ? <textarea rows="4" value={credential} onChange={e=>setCredential(e.target.value)} required/> : <textarea rows={mode === 'mnemonic' ? 3 : 2} value={credential} onChange={e=>setCredential(e.target.value)} required autoComplete="off" spellCheck="false"/>}</label>
        {mode === 'keystore' && <label>Keystore password<input type="password" value={keystorePassword} onChange={e=>setKeystorePassword(e.target.value)}/></label>}
        <label>New local vault password (minimum 12 characters)<input type="password" minLength={12} value={vaultPassword} onChange={e=>setVaultPassword(e.target.value)} required autoComplete="new-password"/></label>
        <button className="owner-vault-primary" disabled={busy || !credential || vaultPassword.length < 12}><Upload size={16}/>{busy ? 'Encrypting and verifying…' : 'Import and unlock Owner Wallet'}</button>
        {saved && <button type="button" className="owner-vault-secondary" onClick={()=>{setReplace(false);setCredential('');setVaultPassword('')}}>Cancel replacement</button>}
      </form>}
      {error && <p role="alert" className="owner-vault-error">{error}</p>}
      <p className="owner-vault-footnote"><KeyRound size={14}/> Expected owner address: {EXPECTED_OWNER_ADDRESS}. Every Mainnet transaction must still pass owner permission, resource, zero-TRX-burn and solidified-receipt checks.</p>
    </section>
  </div>
}
