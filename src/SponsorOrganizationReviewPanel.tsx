import { useState } from 'react'
import { AlertTriangle, CheckCircle2, ClipboardCheck, FileSearch, RefreshCw, ShieldCheck, Wallet, XCircle } from 'lucide-react'
import { TronWeb } from 'tronweb'

type MainnetSession = { address: string; expiresAt: number; sessionToken: string }
type OrganizationApplication = {
  id: string
  sponsorReference: string
  organizationName: string
  businessEmail: string
  jurisdiction: string
  website: string | null
  sponsorWalletAddress: string
  network: 'mainnet'
  requestedRoles: string[]
  status: 'pending-review' | 'in-review' | 'accepted-for-due-diligence' | 'declined' | 'closed'
  reviewReference: string | null
  createdAt: string
  updatedAt: string
  reviewedAt: string | null
}
type Props = {
  wallet: { address: string; privateKey: string } | null
  network: string
  onSelectMainnet: () => void
  onOpenAccount: () => void
}

const API_BASE = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? '' : 'https://trc20-usdt-token-cloner-api.onrender.com')).replace(/\/+$/, '')
const MAINNET_RPC = 'https://api.trongrid.io'
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/

async function apiJson(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers)
  headers.set('Accept', 'application/json')
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(API_BASE + path, {
    ...options,
    headers,
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
  })
  const payload = await response.json().catch(() => null)
  return { response, payload }
}

function formatDate(value: string | null | undefined): string {
  if (!value) return 'Not reviewed'
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toLocaleString() : 'Unavailable'
}

function explainError(error: unknown): string {
  const message = String((error as any)?.message || error || '').trim()
  if (/owner-wallet-not-authorized|owner-wallet-not-configured/i.test(message)) {
    return 'The unlocked wallet is not the owner address authorized by the backend. Unlock the wallet matching OWNER_WALLET_ADDRESS.'
  }
  if (/session-invalid|identity-storage-unavailable/i.test(message)) {
    return 'The owner wallet identity session expired or could not be verified. Sign the owner identity challenge again.'
  }
  return message.slice(0, 260) || 'Sponsor application review failed.'
}

