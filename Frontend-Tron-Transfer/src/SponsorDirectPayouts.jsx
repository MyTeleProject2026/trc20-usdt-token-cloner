import { useEffect, useState } from 'react'
import SponsorOrganizationOnboarding from './SponsorOrganizationOnboarding.jsx'
import {
  AlertTriangle, ArrowUpRight, CheckCircle2, ExternalLink, History, RefreshCw,
  ShieldCheck, Wallet, Building2, ClipboardCheck, Send,
} from 'lucide-react'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'https://trc20-usdt-token-cloner-api.onrender.com').replace(/\/+$/, '')
const MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const SESSION_KEY_PREFIX = 'tron-transfer:wallet-identity:v1:'

function shorten(value) {
  return value && value.length > 18 ? value.slice(0, 9) + '…' + value.slice(-7) : value || '—'
}

function formatUnits(value, decimals = 6) {
  try {
    const n = BigInt(String(value ?? '0'))
    const base = 10n ** BigInt(decimals)
    const fraction = (n % base).toString().padStart(decimals, '0').replace(/0+$/, '')
    return (n / base).toString() + (fraction ? '.' + fraction : '')
  } catch {
    return 'Unavailable'
  }
}

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
  if (!response.ok && response.status !== 202) {
    throw new Error(body?.message || body?.error || 'Sponsor-direct API request failed.')
  }
  if (!body || typeof body !== 'object') throw new Error('Sponsor-direct API returned an unreadable response.')
  if (body.success === false && response.status !== 202) throw new Error(body.message || body.error || 'Sponsor-direct API rejected the request.')
  return body
}

function hasExpiredPreparation(request) {
  const expiresAt = Date.parse(request?.expiresAt || '')
  return Number.isFinite(expiresAt) && expiresAt <= Date.now()
}

function statusLabel(status) {
  return ({
    requested: 'Awaiting sponsor',
    prepared: 'Sponsor approval required',
    broadcasting: 'Broadcasting',
    submitted: 'On-chain confirmation pending',
    'outcome-unknown': 'Broadcast outcome being checked',
    'broadcast-rejected': 'Broadcast rejected',
    confirmed: 'On-chain confirmed',
    failed: 'On-chain failed',
    'manual-review': 'Manual review required',
    cancelled: 'Cancelled',
    expired: 'Preparation expired',
  })[status] || status || 'Unknown'
}

function isValidAddress(value, tronWeb) {
  try {
    return ADDRESS_RE.test(String(value || '')) && tronWeb?.isAddress(String(value)) === true
  } catch {
    return false
  }
}

