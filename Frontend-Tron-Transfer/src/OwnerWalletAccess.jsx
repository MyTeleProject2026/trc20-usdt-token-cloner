import { useEffect, useState } from 'react'
import './owner-wallet-access.css'
import { LockKeyhole, ShieldCheck } from 'lucide-react'
import { createManagedWalletAuthClient } from './managed-wallet-auth-client.mjs'
import { discoverTronLinkProvider, requestTronLinkConnection } from './tronlink-provider.mjs'

const ownerAuth = createManagedWalletAuthClient({ role: 'owner' })
const EXPECTED_OWNER_ADDRESS = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'

export default function OwnerWalletAccess({ onUnlock, onClose }) {
  const [enrolled, setEnrolled] = useState(null)
  const [password, setPassword] = useState('')
  const [enrollmentToken, setEnrollmentToken] = useState('')
  const [recoveryToken, setRecoveryToken] = useState('')
  const [confirmRecoveryPassword, setConfirmRecoveryPassword] = useState('')
  const [recoveryMode, setRecoveryMode] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('Checking backend Owner account…')

  useEffect(() => {
    let active = true
    ownerAuth.status()
      .then(result => {
        if (!active) return
        setEnrolled(Boolean(result.enrolled))
        setMessage(result.enrolled
          ? 'Sign in to the existing Owner account, then connect its TronLink wallet.'
          : 'First-time enrollment uses the one-time token configured on the Resource API, then connects the matching TronLink wallet.')
      })
      .catch(cause => {
        if (!active) return
        setEnrolled(false)
        setError(cause?.message || 'OWNER_AUTH_STATUS_UNAVAILABLE')
        setMessage('The backend Owner account could not be reached.')
      })
    return () => { active = false }
  }, [])

  async function submit(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (recoveryMode) {
        if (password.length < 12 || password !== confirmRecoveryPassword || recoveryToken.trim().length < 32) throw new Error('Enter a valid recovery token and matching new password of at least 12 characters.')
        await ownerAuth.recoverPassword(recoveryToken.trim(), password)
        setPassword(''); setRecoveryToken(''); setConfirmRecoveryPassword(''); setRecoveryMode(false); setEnrolled(true)
        setMessage('Password recovery completed. All previous Owner sessions were revoked. Sign in with the new password.')
        return
      }
      const result = enrolled
        ? await ownerAuth.login(password)
        : await ownerAuth.enroll(password, enrollmentToken.trim())
      if (result.address !== EXPECTED_OWNER_ADDRESS) {
        await ownerAuth.logout().catch(() => {})
        throw new Error('The authenticated Owner account does not match the configured TRӾ Mainnet owner.')
      }
      const provider = await discoverTronLinkProvider(window)
      if (!provider) {
        await ownerAuth.logout().catch(() => {})
        throw new Error("TronLink was not detected. Open Tron Transfer in TronLink's DApp browser, unlock the configured Owner wallet, and try again.")
      }
      const connection = await requestTronLinkConnection(provider, window)
      if (connection.address !== EXPECTED_OWNER_ADDRESS || connection.address !== result.address
        || connection.tronWeb?.defaultAddress?.base58 !== EXPECTED_OWNER_ADDRESS) {
        await ownerAuth.logout().catch(() => {})
        throw new Error('The active TronLink signing address does not match the authenticated Owner account. No transaction was signed.')
      }
      setPassword('')
      setEnrollmentToken('')
      onUnlock({
        address: result.address,
        managedSession: true,
        signerType: 'tronlink-owner',
        tronWeb: connection.tronWeb,
        provider: connection.provider,
        authClient: ownerAuth,
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Owner authentication failed.')
    } finally {
      setBusy(false)
    }
  }

  return <div role="dialog" aria-modal="true" aria-labelledby="owner-wallet-title" className="owner-vault-backdrop">
    <section className="owner-vault-card">
      <div className="owner-vault-heading"><ShieldCheck/><div><span>TRON TRANSFER · OWNER AUTHENTICATION</span><h2 id="owner-wallet-title">Owner workspace access</h2><p>Password access · TronLink transaction approval · TRON Mainnet</p></div></div>
      <div className="owner-vault-warning">Your Owner password authenticates the application session. TronLink holds the signing key and must approve every transaction separately. Never paste a private key, recovery phrase or keystore into this page.</div>
      <p className="owner-vault-address">{message}</p>
      <form onSubmit={submit}>
        {!enrolled && !recoveryMode && <label>One-time Owner enrollment token<input type="password" autoComplete="off" value={enrollmentToken} onChange={event => setEnrollmentToken(event.target.value)} required/></label>}
        {recoveryMode && <label>One-time Owner recovery token<input type="password" autoComplete="off" value={recoveryToken} onChange={event => setRecoveryToken(event.target.value)} required/></label>}
        <label>{recoveryMode ? 'New Owner account password' : 'Owner account password'}<input type="password" autoComplete={recoveryMode || !enrolled ? 'new-password' : 'current-password'} minLength={12} value={password} onChange={event => setPassword(event.target.value)} required/></label>
        {recoveryMode && <label>Confirm new Owner password<input type="password" autoComplete="new-password" minLength={12} value={confirmRecoveryPassword} onChange={event => setConfirmRecoveryPassword(event.target.value)} required/></label>}
        <button className="owner-vault-primary" disabled={busy || password.length < 12 || enrolled === null || (recoveryMode ? recoveryToken.length < 32 || confirmRecoveryPassword !== password : !enrolled && enrollmentToken.length < 32)}><LockKeyhole size={16}/>{busy ? 'Working…' : recoveryMode ? 'Recover Owner password' : enrolled ? 'Sign in to Owner workspace' : 'Enroll Owner password'}</button>
        <div className="owner-vault-actions">{enrolled && <button type="button" onClick={() => {setRecoveryMode(value => !value);setPassword('');setRecoveryToken('');setConfirmRecoveryPassword('')}}>{recoveryMode ? 'Back to Owner login' : 'Recover Owner password'}</button>}<button type="button" onClick={onClose}>Close</button></div>
      </form>
      {error && <p role="alert" className="owner-vault-error">{error}</p>}
      <p className="owner-vault-footnote">Configured Owner: {EXPECTED_OWNER_ADDRESS}. The password authenticates the Owner application session; TronLink separately approves each on-chain transaction and remains the transaction signer. Recovery requires an operator-generated one-time token from the Resource API; the token expires after 30 minutes and is single-use.</p>
    </section>
  </div>
}
