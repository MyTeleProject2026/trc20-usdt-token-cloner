import { useEffect, useState } from 'react'
import './owner-wallet-access.css'
import { LockKeyhole, ShieldCheck } from 'lucide-react'
import { createManagedWalletAuthClient } from './managed-wallet-auth-client.mjs'

const ownerAuth = createManagedWalletAuthClient({ role: 'owner' })
const EXPECTED_OWNER_ADDRESS = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'

export default function OwnerWalletAccess({ onUnlock, onClose }) {
  const [enrolled, setEnrolled] = useState(null)
  const [password, setPassword] = useState('')
  const [enrollmentToken, setEnrollmentToken] = useState('')
  const [recoveryToken, setRecoveryToken] = useState('')
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
          ? 'Sign in to the existing backend-managed Owner account.'
          : 'First-time enrollment is available only with the one-time token configured on the Resource API.')
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
        await ownerAuth.recoverPassword(recoveryToken.trim(), password)
        setPassword(''); setRecoveryToken(''); setRecoveryMode(false); setEnrolled(true)
        setMessage('Password recovery completed. All previous Owner sessions were revoked. Sign in with the new password.')
        return
      }
      const result = enrolled
        ? await ownerAuth.login(password)
        : await ownerAuth.enroll(password, enrollmentToken.trim())
      if (result.address !== EXPECTED_OWNER_ADDRESS) {
        await ownerAuth.logout().catch(() => {})
        throw new Error('The authenticated backend Owner address does not match the configured TRӾ owner.')
      }
      setPassword('')
      setEnrollmentToken('')
      onUnlock({
        address: result.address,
        managedSession: true,
        signerType: 'backend-managed-owner',
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
      <div className="owner-vault-heading"><ShieldCheck/><div><span>TRON TRANSFER · OWNER AUTHENTICATION</span><h2 id="owner-wallet-title">Backend-managed Owner</h2><p>Password session · TRON Mainnet · no browser private key</p></div></div>
      <div className="owner-vault-warning">The Owner private key remains in the Resource API environment. Never paste a private key, recovery phrase or keystore into this page. Contract signing remains disabled until the authenticated backend operation and Mainnet preflight path is enabled.</div>
      <p className="owner-vault-address">{message}</p>
      <form onSubmit={submit}>
        {!enrolled && <label>One-time Owner enrollment token<input type="password" autoComplete="off" value={enrollmentToken} onChange={event => setEnrollmentToken(event.target.value)} required/></label>}
        <label>Owner account password<input type="password" autoComplete={enrolled ? 'current-password' : 'new-password'} minLength={12} value={password} onChange={event => setPassword(event.target.value)} required/></label>
        <button className="owner-vault-primary" disabled={busy || password.length < 12 || enrolled === null || (!enrolled && enrollmentToken.length < 32)}><LockKeyhole size={16}/>{busy ? 'Authenticating…' : enrolled ? 'Sign in to Owner workspace' : 'Enroll Owner password'}</button>
        <div className="owner-vault-actions"><button type="button" onClick={onClose}>Close</button></div>
      </form>
      {error && <p role="alert" className="owner-vault-error">{error}</p>}
      <p className="owner-vault-footnote">Configured Owner: {EXPECTED_OWNER_ADDRESS}. The password authenticates a backend session; it is not a wallet key and cannot change the on-chain owner. Recovery requires an operator-generated one-time token from the Resource API; the token expires after 30 minutes and is single-use.</p>
    </section>
  </div>
}