export default function SponsorDirectPayouts({ wallet, ownerSession, mode = 'withdraw' }) {
  const [identitySession, setIdentitySession] = useState(null)
  const [application, setApplication] = useState(null)
  const [snapshot, setSnapshot] = useState(null)
  const [myRequests, setMyRequests] = useState([])
  const [queue, setQueue] = useState([])
  const [applications, setApplications] = useState([])
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [reviewReference, setReviewReference] = useState('')
  const [dailyLimit, setDailyLimit] = useState('')
  const [perPayoutLimit, setPerPayoutLimit] = useState('')
  const [prepared, setPrepared] = useState(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const walletAddress = wallet?.address || ''
  const identityToken = identitySession?.sessionToken || ''
  const identityMatchesWallet = Boolean(identityToken && identitySession?.address === walletAddress)
  const activeSponsor = application?.status === 'active'
  const isOwnerAdmin = Boolean(ownerSession?.sessionToken)

  useEffect(() => {
    let current = true
    setIdentitySession(null)
    setApplication(null)
    setSnapshot(null)
    setMyRequests([])
    setQueue([])
    if (!ADDRESS_RE.test(walletAddress)) return () => { current = false }
    let stored = ''
    try { stored = sessionStorage.getItem(SESSION_KEY_PREFIX + walletAddress) || '' } catch {}
    if (!stored) return () => { current = false }
    api('/api/auth/tron/session', stored)
      .then((result) => {
        if (!current || result.authenticated !== true || result.address !== walletAddress
          || result.network !== 'mainnet' || !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now()) return
        setIdentitySession({ address: result.address, expiresAt: result.expiresAt, sessionToken: stored })
      })
      .catch(() => {
        try { sessionStorage.removeItem(SESSION_KEY_PREFIX + walletAddress) } catch {}
      })
    return () => { current = false }
  }, [walletAddress])

  async function signInWalletIdentity() {
    if (!wallet?.tronWeb?.trx || !walletAddress) throw new Error('Connect an unlocked TronLink Mainnet wallet first.')
    if (wallet.tronWeb.defaultAddress?.base58 && wallet.tronWeb.defaultAddress.base58 !== walletAddress) {
      throw new Error('The selected TronLink account changed. Reconnect the wallet before signing in.')
    }
    if (typeof wallet.tronWeb.trx.signMessageV2 !== 'function') {
      throw new Error('This TronLink version does not expose signMessageV2. Update TronLink and reconnect.')
    }
    const challenge = await api('/api/auth/tron/challenge', null, {
      method: 'POST',
      body: JSON.stringify({ address: walletAddress, network: 'mainnet' }),
    })
    const signature = await wallet.tronWeb.trx.signMessageV2(challenge.message)
    if (typeof signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(signature)) {
      throw new Error('TronLink did not return a valid wallet identity signature.')
    }
    const verified = await api('/api/auth/tron/verify', null, {
      method: 'POST',
      body: JSON.stringify({
        address: walletAddress,
        network: 'mainnet',
        nonce: challenge.nonce,
        signature,
      }),
    })
    if (verified.authenticated !== true || verified.address !== walletAddress
      || verified.network !== 'mainnet' || typeof verified.sessionToken !== 'string') {
      throw new Error('Wallet identity verification failed.')
    }
    const next = {
      address: verified.address,
      expiresAt: verified.expiresAt,
      sessionToken: verified.sessionToken,
    }
    setIdentitySession(next)
    try { sessionStorage.setItem(SESSION_KEY_PREFIX + walletAddress, verified.sessionToken) } catch {}
    setNotice('Wallet identity verified. This message signature does not spend TRX or authorize a payout.')
  }

  async function refresh() {
    setRefreshing(true)
    setError('')
    try {
      if (identityMatchesWallet) {
        const [appResult, mineResult] = await Promise.all([
          api('/api/tron/sponsor-direct/application', identityToken),
          api('/api/tron/sponsor-direct/my-requests', identityToken),
        ])
        setApplication(appResult.application || null)
        setMyRequests(Array.isArray(mineResult.requests) ? mineResult.requests : [])
        if (appResult.application?.status === 'active') {
          const [readiness, queueResult] = await Promise.all([
            api('/api/tron/sponsor-direct/readiness', identityToken),
            api('/api/tron/sponsor-direct/queue', identityToken),
          ])
          setSnapshot(readiness)
          setQueue(Array.isArray(queueResult.requests) ? queueResult.requests : [])
          const ownPrepared = (queueResult.requests || []).find((item) =>
            item.status === 'prepared' && item.sponsorAddress === walletAddress && item.unsignedTransaction)
          if (ownPrepared) setPrepared(ownPrepared)
          else setPrepared(null)
        } else {
          setSnapshot(null)
          setQueue([])
          setPrepared(null)
        }
      } else {
        setApplication(null)
        setSnapshot(null)
        setMyRequests([])
        setQueue([])
        setPrepared(null)
      }
      if (isOwnerAdmin) {
        const adminResult = await api('/api/tron/sponsor-direct/applications', ownerSession.sessionToken)
        setApplications(Array.isArray(adminResult.applications) ? adminResult.applications : [])
      } else {
        setApplications([])
      }
    } catch (cause) {
      setError(cause?.message || 'Could not refresh sponsor-direct status.')
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [identityToken, walletAddress, ownerSession?.sessionToken])

  useEffect(() => {
    if (!identityMatchesWallet || !['withdraw', 'history'].includes(mode)) return undefined
    const interval = window.setInterval(() => {
      void refresh()
    }, 15000)
    return () => window.clearInterval(interval)
  }, [identityMatchesWallet, identityToken, walletAddress, mode])

  async function submitRequest() {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      if (!identityMatchesWallet) throw new Error('Verify your connected wallet identity first.')
      if (!isValidAddress(recipient.trim(), wallet?.tronWeb)) throw new Error('Enter a valid TRON Mainnet recipient address.')
      if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(amount.trim()) || /^0(?:\.0{1,6})?$/.test(amount.trim())) {
        throw new Error('Enter a positive USDT amount with no more than six decimal places.')
      }
      const result = await api('/api/tron/sponsor-direct/requests', identityToken, {
        method: 'POST',
        body: JSON.stringify({
          recipientAddress: recipient.trim(),
          amount: amount.trim(),
          idempotencyKey: crypto.randomUUID(),
        }),
      })
      setRecipient('')
      setAmount('')
      setNotice(result.note || 'Withdrawal request submitted. A sponsor must authorize and fund it.')
      await refresh()
    } catch (cause) {
      setError(cause?.message || 'Could not submit the withdrawal request.')
    } finally {
      setBusy(false)
    }
  }

  async function applyAsSponsor() {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      if (!identityMatchesWallet) throw new Error('Verify the sponsor wallet identity first.')
      const result = await api('/api/tron/sponsor-direct/application', identityToken, {
        method: 'POST',
        body: JSON.stringify({ displayName: displayName.trim(), contactEmail: contactEmail.trim() }),
      })
      setApplication(result.application || null)
      setNotice(result.note || 'Sponsor application submitted for platform review.')
    } catch (cause) {
      setError(cause?.message || 'Could not submit sponsor application.')
    } finally {
      setBusy(false)
    }
  }

  async function prepareRequest(request) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      if (!identityMatchesWallet || !activeSponsor) throw new Error('Connect and authenticate the approved sponsor wallet first.')
      const result = await api('/api/tron/sponsor-direct/requests/' + encodeURIComponent(request.id) + '/prepare', identityToken, {
        method: 'POST',
        body: JSON.stringify({}),
      })
      const item = {
        ...result.request,
        unsignedTransaction: result.unsignedTransaction,
        feeLimitSun: result.feeLimitSun,
        feeCoverage: result.feeCoverage,
      }
      setPrepared(item)
      setNotice(result.note || 'Sponsor transaction prepared. Review the exact details before signing.')
      await refresh()
      setPrepared(item)
    } catch (cause) {
      setError(cause?.message || 'Could not prepare the sponsor payout.')
    } finally {
      setBusy(false)
    }
  }

  async function signAndBroadcast(request) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const item = request || prepared
      if (!item?.id || !item?.unsignedTransaction) throw new Error('Prepare the sponsor payout before signing.')
      if (!identityMatchesWallet || !activeSponsor || walletAddress !== item.sponsorAddress) {
        throw new Error('Only the approved sponsor address that prepared this payment can sign it.')
      }
      if (wallet?.tronWeb?.defaultAddress?.base58 !== item.sponsorAddress) {
        throw new Error('The TronLink account changed. Reconnect the approved sponsor wallet before signing.')
      }
      if (typeof wallet?.tronWeb?.trx?.sign !== 'function') throw new Error('TronLink transaction signer is unavailable.')
      const signedTransaction = await wallet.tronWeb.trx.sign(item.unsignedTransaction)
      if (!signedTransaction || !Array.isArray(signedTransaction.signature) || signedTransaction.signature.length !== 1) {
        throw new Error('TronLink did not return one sponsor signature. No broadcast was attempted.')
      }
      const result = await api('/api/tron/sponsor-direct/requests/' + encodeURIComponent(item.id) + '/broadcast', identityToken, {
        method: 'POST',
        body: JSON.stringify({ signedTransaction }),
      })
      setPrepared(null)
      setNotice(result.note || 'Sponsor-signed transaction submitted. Mainnet confirmation is pending.')
      await refresh()
    } catch (cause) {
      setError(cause?.message || 'Sponsor signing or broadcast failed. Refresh the saved payout status before retrying.')
    } finally {
      setBusy(false)
    }
  }

  async function refreshRequest(id) {
    setBusy(true)
    setError('')
    try {
      const result = await api('/api/tron/sponsor-direct/requests/' + encodeURIComponent(id), identityToken)
      const request = result.request
      setMyRequests((items) => items.map((item) => item.id === id ? request : item))
      setQueue((items) => items.map((item) => item.id === id ? { ...item, ...request } : item))
      setNotice(result.note || 'Payout status refreshed.')
    } catch (cause) {
      setError(cause?.message || 'Could not refresh the payout status.')
    } finally {
      setBusy(false)
    }
  }

  async function reviewApplication(applicationId, decision) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      if (!isOwnerAdmin) throw new Error('Sign in as the platform owner before reviewing sponsor applications.')
      const body = { decision, reviewReference: reviewReference.trim() }
      if (decision === 'approve') {
        body.perPayoutLimit = perPayoutLimit.trim()
        body.dailyLimit = dailyLimit.trim()
      }
      const result = await api('/api/tron/sponsor-direct/applications/' + encodeURIComponent(applicationId) + '/review', ownerSession.sessionToken, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      setReviewReference('')
      setDailyLimit('')
      setPerPayoutLimit('')
      setNotice(result.note || 'Sponsor application reviewed.')
      await refresh()
    } catch (cause) {
      setError(cause?.message || 'Could not review sponsor application.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel owner-withdrawals-page sponsor-direct-page">
      <div className="section-heading">
        <div>
          <span className="eyebrow">TATUM MAINNET · SPONSOR-DIRECT USDT</span>
          <h2>{mode === 'sponsor' ? 'Sponsor treasury & approvals' : mode === 'history' ? 'Sponsored withdrawal history' : 'Request a sponsored USDT withdrawal'}</h2>
          <p>Your personal TronLink wallet is used for identity only when requesting. The approved sponsor's own funded TRON wallet sends and signs the USDT.</p>
        </div>
        <div className="panel-icon"><Building2 /></div>
      </div>

      <div className="notice notice-warning">
        <AlertTriangle size={17} />
        <div>
          <b>Zero-balance requester wallet is supported</b>
          <p>Your wallet does not need USDT or TRX to submit a request. This does not create funds: an approved sponsor must have the actual USDT and sufficient TRON Energy, Bandwidth or TRX, and must approve the exact transfer in its own TronLink wallet.</p>
        </div>
      </div>

      {notice && <div className="notice notice-success" role="status"><CheckCircle2 size={16} /><span>{notice}</span></div>}
      {error && <div className="notice notice-error" role="alert"><AlertTriangle size={16} /><span>{error}</span></div>}

      <div className="owner-session-card">
        <strong><Wallet size={15} /> {identityMatchesWallet ? 'Wallet identity verified' : walletAddress ? 'TronLink connected · identity not verified' : 'Connect TronLink to continue'}</strong>
        <small>{walletAddress ? 'Connected account: ' + walletAddress : 'Open this page in the TronLink DApp browser and connect a Mainnet wallet.'}</small>
        {identitySession && !identityMatchesWallet && <small>The verified identity belongs to a different wallet address. Reconnect or sign in again.</small>}
        {identityMatchesWallet && <small>Identity session expires {new Date(identitySession.expiresAt).toLocaleTimeString()} · no asset spending permission</small>}
        {!identityMatchesWallet && walletAddress && <button className="secondary-button" disabled={busy} onClick={() => {
          setBusy(true); setError(''); setNotice('')
          signInWalletIdentity().catch((cause) => setError(cause?.message || 'Wallet identity sign-in failed.')).finally(() => setBusy(false))
        }}><ShieldCheck size={15} /> Verify wallet identity (message signature)</button>}
        <small className="fine-print">Signing the identity message does not spend TRX, transfer tokens, or authorize sponsor withdrawals.</small>
      </div>

      {mode === 'sponsor' && (
        <SponsorOrganizationOnboarding
          wallet={wallet}
          identityToken={identityToken}
          identityMatchesWallet={identityMatchesWallet}
          ownerSession={ownerSession}
        />
      )}

      {mode !== 'sponsor' && mode !== 'history' && (
        <div className="sponsor-funding-destination">
          <span className="eyebrow">01 / REQUEST A WITHDRAWAL</span>
          <h3>Send to an external TRON wallet or exchange deposit address</h3>
          <p>The address receives official Tether USDT TRC20 directly from the sponsor's wallet. Check the exchange's TRON/TRC20 network, minimum deposit and memo/tag instructions before submitting.</p>
          <div className="withdrawal-form-grid">
            <div className="form-stack">
              <label>External recipient TRON Mainnet address
                <input value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="Recipient address (T…)" autoComplete="off" spellCheck="false" />
              </label>
              <label>USDT withdrawal amount
                <input value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="e.g. 10.00" inputMode="decimal" />
              </label>
              <button className="primary-button" disabled={!identityMatchesWallet || busy} onClick={() => void submitRequest()}>
                <ArrowUpRight size={16} /> Submit sponsored withdrawal request
              </button>
            </div>
            <aside className="withdrawal-eligibility">
              <span className="eyebrow">PAYOUT ROUTING</span>
              <h3>Official Tether USDT TRC20</h3>
              <div className="readiness-checks">
                <span>Network: TRON Mainnet</span>
                <span>Contract: {MAINNET_USDT}</span>
                <span>Requester wallet: identity only</span>
                <span>Sender: approved sponsor wallet</span>
                <span>Routing: automatic matching against authorized sponsor mandates and live funding checks</span>
                <span>Signer: sponsor's TronLink account; sponsor approval is still required</span>
                <span>Broadcast and confirmation: Tatum Mainnet</span>
              </div>
            </aside>
          </div>
        </div>
      )}

      {mode === 'sponsor' && (
        <div className="sponsor-funding-destination">
          <span className="eyebrow">02 / SPONSOR WALLET PARTICIPATION</span>
          <h3>Register a self-custody sponsor wallet</h3>
          {!identityMatchesWallet && <p>Connect the sponsor's own TronLink wallet and verify its identity before applying or managing its sponsorship profile.</p>}
          {identityMatchesWallet && !application && (
            <div className="form-stack">
              <p>An individual can apply using a self-custody TRON wallet; this application does not require company registration documents. Platform review does not constitute legal-entity verification, KYC, or a guarantee of funds.</p>
              <label>Sponsor display name
                <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Name or sponsor label" autoComplete="name" />
              </label>
              <label>Contact email (optional)
                <input value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} type="email" placeholder="you@example.com" autoComplete="email" />
              </label>
              <button className="primary-button" disabled={busy || displayName.trim().length < 2} onClick={() => void applyAsSponsor()}>
                <Building2 size={16} /> Apply as an individual wallet sponsor
              </button>
            </div>
          )}
          {application && (
            <div className="owner-session-card">
              <strong><ShieldCheck size={15} /> Sponsor application: {application.status}</strong>
              <small>Wallet: {application.sponsorAddress}</small>
              <small>Application reference: {application.id}</small>
              {application.status === 'active' && <small>Approved per-payout cap: {formatUnits(application.perPayoutLimitBaseUnits)} USDT · daily cap: {formatUnits(application.dailyLimitBaseUnits)} USDT</small>}
              {application.status === 'pending-review' && <small>Waiting for platform owner review. No payouts can be prepared or signed yet.</small>}
              {application.status === 'declined' && <small>This application was declined. Contact the platform operator for next steps.</small>}
              {application.status === 'suspended' && <small>Sponsor participation is suspended.</small>}
            </div>
          )}
        </div>
      )}

      {mode === 'sponsor' && activeSponsor && (
        <div className="sponsor-funding-destination">
          <div className="section-heading compact">
            <div><span className="eyebrow">03 / LIVE SPONSOR READINESS</span><h3>Actual sponsor treasury balance and resources</h3></div>
            <button className="secondary-button" disabled={refreshing || busy} onClick={() => void refresh()}><RefreshCw size={15} /> Refresh</button>
          </div>
          {!snapshot ? <p className="fine-print">Refresh to read the sponsor wallet's current official USDT, TRX, Energy and Bandwidth from Tatum Mainnet.</p> : (
            <div className="recipient-balance-grid">
              <article className="metric-card"><span>Actual sponsor USDT</span><strong>{formatUnits(snapshot.usdtBalanceBaseUnits)} <small>USDT</small></strong></article>
              <article className="metric-card"><span>Reserved for pending payouts</span><strong>{formatUnits(snapshot.reservedUsdtBaseUnits)} <small>USDT</small></strong></article>
              <article className="metric-card"><span>Available sponsor USDT</span><strong>{formatUnits(snapshot.availableUsdtBaseUnits)} <small>USDT</small></strong></article>
              <article className="metric-card"><span>Sponsor TRX</span><strong>{formatUnits(snapshot.trxBalanceSun)} <small>TRX</small></strong></article>
              <article className="metric-card"><span>Available Energy</span><strong>{snapshot.energyAvailable === null ? 'Unavailable' : Number(snapshot.energyAvailable).toLocaleString()}</strong></article>
              <article className="metric-card"><span>Available Bandwidth</span><strong>{snapshot.bandwidthAvailable === null ? 'Unavailable' : Number(snapshot.bandwidthAvailable).toLocaleString()}</strong></article>
              <article className="metric-card"><span>Daily payout remaining</span><strong>{formatUnits(snapshot.dailyRemainingBaseUnits)} <small>USDT</small></strong></article>
              <article className="metric-card"><span>Per-payout maximum</span><strong>{formatUnits(snapshot.perPayoutLimitBaseUnits)} <small>USDT</small></strong></article>
            </div>
          )}
          <p className="fine-print">The balance shown belongs to the connected sponsor wallet, not to the requester or platform owner. Each payment requires a fresh signature from that sponsor wallet.</p>
          {prepared?.unsignedTransaction && prepared.sponsorAddress === walletAddress && (
            <div className="prepared-review-panel">
              <div className="section-heading compact">
                <div><span className="eyebrow">SPONSOR SIGNATURE REQUIRED</span><h3>Review exact USDT transfer</h3></div>
                <div className="panel-icon"><ShieldCheck /></div>
              </div>
              <div className="readiness-checks">
                <span>Sending sponsor: {prepared.sponsorAddress}</span>
                <span>External recipient: {prepared.recipientAddress}</span>
                <span>Asset: Official USDT TRC20 · TRON Mainnet</span>
                <span>Amount: {formatUnits(prepared.amountBaseUnits)} USDT</span>
                <span>Transaction ID: {prepared.transactionHash || prepared.unsignedTransaction.txID}</span>
                <span>Preparation expires: {prepared.expiresAt ? new Date(prepared.expiresAt).toLocaleString() : 'See TronLink transaction prompt'}</span>
              </div>
              <p className="fine-print">Check the sender, recipient and exact amount. The next action opens the sponsor wallet's own TronLink approval. Nothing is broadcast until the sponsor explicitly approves the transaction.</p>
              {hasExpiredPreparation(prepared)
                ? <button className="secondary-button" disabled={busy || !identityMatchesWallet} onClick={() => void prepareRequest(prepared)}><RefreshCw size={16} /> Refresh expired preparation</button>
                : <button className="primary-button" disabled={busy || !identityMatchesWallet} onClick={() => void signAndBroadcast(prepared)}><Wallet size={16} /> Continue to sponsor TronLink approval</button>}
            </div>
          )}
          <div className="section-heading compact"><div><span className="eyebrow">SPONSOR REQUEST QUEUE</span><h3>Requests awaiting sponsor action</h3></div></div>
          {!queue.length ? <div className="empty-state"><History size={22} /><b>No payout requests available</b><p>New requests appear here for approved sponsors to review.</p></div> : (
            <div className="transaction-list">
              {queue.map((item) => (
                <article className="transaction-row" key={item.id}>
                  <div className="transaction-main">
                    <strong>{formatUnits(item.amountBaseUnits)} USDT</strong>
                    <span>To {item.recipientAddress}</span>
                    <small>Requester: {shorten(item.requesterAddress)}</small>
                    <small>Status: {statusLabel(item.status)}</small>
                    {item.transactionHash && <a href={'https://tronscan.org/#/transaction/' + item.transactionHash} target="_blank" rel="noreferrer">View on TRONSCAN <ExternalLink size={12} /></a>}
                  </div>
                  <div className="transaction-actions">
                    {item.status === 'requested' && <button className="secondary-button" disabled={busy || BigInt(snapshot?.availableUsdtBaseUnits || '0') < BigInt(item.amountBaseUnits)} onClick={() => void prepareRequest(item)}><ClipboardCheck size={15} /> Prepare from sponsor wallet</button>}
                    {item.status === 'prepared' && item.sponsorAddress === walletAddress && item.unsignedTransaction && (hasExpiredPreparation(item)
                      ? <button className="secondary-button" disabled={busy} onClick={() => void prepareRequest(item)}><RefreshCw size={15} /> Refresh expired preparation</button>
                      : <button className="primary-button" disabled={busy} onClick={() => void signAndBroadcast(item)}><Wallet size={15} /> Sign and broadcast</button>)}
                    {['submitted', 'outcome-unknown', 'broadcasting'].includes(item.status) && <button className="secondary-button" disabled={busy} onClick={() => void refreshRequest(item.id)}><RefreshCw size={15} /> Verify Mainnet status</button>}
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      )}

      {mode === 'sponsor' && isOwnerAdmin && (
        <div className="sponsor-funding-destination">
          <div className="section-heading compact">
            <div><span className="eyebrow">04 / PLATFORM OWNER REVIEW</span><h3>Pending sponsor wallet applications</h3></div>
            <button className="secondary-button" disabled={refreshing || busy} onClick={() => void refresh()}><RefreshCw size={15} /> Refresh</button>
          </div>
          {!applications.length ? <div className="empty-state"><ClipboardCheck size={22} /><b>No sponsor applications pending</b></div> : applications.map((item) => (
            <article className="transaction-row" key={item.id}>
              <div className="transaction-main">
                <strong>{item.displayName}</strong>
                <span>{item.sponsorAddress}</span>
                <small>{item.contactEmail || 'No contact email supplied'}</small>
                <small>Application: {item.id}</small>
              </div>
              <div className="form-stack sponsor-review-form">
                <label>Review reference<input value={reviewReference} onChange={(event) => setReviewReference(event.target.value)} placeholder="Internal approval reference" /></label>
                <label>Maximum per payout (USDT)<input value={perPayoutLimit} onChange={(event) => setPerPayoutLimit(event.target.value)} placeholder="e.g. 25" inputMode="decimal" /></label>
                <label>Daily payout limit (USDT)<input value={dailyLimit} onChange={(event) => setDailyLimit(event.target.value)} placeholder="e.g. 100" inputMode="decimal" /></label>
                <div className="button-row">
                  <button className="primary-button" disabled={busy || !reviewReference.trim() || !perPayoutLimit.trim() || !dailyLimit.trim()} onClick={() => void reviewApplication(item.id, 'approve')}><CheckCircle2 size={15} /> Approve wallet participation</button>
                  <button className="outline-button" disabled={busy || !reviewReference.trim()} onClick={() => void reviewApplication(item.id, 'decline')}>Decline</button>
                </div>
              </div>
            </article>
          ))}
          <p className="fine-print">Platform approval confirms only that the owner has allowed this wallet to participate under the displayed spending limits. It does not verify company registration, beneficial ownership, regulatory status or sponsor solvency.</p>
        </div>
      )}

      {(mode === 'withdraw' || mode === 'history') && (
        <div className="sponsor-funding-destination">
          <div className="section-heading compact">
            <div><span className="eyebrow">TATUM MAINNET · REQUEST RECORDS</span><h3><History size={17} /> Your sponsored withdrawal requests</h3></div>
            <button className="secondary-button" disabled={!identityMatchesWallet || refreshing || busy} onClick={() => void refresh()}><RefreshCw size={15} /> Refresh history</button>
          </div>
          {!identityMatchesWallet ? <p className="fine-print">Verify the connected wallet identity to retrieve its request history.</p>
            : !myRequests.length ? <div className="empty-state"><History size={22} /><b>No sponsored withdrawals recorded</b><p>Submitted requests will appear here. Your personal wallet's USDT balance is not used for a sponsor-direct payout.</p></div>
              : <div className="transaction-list">
                {myRequests.map((item) => (
                  <article className="transaction-row" key={item.id}>
                    <div className="transaction-main">
                      <strong>{formatUnits(item.amountBaseUnits)} USDT</strong>
                      <span>To {item.recipientAddress}</span>
                      <small>Status: {statusLabel(item.status)}</small>
                      <small>Sponsor: {item.sponsorAddress ? shorten(item.sponsorAddress) : 'Not assigned'}</small>
                      {item.status === 'requested' && <small>{item.sponsorAddress
                        ? 'Automatically matched using current sponsor funding and fee checks. Waiting for the sponsor to prepare and sign this payout.'
                        : 'No eligible funded sponsor is matched yet. The request remains queued; your wallet is not charged.'}</small>}
                      {item.status === 'requested' && item.sponsorAddress && item.expiresAt && <small>Temporary sponsor reservation expires {new Date(item.expiresAt).toLocaleString()}. If it expires, the request returns to the available sponsor queue.</small>}

                      {item.transactionHash && <a href={'https://tronscan.org/#/transaction/' + item.transactionHash} target="_blank" rel="noreferrer">View on TRONSCAN <ExternalLink size={12} /></a>}
                      {item.status === 'confirmed' && <small>On-chain transfer confirmed; exchange account credit is not independently verified.</small>}
                    </div>
                    <div className="transaction-actions">
                      <button className="secondary-button" disabled={busy} onClick={() => void refreshRequest(item.id)}><RefreshCw size={15} /> Refresh status</button>
                    </div>
                  </article>
                ))}
              </div>}
        </div>
      )}

      <div className="notice notice-warning owner-deposit-warning">
        <AlertTriangle size={17} />
        <div><b>On-chain confirmation is not exchange credit</b><p>A confirmed Transfer event proves that USDT reached the supplied TRON address. It does not prove that an exchange credited the deposit to an account. Exchange credit requires independent exchange-side confirmation.</p></div>
      </div>
    </section>
  )
}
