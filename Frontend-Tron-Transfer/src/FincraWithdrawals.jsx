import { useEffect, useState } from 'react'
import { ArrowUpRight, CheckCircle2, RefreshCw, ShieldCheck, AlertTriangle, Wallet } from 'lucide-react'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'https://trc20-usdt-token-cloner-api.onrender.com').replace(/\/+$/, '')
const SESSION_PREFIX = 'tron-transfer:fincra-requester-session:v1:'
const ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/

async function api(path, token, options = {}) {
  const response = await fetch(API_BASE + path, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(options.headers || {}),
    },
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
  })
  const body = await response.json().catch(() => null)
  if (!body || typeof body !== 'object') throw new Error('The payout API returned an unreadable response.')
  if (!response.ok && response.status !== 202) throw new Error(body.message || body.error || 'Payout API request failed.')
  if (body.success === false && response.status !== 202) throw new Error(body.message || body.error || 'Payout API request failed.')
  return body
}

function displayStatus(request) {
  if (request.fincraStatus === 'successful' && request.chainVerificationStatus === 'solidified-recipient-transfer-verified') return 'Mainnet transfer verified'
  if (request.fincraStatus === 'successful') return 'Provider reports successful · chain check pending'
  if (request.fincraStatus === 'failed') return 'Payout failed'
  if (request.fincraStatus === 'processing' || request.status === 'fincra-submitting') return 'Provider processing'
  if (request.status === 'fincra-outcome-unknown') return 'Outcome being reconciled · do not resubmit'
  return request.status || 'Request recorded'
}