export default function SponsorOrganizationReviewPanel({
  wallet,
  network,
  onSelectMainnet,
  onOpenAccount,
}: Props) {
  const [session, setSession] = useState<MainnetSession | null>(null)
  const [applications, setApplications] = useState<OrganizationApplication[]>([])
  const [reviewReferences, setReviewReferences] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [reviewing, setReviewing] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function loadQueue(active: MainnetSession) {
    const result = await apiJson('/api/treasury/owner/sponsor-organizations?limit=100', {
      headers: { Authorization: 'Bearer ' + active.sessionToken },
    })
    if (!result.response.ok || result.payload?.success !== true || !Array.isArray(result.payload?.applications)) {
      throw new Error(result.payload?.error || 'Could not load the owner sponsor-organization queue.')
    }
    setApplications(result.payload.applications as OrganizationApplication[])
  }

  async function verifyOwnerAndLoad() {
    if (busy) return
    if (!wallet) {
      setError('Unlock the configured owner wallet in Account before reviewing sponsor organizations.')
      return
    }
    if (network !== 'mainnet') {
      setError('Sponsor-organization review requires TRON Mainnet.')
      return
    }
    setBusy(true)
    setError('')
    setNotice('')
    setApplications([])
    setSession(null)
    try {
      const web = new TronWeb({ fullHost: MAINNET_RPC, privateKey: wallet.privateKey } as any) as any
      const address = String(web.defaultAddress?.base58 || '')
      if (!ADDRESS_PATTERN.test(address) || address !== wallet.address || web.isAddress?.(address) !== true) {
        throw new Error('The unlocked wallet address could not be verified locally.')
      }
      const challengeResult = await apiJson('/api/auth/tron/challenge', {
        method: 'POST',
        body: JSON.stringify({ address, network: 'mainnet' }),
      })
      const challenge = challengeResult.payload
      if (!challengeResult.response.ok || challenge?.success !== true || challenge.network !== 'mainnet'
        || typeof challenge.message !== 'string' || typeof challenge.nonce !== 'string'
        || !Number.isFinite(challenge.expiresAt) || challenge.expiresAt <= Date.now()) {
        throw new Error(challenge?.error || 'The owner Mainnet identity challenge could not be created.')
      }

      // Identity signature only. It does not authorize any transaction or payout.
      const signature = await web.trx.signMessageV2(challenge.message)
      if (typeof signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(signature)) {
        throw new Error('The local owner wallet returned an invalid identity signature.')
      }
      const verifiedResult = await apiJson('/api/auth/tron/verify', {
        method: 'POST',
        body: JSON.stringify({ address, network: 'mainnet', nonce: challenge.nonce, signature }),
      })
      const verified = verifiedResult.payload
      if (!verifiedResult.response.ok || verified?.success !== true || verified?.authenticated !== true
        || verified.address !== address || verified.network !== 'mainnet'
        || typeof verified.sessionToken !== 'string'
        || !Number.isFinite(verified.expiresAt) || verified.expiresAt <= Date.now()) {
        throw new Error(verified?.error || 'The owner wallet signature was not accepted.')
      }
      const active: MainnetSession = {
        address,
        expiresAt: verified.expiresAt,
        sessionToken: verified.sessionToken,
      }
      setSession(active)
      await loadQueue(active)
      setNotice('The wallet identity has been verified. This is owner review access only; no budget or payout authority was granted.')
    } catch (caught) {
      setSession(null)
      setApplications([])
      setError(explainError(caught))
    } finally {
      setBusy(false)
    }
  }

  async function reviewApplication(application: OrganizationApplication, status: 'in-review' | 'accepted-for-due-diligence' | 'declined') {
    if (!session || reviewing) return
    const reviewReference = (reviewReferences[application.id] || '').trim()
    if (['accepted-for-due-diligence', 'declined'].includes(status)
      && !/^[A-Za-z0-9._:-]{8,160}$/.test(reviewReference)) {
      setError('Enter an internal review reference (8–160 letters, digits, dots, underscores, colons or hyphens) before an acceptance or decline decision.')
      return
    }
    setReviewing(application.id + ':' + status)
    setError('')
    setNotice('')
    try {
      const result = await apiJson('/api/treasury/owner/sponsor-organizations/' + encodeURIComponent(application.id) + '/review', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + session.sessionToken },
        body: JSON.stringify({ status, reviewReference: reviewReference || null }),
      })
      if (!result.response.ok || result.payload?.success !== true) {
        throw new Error(result.payload?.message || result.payload?.error || 'The review decision was not saved.')
      }
      await loadQueue(session)
      setNotice(status === 'accepted-for-due-diligence'
        ? 'Marked for continued due diligence. This does not authorize a sponsor agreement, liquidity, or payouts.'
        : status === 'declined'
          ? 'The application was declined and the review event was recorded.'
          : 'Application moved into review.')
    } catch (caught) {
      setError(explainError(caught))
    } finally {
      setReviewing('')
    }
  }

  async function disconnect() {
    const current = session
    setSession(null)
    setApplications([])
    setReviewReferences({})
    setNotice('The temporary owner review session has been cleared.')
    if (current) {
      await fetch(API_BASE + '/api/auth/tron/logout', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + current.sessionToken },
        credentials: 'omit',
        cache: 'no-store',
      }).catch(() => undefined)
    }
  }

  return (
    <section className="wallet-vault-transfer-section sponsor-review-panel" aria-labelledby="sponsor-review-heading">
      <div className="wallet-vault-panel-head">
        <span className="wallet-vault-step"><ClipboardCheck size={16} /></span>
        <div>
          <h2 id="sponsor-review-heading">Sponsor organization applications</h2>
          <p>Owner-only review queue. Every applicant must sign with its own Mainnet wallet; this queue does not approve spending.</p>
        </div>
      </div>

      <div className="wallet-vault-transfer-warning" role="note">
        <strong><ShieldCheck size={16} /> Due diligence only — no sponsor activated</strong>
        <p>“Accepted for due diligence” means continue checking legal-entity identity, authorized representatives, wallet mandate, lawful source of funds, and sponsor agreement scope. It does not add liquidity, activate a budget, authorize signing, or enable withdrawals.</p>
      </div>

      {!wallet ? (
        <div className="sponsor-review-locked">
          <Wallet size={19} />
          <div><strong>Unlock the owner wallet first</strong><small>The private key stays on this device and is used only for a wallet identity-message signature.</small></div>
          <button type="button" className="wallet-vault-secondary" onClick={onOpenAccount}>Open Account</button>
        </div>
      ) : network !== 'mainnet' ? (
        <div className="sponsor-review-locked">
          <AlertTriangle size={19} />
          <div><strong>Mainnet is required</strong><small>Use the configured owner wallet on TRON Mainnet to authenticate for the private review queue.</small></div>
          <button type="button" className="wallet-vault-secondary" onClick={onSelectMainnet}>Select Mainnet</button>
        </div>
      ) : !session ? (
        <div className="sponsor-review-connect">
          <p>Authenticate the unlocked wallet against the backend owner allowlist. A successful identity signature creates no transaction and spends no assets.</p>
          <button type="button" className="wallet-vault-primary" disabled={busy} onClick={() => void verifyOwnerAndLoad()}>
            {busy ? <RefreshCw size={16} className="studio-spin" /> : <Wallet size={16} />}
            {busy ? 'Verifying owner wallet…' : 'Sign owner identity & load applications'}
          </button>
        </div>
      ) : (
        <>
          <div className="sponsor-review-session">
            <span><CheckCircle2 size={16} /> Verified owner wallet</span>
            <strong>{session.address}</strong>
            <small>Session expires {formatDate(new Date(session.expiresAt).toISOString())}</small>
            <div>
              <button type="button" className="wallet-vault-secondary" disabled={busy} onClick={() => void loadQueue(session).catch((caught) => setError(explainError(caught)))}><RefreshCw size={14} /> Refresh queue</button>
              <button type="button" className="wallet-vault-secondary" onClick={() => void disconnect()}>Disconnect</button>
            </div>
          </div>

          {applications.length === 0 ? (
            <div className="sponsor-review-empty"><FileSearch size={21} /><strong>No applications found</strong><small>New sponsor organizations can apply through the external sponsor portal link.</small></div>
          ) : (
            <div className="sponsor-review-list">
              {applications.map((application) => (
                <article className="sponsor-review-card" key={application.id}>
                  <div className="sponsor-review-card-head">
                    <div><small>{application.sponsorReference}</small><h3>{application.organizationName}</h3></div>
                    <span className={'sponsor-review-status sponsor-review-status--' + application.status}>{application.status.replaceAll('-', ' ')}</span>
                  </div>
                  <dl className="sponsor-review-details">
                    <div><dt>Business email</dt><dd>{application.businessEmail}</dd></div>
                    <div><dt>Jurisdiction</dt><dd>{application.jurisdiction}</dd></div>
                    <div><dt>Website</dt><dd>{application.website || 'Not supplied'}</dd></div>
                    <div><dt>Requested roles</dt><dd>{application.requestedRoles.map((role) => role.replaceAll('-', ' ')).join(', ')}</dd></div>
                    <div className="sponsor-review-details-wide"><dt>Authenticated Mainnet wallet</dt><dd>{application.sponsorWalletAddress}</dd></div>
                    <div><dt>Submitted</dt><dd>{formatDate(application.createdAt)}</dd></div>
                    <div><dt>Last review</dt><dd>{formatDate(application.reviewedAt)}</dd></div>
                    <div className="sponsor-review-details-wide"><dt>Internal review reference</dt><dd>{application.reviewReference || 'Not assigned'}</dd></div>
                  </dl>
                  {['pending-review', 'in-review', 'accepted-for-due-diligence'].includes(application.status) && (
                    <div className="sponsor-review-actions">
                      <label>Internal case reference<input
                        value={reviewReferences[application.id] || ''}
                        onChange={(event) => setReviewReferences((current) => ({ ...current, [application.id]: event.target.value }))}
                        placeholder="e.g. sponsor-case-2026-01"
                        maxLength={160}
                      /></label>
                      <div>
                        {application.status === 'pending-review' && (
                          <button type="button" className="wallet-vault-secondary" disabled={Boolean(reviewing)} onClick={() => void reviewApplication(application, 'in-review')}>
                            {reviewing === application.id + ':in-review' ? <RefreshCw size={14} className="studio-spin" /> : <FileSearch size={14} />} Mark in review
                          </button>
                        )}
                        {application.status !== 'accepted-for-due-diligence' && (
                          <button type="button" className="wallet-vault-primary" disabled={Boolean(reviewing)} onClick={() => void reviewApplication(application, 'accepted-for-due-diligence')}>
                            {reviewing === application.id + ':accepted-for-due-diligence' ? <RefreshCw size={14} className="studio-spin" /> : <CheckCircle2 size={14} />} Continue due diligence
                          </button>
                        )}
                        <button type="button" className="wallet-vault-danger" disabled={Boolean(reviewing)} onClick={() => void reviewApplication(application, 'declined')}>
                          {reviewing === application.id + ':declined' ? <RefreshCw size={14} className="studio-spin" /> : <XCircle size={14} />} Decline
                        </button>
                      </div>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </>
      )}

      {error && <p className="wallet-vault-risk-note" role="alert">{error}</p>}
      {notice && <p className="wallet-vault-caption" role="status">{notice}</p>}
      <p className="wallet-vault-caption">No approval here authorizes a sponsor to supply money, makes any wallet a treasury, creates a budget, or permits a payout. Those require separate signed legal authority, exact-scope agreement approval, on-chain funding checks, and independent signer controls.</p>
    </section>
  )
}
