import { useEffect, useRef, useState } from 'react'
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
  const [ownerOverview, setOwnerOverview] = useState(null)
  const [ownerFundingLedger, setOwnerFundingLedger] = useState(null)
  const [fundingLedgerError, setFundingLedgerError] = useState('')
  const [fundingDepositTxHash, setFundingDepositTxHash] = useState('')
  const [fundingDepositFromAddress, setFundingDepositFromAddress] = useState('')
  const [fundingDepositAmount, setFundingDepositAmount] = useState('')
  const [fundingLedgerBusy, setFundingLedgerBusy] = useState(false)
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
  const [lastRefreshAt, setLastRefreshAt] = useState(null)
  const refreshInFlightRef = useRef(null)

  const walletAddress = wallet?.address || ''
  const identityToken = identitySession?.sessionToken || ''
  const identityMatchesWallet = Boolean(identityToken && identitySession?.address === walletAddress)
  const activeSponsor = application?.status === 'active'
  // Owner review is available only when both the private owner session and the exact
  // configured owner wallet identity are present. The API token for review is the
  // wallet-auth session, not the separate password-only owner-console session.
  const isOwnerAdmin = Boolean(ownerSession?.sessionToken && identityMatchesWallet
    && walletAddress === ownerSession.address)

  useEffect(() => {
    let current = true
    setIdentitySession(null)
    setApplication(null)
    setSnapshot(null)
    setMyRequests([])
    setQueue([])
    setOwnerOverview(null)
    setOwnerFundingLedger(null)
    setFundingLedgerError('')
    setLastRefreshAt(null)
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

  async function refresh({ silent = false } = {}) {
    if (refreshInFlightRef.current) return refreshInFlightRef.current

    const operation = (async () => {
      setRefreshing(true)
      if (!silent) setError('')
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
          if (isOwnerAdmin) {
            const [adminResult, overviewResult] = await Promise.all([
              api('/api/tron/sponsor-direct/applications', identityToken),
              api('/api/tron/sponsor-direct/owner-overview', identityToken),
            ])
            setApplications(Array.isArray(adminResult.applications) ? adminResult.applications : [])
            setOwnerOverview(overviewResult)
            await refreshOwnerFundingLedger()
          } else {
            setApplications([])
            setOwnerOverview(null)
            setOwnerFundingLedger(null)
            setFundingLedgerError('')
          }
          setLastRefreshAt(Date.now())
        } else {
          setApplication(null)
          setSnapshot(null)
          setMyRequests([])
          setQueue([])
          setPrepared(null)
          setApplications([])
          setOwnerOverview(null)
          setOwnerFundingLedger(null)
          setLastRefreshAt(null)
        }
      } catch (cause) {
        setError(cause?.message || 'Could not refresh sponsor-direct status.')
      } finally {
        setRefreshing(false)
      }
    })()

    refreshInFlightRef.current = operation
    try {
      return await operation
    } finally {
      if (refreshInFlightRef.current === operation) refreshInFlightRef.current = null
    }
  }

  useEffect(() => {
    void refresh()
  }, [identityToken, walletAddress, ownerSession?.sessionToken])

  // Keep live status fresh while the app is open. Pause polling in a background
  // tab to avoid unnecessary provider calls, then refresh immediately on return.
  useEffect(() => {
    if (!identityMatchesWallet || !['withdraw', 'history', 'sponsor'].includes(mode)) return undefined
    let stopped = false
    const runIfActive = () => {
      if (stopped || document.visibilityState !== 'visible' || !navigator.onLine) return
      void refresh({ silent: true })
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') runIfActive()
    }
    const interval = window.setInterval(runIfActive, 15000)
    window.addEventListener('focus', runIfActive)
    window.addEventListener('online', runIfActive)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      stopped = true
      window.clearInterval(interval)
      window.removeEventListener('focus', runIfActive)
      window.removeEventListener('online', runIfActive)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [identityMatchesWallet, identityToken, walletAddress, ownerSession?.sessionToken, mode])

  async function refreshOwnerFundingLedger() {
    if (!isOwnerAdmin || !identityMatchesWallet) return
    setFundingLedgerError('')
    try {
      const result = await api('/api/treasury/owner/funding-ledger?network=mainnet', identityToken)
      if (result.success !== true || result.network !== 'mainnet'
        || typeof result.onChainBalanceBaseUnits !== 'string'
        || typeof result.availableBaseUnits !== 'string') {
        throw new Error(result.message || result.error || 'Verified treasury funding ledger is unavailable.')
      }
      setOwnerFundingLedger(result)
    } catch (cause) {
      setOwnerFundingLedger(null)
      setFundingLedgerError(cause?.message || 'Could not load verified treasury funding.')
    }
  }

  async function verifyIncomingTreasuryDeposit() {
    if (!isOwnerAdmin || !identityMatchesWallet) {
      setFundingLedgerError('Verify the configured platform-owner wallet before recording a treasury deposit.')
      return
    }
    setFundingLedgerBusy(true)
    setFundingLedgerError('')
    try {
      const result = await api('/api/treasury/owner/funding-ledger/deposits/verify', identityToken, {
        method: 'POST',
        body: JSON.stringify({
          network: 'mainnet',
          transactionHash: fundingDepositTxHash.trim(),
          fromAddress: fundingDepositFromAddress.trim(),
          amount: fundingDepositAmount.trim(),
        }),
      })
      if (result.success !== true || result.credited !== true) {
        throw new Error(result.message || result.error || 'Incoming transfer was not verified.')
      }
      setFundingDepositTxHash('')
      setFundingDepositFromAddress('')
      setFundingDepositAmount('')
      await refreshOwnerFundingLedger()
      setNotice(result.duplicate
        ? 'This exact solidified Mainnet USDT transfer is already recorded; no duplicate credit was added.'
        : 'Incoming Mainnet USDT transfer verified and recorded. The live treasury balance and payout reservations have been refreshed.')
    } catch (cause) {
      setFundingLedgerError(cause?.message || 'Incoming Mainnet deposit verification failed.')
    } finally {
      setFundingLedgerBusy(false)
    }
  }

  async function submitRequest() {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      if (!identityMatchesWallet) throw new Error('Verify your connected wallet identity first.')
      if (ownerSession?.address && walletAddress !== ownerSession.address) throw new Error('Connect the configured platform-owner wallet before submitting a withdrawal request.')
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
        feeSnapshot: result.snapshot || null,
      }
      setPrepared({
        ...item,
        feeSnapshot: result.snapshot || null,
        signingAllowed: result.signingAllowed !== false && result.feeCoverage?.covered === true,
      })
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
          <h2>{mode === 'sponsor' ? (isOwnerAdmin ? 'Sponsor wallet approvals' : 'Sponsor treasury & approvals') : mode === 'history' ? 'Sponsored withdrawal history' : 'Request a sponsored USDT withdrawal'}</h2>
          <p>{mode === 'sponsor' ? 'The connected sponsor wallet is the actual USDT sender. It must hold the requested tokens and cover its own TRON network resources, then sign each exact transfer.' : 'Your personal TronLink wallet is used for owner identity only. A separate, approved sponsor wallet holds the USDT and signs each exact transfer.'}</p>
        </div>
        <div className="panel-icon"><Building2 /></div>
      </div>

      <div className="notice notice-warning">
        <AlertTriangle size={17} />
        <div>
          <b>{mode === 'sponsor' ? 'Sponsor funding stays under sponsor control' : 'Zero-balance owner identity wallet is supported'}</b>
          <p>{mode === 'sponsor' ? 'A sponsor must already hold the actual USDT amount and enough TRON Energy, Bandwidth or TRX for the transfer. The sponsor wallet is the sender and must explicitly sign the exact recipient and amount. The platform does not supply funds.' : 'The owner identity wallet does not need USDT or TRX to submit a request. This does not create funds: an approved sponsor must hold the actual USDT and sufficient TRON resources, then approve the exact transfer in its own TronLink wallet.'}</p>
        </div>
      </div>

      {notice && <div className="notice notice-success" role="status"><CheckCircle2 size={16} /><span>{notice}</span></div>}
      {error && <div className="notice notice-error" role="alert"><AlertTriangle size={16} /><span>{error}</span></div>}

      <p className="fine-print" role="status" aria-live="polite">
        {refreshing
          ? 'Refreshing live Mainnet balances and withdrawal status…'
          : lastRefreshAt
            ? 'Background refresh active · Last checked ' + new Date(lastRefreshAt).toLocaleTimeString() + ' · updates every 15 seconds while this page is visible.'
            : identityMatchesWallet
              ? 'Loading live Mainnet balances and withdrawal status…'
              : 'Connect TronLink and verify the wallet identity to load live Mainnet balances and withdrawal status.'}
      </p>

      {isOwnerAdmin && mode !== 'sponsor' && ownerOverview && (
        <div className="notice notice-warning" role="status">
          <AlertTriangle size={17} />
          <div>
            <b>Mainnet sponsor funding availability</b>
            <p>{ownerOverview.funding?.message || 'Sponsor funding status is unavailable. No payout should be assumed ready.'}</p>
            <div className="readiness-checks">
              <span>Approved individual sponsor wallets: {ownerOverview.sponsorProfiles?.approved ?? '—'}</span>
              <span>Applications awaiting owner review: {ownerOverview.sponsorProfiles?.pendingReview ?? '—'}</span>
              <span>Withdrawal requests awaiting a sponsor: {ownerOverview.withdrawals?.awaitingSponsor ?? '—'}</span>
              <span>Matched requests awaiting sponsor signature: {ownerOverview.withdrawals?.matchedAwaitingSignature ?? '—'}</span>
              <span>Submitted / awaiting chain reconciliation: {ownerOverview.withdrawals?.submittedOrReconciling ?? '—'}</span>
              <span>On-chain confirmed: {ownerOverview.withdrawals?.confirmed ?? '—'}</span>
            </div>
            <small className="fine-print">An approved wallet profile is not proof of USDT funds. Every payout requires a fresh live Mainnet balance/resource check and the sponsor's exact transaction signature. This application permits individual wallet applications without company registration documents or a required contact email; it does not perform KYC/KYB.</small>
          </div>
        </div>
      )}

      {isOwnerAdmin && mode !== 'sponsor' && (
        <div className="sponsor-funding-destination">
          <span className="eyebrow">TREASURY FUNDING · VERIFIED MAINNET INFLOWS</span>
          <h3>Incoming official USDT funding ledger</h3>
          <p>Record an incoming payment only after it has reached the configured treasury address. The backend independently verifies the solidified Mainnet transaction and exact official Tether USDT Transfer event before recording it.</p>
          <div className="withdrawal-form-grid">
            <div className="form-stack">
              <label>Incoming transaction hash
                <input value={fundingDepositTxHash} onChange={(event) => setFundingDepositTxHash(event.target.value)} placeholder="64-character Mainnet transaction hash" autoComplete="off" spellCheck="false" />
              </label>
              <label>External sender TRON address
                <input value={fundingDepositFromAddress} onChange={(event) => setFundingDepositFromAddress(event.target.value)} placeholder="T..." autoComplete="off" spellCheck="false" />
              </label>
              <label>Received amount (USDT)
                <input value={fundingDepositAmount} onChange={(event) => setFundingDepositAmount(event.target.value)} placeholder="e.g. 25.00" inputMode="decimal" />
              </label>
              <button className="primary-button" disabled={fundingLedgerBusy || busy || !fundingDepositTxHash.trim() || !fundingDepositFromAddress.trim() || !fundingDepositAmount.trim()} onClick={() => void verifyIncomingTreasuryDeposit()}>
                <ShieldCheck size={15} /> {fundingLedgerBusy ? 'Verifying solidified Mainnet transfer…' : 'Verify and record incoming USDT'}
              </button>
            </div>
            <aside className="withdrawal-eligibility">
              <span className="eyebrow">LIVE TREASURY ACCOUNTING</span>
              {ownerFundingLedger ? (
                <div className="readiness-checks">
                  <span>Verified live on-chain USDT: {formatUnits(ownerFundingLedger.onChainBalanceBaseUnits)} USDT</span>
                  <span>Active payout reservations: {formatUnits(ownerFundingLedger.reservedBaseUnits)} USDT</span>
                  <span>Unreserved on-chain balance: {formatUnits(ownerFundingLedger.availableBaseUnits)} USDT</span>
                  <span>Verified inflows recorded: {formatUnits(ownerFundingLedger.totalVerifiedInboundBaseUnits)} USDT</span>
                  <span>Observed treasury TRX: {ownerFundingLedger.native?.status === 'verified' ? formatUnits(ownerFundingLedger.native.balanceSun) + ' TRX' : 'Unavailable'}</span>
                  <span>Payout execution gate: {ownerFundingLedger.payoutSubmissionEnabled === true ? 'Enabled by the authorized payout flow' : 'Locked until a sender is approved, current fee coverage is verified and the sender signs the exact transfer'}</span>
                </div>
              ) : <p className="fine-print">Treasury balance is not yet verified. Refresh after the owner wallet identity has been verified.</p>}
              <button className="secondary-button" disabled={fundingLedgerBusy || refreshing} onClick={() => void refreshOwnerFundingLedger()}>
                <RefreshCw size={15} /> Refresh treasury funding
              </button>
            </aside>
          </div>
          {fundingLedgerError && <div className="notice notice-error" role="alert"><AlertTriangle size={15} /><span>{fundingLedgerError}</span></div>}
          <p className="fine-print">This ledger never creates USDT or TRX. Available USDT is the live on-chain treasury balance less active sponsor payout reservations. It does not verify source-of-funds compliance or authorize a withdrawal. The treasury wallet must separately be approved as a sponsor and sign each exact outgoing transaction.</p>
          {ownerFundingLedger?.entries?.length > 0 && (
            <div className="transaction-list">
              {ownerFundingLedger.entries.map((entry) => (
                <article className="transaction-row" key={entry.transactionHash + ':' + entry.logIndex}>
                  <div className="transaction-main">
                    <strong>{formatUnits(entry.amountBaseUnits)} USDT received</strong>
                    <span>From {shorten(entry.fromAddress)} · block {entry.blockNumber} · event {entry.logIndex}</span>
                    <small>{entry.verifiedAt ? new Date(entry.verifiedAt).toLocaleString() : 'Verified time unavailable'}</small>
                    <a href={'https://tronscan.org/#/transaction/' + entry.transactionHash} target="_blank" rel="noreferrer">View verified Mainnet transaction <ExternalLink size={12} /></a>
                  </div>
                  <span className="status-pill status-success">SOLIDIFIED</span>
                </article>
              ))}
            </div>
          )}
          {ownerFundingLedger && !ownerFundingLedger.entries?.length && <p className="fine-print">No verified incoming USDT transfer events have been recorded yet.</p>}
        </div>
      )}

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
                <span>Routing: automatic matching against owner-approved individual sponsor wallets and live funding checks</span>
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
          {mode === 'sponsor' && isOwnerAdmin && (
            <div className="owner-session-card">
              <strong><ShieldCheck size={15} /> Platform owner review mode</strong>
              <small>Connect and verify the exact configured owner wallet to review sponsor applications and set conservative per-payout and daily caps. Invite sponsors through the separate #/sponsor portal.</small>
            </div>
          )}
          {ownerSession?.sessionToken && walletAddress && walletAddress !== ownerSession.address && (
            <div className="notice notice-warning" role="alert">
              <AlertTriangle size={16} />
              <span>Connect the configured platform-owner wallet ({shorten(ownerSession.address)}) to create withdrawal requests or review sponsor applications.</span>
            </div>
          )}
          {identityMatchesWallet && !application && !isOwnerAdmin && (
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
                <span>USDT principal to recipient: {formatUnits(prepared.amountBaseUnits)} USDT</span>
                <span>Network-cost preflight: {prepared.feeCoverage?.covered === true ? 'Passed' : 'Not verified / insufficient — signing blocked'}</span>
                <span>Coverage path: {prepared.feeCoverage?.method === 'verified-energy-and-bandwidth' ? 'Energy and Bandwidth resources cover the transfer' : prepared.feeCoverage?.method === 'mixed-resource-and-trx-reserve' ? 'Resources plus sponsor TRX reserve cover the transfer' : 'Not covered'}</span>
                {prepared.feeCoverage?.energyRequired !== null && prepared.feeCoverage?.energyRequired !== undefined && <span>Buffered Energy requirement: {Number(prepared.feeCoverage.energyRequired).toLocaleString()} Energy</span>}
                {prepared.feeCoverage?.energyTrxReserveSun !== null && prepared.feeCoverage?.energyTrxReserveSun !== undefined && <span>Estimated Energy shortfall reserve: {formatUnits(prepared.feeCoverage.energyTrxReserveSun)} TRX</span>}
                {prepared.feeCoverage?.bandwidthRequired !== null && prepared.feeCoverage?.bandwidthRequired !== undefined && <span>Estimated signed transaction Bandwidth: {Number(prepared.feeCoverage.bandwidthRequired).toLocaleString()} bytes</span>}
                {prepared.feeCoverage?.bandwidthCoverageMethod && <span>Bandwidth payment method: {prepared.feeCoverage.bandwidthCoverageMethod}</span>}
                {prepared.feeCoverage?.bandwidthTrxReserveSun !== null && prepared.feeCoverage?.bandwidthTrxReserveSun !== undefined && <span>Estimated Bandwidth reserve: {formatUnits(prepared.feeCoverage.bandwidthTrxReserveSun)} TRX</span>}
                {prepared.feeCoverage?.totalTrxReserveSun !== null && prepared.feeCoverage?.totalTrxReserveSun !== undefined && <span>Estimated total TRX reserve for uncovered resources: {formatUnits(prepared.feeCoverage.totalTrxReserveSun)} TRX</span>}
                {prepared.feeSnapshot?.trxBalanceSun !== null && prepared.feeSnapshot?.trxBalanceSun !== undefined && <span>Observed sponsor TRX balance: {formatUnits(prepared.feeSnapshot.trxBalanceSun)} TRX</span>}
                {prepared.feeLimitSun && <span>Transaction fee_limit: {formatUnits(prepared.feeLimitSun)} TRX maximum caller Energy budget (not total fee)</span>}
                {prepared.feeCoverage?.energyBudgetRequiredSun && <span>Buffered Energy budget required by live price: {formatUnits(prepared.feeCoverage.energyBudgetRequiredSun)} TRX</span>}
                <span>Transaction ID: {prepared.transactionHash || prepared.unsignedTransaction.txID}</span>
                <span>Preparation expires: {prepared.expiresAt ? new Date(prepared.expiresAt).toLocaleString() : 'See TronLink transaction prompt'}</span>
              </div>
              <p className="fine-print">The sponsor wallet supplies the USDT principal and its own TRON network resources or TRX. The fee_limit caps the caller's Energy budget only; it is not a total network fee quote or an upfront charge. The backend separately estimates Energy and Bandwidth shortfalls from current Mainnet chain prices. Actual usage can differ, and failed contract execution can still consume resources. The requester’s zero-balance wallet is not charged.</p>
              <p className="fine-print">Check the sender, recipient, exact USDT amount and fee_limit in TronLink before approving. Signing is blocked unless the latest fee preflight passes. Nothing is broadcast until the sponsor explicitly signs this exact transaction.</p>
              {hasExpiredPreparation(prepared)
                ? <button className="secondary-button" disabled={busy || !identityMatchesWallet} onClick={() => void prepareRequest(prepared)}><RefreshCw size={16} /> Refresh expired preparation</button>
                : <button className="primary-button" disabled={busy || !identityMatchesWallet || prepared.feeCoverage?.covered !== true} onClick={() => void signAndBroadcast(prepared)}><Wallet size={16} /> Continue to sponsor TronLink approval</button>}
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
                    {item.status === 'prepared' && item.sponsorAddress === walletAddress && item.unsignedTransaction && (
                      <button className="secondary-button" disabled={busy} onClick={() => void prepareRequest(item)}>
                        <ClipboardCheck size={15} /> {hasExpiredPreparation(item) ? 'Refresh expired preparation' : 'Refresh fee check and review'}
                      </button>
                    )}
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