export default function FincraWithdrawals({ wallet, mode = 'withdraw' }) {
  const walletAddress = wallet?.address || ''
  const [session, setSession] = useState(null)
  const [recipient, setRecipient] = useState('')
  const [beneficiaryName, setBeneficiaryName] = useState('')
  const [beneficiaryEmail, setBeneficiaryEmail] = useState('')
  const [amount, setAmount] = useState('')
  const [requests, setRequests] = useState([])
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const identityMatchesWallet = Boolean(session?.address === walletAddress && session?.sessionToken)

  async function refresh(token = session?.sessionToken) {
    if (!token) { setRequests([]); return }
    setRefreshing(true)
    try {
      const result = await api('/api/tron-transfer/sponsor-requests/mine', token)
      let rows = Array.isArray(result.requests) ? result.requests : []
      const pending = rows.filter((request) => String(request.status || '').startsWith('fincra-')
        && !['successful', 'failed'].includes(request.fincraStatus)).slice(0, 5)
      await Promise.allSettled(pending.map((request) => api(
        '/api/tron-transfer/sponsor-requests/' + encodeURIComponent(request.id) + '/fincra-status',
        token, { method: 'POST', body: JSON.stringify({}) },
      )))
      const afterStatus = await api('/api/tron-transfer/sponsor-requests/mine', token)
      rows = Array.isArray(afterStatus.requests) ? afterStatus.requests : rows
      const needsChainCheck = rows.filter((request) => request.fincraStatus === 'successful'
        && request.chainVerificationStatus !== 'solidified-recipient-transfer-verified').slice(0, 5)
      await Promise.allSettled(needsChainCheck.map((request) => api(
        '/api/tron-transfer/sponsor-requests/' + encodeURIComponent(request.id) + '/verify-recipient-transfer',
        token, { method: 'POST', body: JSON.stringify({}) },
      )))
      const latest = await api('/api/tron-transfer/sponsor-requests/mine', token)
      setRequests(Array.isArray(latest.requests) ? latest.requests : rows)
    } catch (cause) {
      setError(cause?.message || 'Could not load your withdrawal history.')
    } finally { setRefreshing(false) }
  }

  useEffect(() => {
    let current = true
    setSession(null)
    setRequests([])
    if (!ADDRESS_RE.test(walletAddress)) return () => { current = false }
    let token = ''
    try { token = sessionStorage.getItem(SESSION_PREFIX + walletAddress) || '' } catch {}
    if (!token) return () => { current = false }
    api('/api/auth/tron/session', token)
      .then((result) => {
        if (!current || result.authenticated !== true || result.address !== walletAddress
          || result.network !== 'mainnet' || !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now()) return
        setSession({ address: result.address, expiresAt: result.expiresAt, sessionToken: token })
      })
      .catch(() => { try { sessionStorage.removeItem(SESSION_PREFIX + walletAddress) } catch {} })
    return () => { current = false }
  }, [walletAddress])

  useEffect(() => {
    if (!identityMatchesWallet || !session?.sessionToken) return undefined
    void refresh(session.sessionToken)
    const interval = window.setInterval(() => { void refresh(session.sessionToken) }, 30000)
    return () => window.clearInterval(interval)
  }, [identityMatchesWallet, session?.sessionToken])

  async function verifyIdentity() {
    setBusy(true); setError(''); setNotice('')
    try {
      if (!wallet?.tronWeb?.trx || !walletAddress) throw new Error('Connect your TronLink Mainnet wallet first.')
      if (wallet.tronWeb.defaultAddress?.base58 && wallet.tronWeb.defaultAddress.base58 !== walletAddress) {
        throw new Error('The selected TronLink account changed. Reconnect before continuing.')
      }
      if (typeof wallet.tronWeb.trx.signMessageV2 !== 'function') throw new Error('TronLink message signing is unavailable.')
      const challenge = await api('/api/auth/tron/challenge', null, {
        method: 'POST', body: JSON.stringify({ address: walletAddress, network: 'mainnet' }),
      })
      const signature = await wallet.tronWeb.trx.signMessageV2(challenge.message)
      if (typeof signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(signature)) throw new Error('TronLink did not return a valid identity signature.')
      const verified = await api('/api/auth/tron/verify', null, {
        method: 'POST', body: JSON.stringify({ address: walletAddress, network: 'mainnet', nonce: challenge.nonce, signature }),
      })
      if (verified.authenticated !== true || verified.address !== walletAddress
        || verified.network !== 'mainnet' || typeof verified.sessionToken !== 'string') throw new Error('Wallet identity verification failed.')
      const next = { address: verified.address, expiresAt: verified.expiresAt, sessionToken: verified.sessionToken }
      setSession(next)
      try { sessionStorage.setItem(SESSION_PREFIX + walletAddress, verified.sessionToken) } catch {}
      setNotice('Wallet identity verified. This signature does not spend funds or authorize the sponsor.')
      await refresh(verified.sessionToken)
    } catch (cause) { setError(cause?.message || 'Wallet identity verification failed.') }
    finally { setBusy(false) }
  }

  async function submitExistingRequest(request) {
    setBusy(true); setError(''); setNotice('')
    try {
      if (!identityMatchesWallet) throw new Error('Verify your connected wallet identity first.')
      if (request.requesterAddress !== walletAddress) throw new Error('This payout request does not belong to the connected wallet.')
      if (request.status !== 'pending-organization-review' || request.fincraStatus) {
        throw new Error('Only a payout request that has never been submitted to Fincra can be retried. Submitted or ambiguous payouts must be reconciled.')
      }
      const result = await api('/api/tron-transfer/sponsor-requests/' + encodeURIComponent(request.id) + '/fincra-payout',
        session.sessionToken, { method: 'POST', body: JSON.stringify({}) })
      setNotice(result.note || 'The existing request was sent to Fincra. Wait for provider and Mainnet verification.')
      await refresh()
    } catch (cause) { setError(cause?.message || 'Could not submit the existing payout request.') }
    finally { setBusy(false) }
  }

  async function submitRequest() {
    setBusy(true); setError(''); setNotice('')
    try {
      if (!identityMatchesWallet) throw new Error('Verify your connected wallet identity first.')
      if (!wallet?.tronWeb?.isAddress?.(recipient.trim())) throw new Error('Enter a valid TRON Mainnet recipient address.')
      if (!beneficiaryName.trim()) throw new Error('Enter the beneficiary name required by the payout provider.')
      if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(amount.trim()) || /^0(?:\.0{1,6})?$/.test(amount.trim())) {
        throw new Error('Enter a positive USDT amount with no more than six decimal places.')
      }
      const created = await api('/api/tron-transfer/sponsor-requests', session.sessionToken, {
        method: 'POST',
        body: JSON.stringify({
          recipientAddress: recipient.trim(),
          beneficiaryName: beneficiaryName.trim(),
          beneficiaryEmail: beneficiaryEmail.trim(),
          amount: amount.trim(),
          customerReference: 'tt-' + crypto.randomUUID(),
        }),
      })
      setRecipient(''); setBeneficiaryName(''); setBeneficiaryEmail(''); setAmount('')
      const id = created.request?.id
      if (!id) throw new Error('The request was not assigned a payout reference.')
      try {
        const payout = await api('/api/tron-transfer/sponsor-requests/' + encodeURIComponent(id) + '/fincra-payout',
          session.sessionToken, { method: 'POST', body: JSON.stringify({}) })
        setNotice(payout.note || 'Payout submission reached Fincra. Settlement is still pending verification.')
      } catch (cause) {
        setNotice('Request saved (' + created.request.customerReference + '), but automatic payout was not submitted: '
          + (cause?.message || 'provider authorization or funding is not ready.'))
      }
      await refresh()
    } catch (cause) { setError(cause?.message || 'Could not submit the withdrawal request.') }
    finally { setBusy(false) }
  }

  return (
    <section className="panel owner-withdrawals-page fincra-payout-page">
      <div className="section-heading">
        <div><span className="eyebrow">FINCRA PAYOUT · TATUM MAINNET VERIFICATION</span>
          <h2>{mode === 'history' ? 'Sponsored USDT payout history' : 'Request a sponsored USDT withdrawal'}</h2>
          <p>TronLink is used only to prove requester identity. An authorized Fincra business account supplies the actual USDT principal; Tatum provides TRON Mainnet recipient checks and chain verification.</p>
        </div>
        <div className="panel-icon"><ShieldCheck /></div>
      </div>
      <div className="notice notice-warning">
        <AlertTriangle size={17} />
        <div><b>Automatic payout is bounded by a standing sponsor mandate</b>
          <p>No new sponsor wallet prompt is required for each payout only when the sponsor has signed and the platform has independently authorized a Fincra automatic mandate for the exact business ID, asset, amount caps and validity. The Fincra account must be live-enabled and funded. An on-chain transfer to an exchange deposit address does not prove exchange internal credit. Your wallet identity signature is not spending authorization.</p>
        </div>
      </div>
      {notice && <div className="notice notice-success" role="status"><CheckCircle2 size={16} /><span>{notice}</span></div>}
      {error && <div className="notice notice-error" role="alert"><AlertTriangle size={16} /><span>{error}</span></div>}
      <div className="owner-session-card">
        <strong><Wallet size={15} /> {identityMatchesWallet ? 'Requester identity verified' : walletAddress ? 'TronLink connected · identity not verified' : 'Connect TronLink to continue'}</strong>
        <small>{walletAddress || 'No wallet connected'}</small>
        {!identityMatchesWallet && <button className="primary-button" disabled={busy || !walletAddress} onClick={() => void verifyIdentity()}>Sign identity message</button>}
      </div>
      {mode !== 'history' && identityMatchesWallet && (
        <div className="sponsor-funding-destination">
          <h3>Withdrawal details</h3>
          <label>Recipient TRON Mainnet address<input value={recipient} onChange={(e) => setRecipient(e.target.value)} autoComplete="off" placeholder="T..." /></label>
          <label>Beneficiary / account holder name<input value={beneficiaryName} onChange={(e) => setBeneficiaryName(e.target.value)} maxLength={120} placeholder="Name required by payout provider" /></label>
          <label>Beneficiary email (optional)<input type="email" value={beneficiaryEmail} onChange={(e) => setBeneficiaryEmail(e.target.value)} maxLength={254} placeholder="name@example.com" /></label>
          <label>USDT TRC20 amount<input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" /></label>
          <button className="primary-button" disabled={busy || !recipient.trim() || !beneficiaryName.trim() || !amount.trim()} onClick={() => void submitRequest()}><ArrowUpRight size={16} /> Submit and attempt authorized automatic payout</button>
          <p className="fine-print">A saved request is not a payment. If automatic authorization, live provider enablement, recipient preflight or balance checks fail, the request remains recorded and no payout is reported as successful.</p>
        </div>
      )}
      <div className="sponsor-funding-destination">
        <div className="section-heading compact"><h3>Your payout requests</h3><button className="secondary-button" disabled={refreshing || !identityMatchesWallet} onClick={() => void refresh()}><RefreshCw size={14} /> Refresh</button></div>
        {!identityMatchesWallet ? <p className="fine-print">Verify your wallet identity to view request history.</p> : !requests.length ? <p className="fine-print">No payout requests recorded for this wallet.</p> : requests.map((request) => (
          <article className="transaction-row" key={request.id}>
            <div className="transaction-main">
              <strong>{request.amount} USDT · {displayStatus(request)}</strong>
              <span>To: {request.recipientAddress}</span>
              <small>Reference: {request.customerReference}</small>
              {request.fincraReference && <small>Fincra reference: {request.fincraReference}</small>}
              {request.transactionHash && <small>Transaction: {request.transactionHash}</small>}
              {request.chainVerificationStatus && <small>Chain evidence: {request.chainVerificationStatus}</small>}
              <small>{new Date(request.createdAt).toLocaleString()}</small>
            </div>
            {request.status === 'pending-organization-review' && !request.fincraStatus && (
              <div className="transaction-actions">
                <button className="outline-button" disabled={busy} onClick={() => void submitExistingRequest(request)}>
                  <ArrowUpRight size={14} /> Retry authorized payout
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  )
}
