import { useCallback, useEffect, useMemo, useState } from 'react'
import { TronWeb } from 'tronweb'
import { AlertTriangle, CheckCircle2, RefreshCw, Send, ShieldCheck } from 'lucide-react'

type MainnetRequest = {
  id: string
  idempotencyKey: string
  requesterAddress?: string
  recipientAddress: string
  network: 'mainnet'
  asset: 'USDT'
  tokenContract: string
  amountBaseUnits: string
  decimals: 6
  status: string
  createdAt: string
  sponsorApproval?: { status?: string; organizationReference?: string; expiresAt?: string } | null
  feeSponsorApproval?: { status?: string; organizationReference?: string; maxFeeSun?: string; expiresAt?: string } | null
}

type WalletSession = { token: string; expiresAt: number }
type Readiness = {
  success?: boolean
  status?: string
  checkedAt?: string
  readOnly?: boolean
  preflightReady?: boolean
  mainnetExecutionDisabled?: boolean
  canCreateSigningIntent?: boolean
  canSubmitSponsoredTransfer?: boolean
  blockers?: string[]
  sponsorRoles?: {
    networkFeeSponsor?: { addressConfigured?: boolean; onChainBalanceRead?: boolean; resourceRead?: boolean; agreementScopeConfigured?: boolean }
    assetPrincipalSponsor?: { addressConfigured?: boolean; onChainBalanceRead?: boolean; officialUsdtBalanceVerified?: boolean; agreementScopeConfigured?: boolean }
    addressesDistinct?: boolean
    feeResourceDelegationTransactionAuditVerified?: boolean
  }
  database?: { configured?: boolean; ready?: boolean }
}

type Challenge = { nonce: string; message: string; expiresAt: string; request: MainnetRequest }
type ApiResult<T> = { response: Response; payload: T | null }

const OFFICIAL_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const MAINNET_RPC = 'https://api.trongrid.io'
const REQUEST_KEY_PREFIX = 'tron-token-studio:mainnet-direct-request:v1:'
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const KEY_PATTERN = /^[A-Za-z0-9._:-]{24,160}$/

function toUsdtBaseUnits(input: string): string | null {
  const value = input.trim()
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(value)) return null
  const parts = value.split('.')
  try {
    const whole = BigInt(parts[0])
    const fraction = BigInt(((parts[1] || '') + '000000').slice(0, 6))
    const base = whole * 1_000_000n + fraction
    return base > 0n && base < (1n << 256n) ? base.toString() : null
  } catch {
    return null
  }
}

function formatUsdt(baseUnits: string): string {
  try {
    const value = BigInt(baseUnits)
    const whole = value / 1_000_000n
    const fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
    return whole.toString() + (fraction ? '.' + fraction : '')
  } catch {
    return 'Unavailable'
  }
}

function errorText(payload: any, fallback: string): string {
  const reason = typeof payload?.message === 'string' ? payload.message
    : typeof payload?.error === 'string' ? payload.error
      : typeof payload?.reason === 'string' ? payload.reason : ''
  return reason ? reason.replaceAll('-', ' ') : fallback
}

export default function DirectSponsorPayouts({
  apiBase,
  walletAddress,
  privateKey,
}: {
  apiBase: string
  walletAddress: string
  privateKey: string
}) {
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('1.00')
  const [session, setSession] = useState<WalletSession | null>(null)
  const [requestKey, setRequestKey] = useState('')
  const [requestStatus, setRequestStatus] = useState<any>(null)
  const [requestBusy, setRequestBusy] = useState(false)
  const [requestError, setRequestError] = useState('')
  const [requestNotice, setRequestNotice] = useState('')
  const [readiness, setReadiness] = useState<Readiness | null>(null)
  const [readinessError, setReadinessError] = useState('')
  const [readinessLoading, setReadinessLoading] = useState(false)
  const [principalQueue, setPrincipalQueue] = useState<MainnetRequest[]>([])
  const [feeQueue, setFeeQueue] = useState<MainnetRequest[]>([])
  const [queueError, setQueueError] = useState('')
  const [queueNotice, setQueueNotice] = useState('')
  const [reviewBusy, setReviewBusy] = useState('')
  const [activeChallenge, setActiveChallenge] = useState<Challenge | null>(null)
  const [activeChallengeRole, setActiveChallengeRole] = useState<'principal' | 'fee' | null>(null)
  const [showSponsorTools, setShowSponsorTools] = useState(false)

  const baseUrl = apiBase.replace(/\/+$/, '')
  const amountBaseUnits = useMemo(() => toUsdtBaseUnits(amount), [amount])
  const requestRecord = requestStatus?.request as MainnetRequest | undefined

  const api = useCallback(async <T,>(
    path: string,
    options: { method?: 'GET' | 'POST'; token?: string; body?: unknown } = {},
  ): Promise<ApiResult<T>> => {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'
    if (options.token) headers.Authorization = 'Bearer ' + options.token
    const response = await fetch(baseUrl + path, {
      method: options.method || 'GET',
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
    })
    const payload = await response.json().catch(() => null) as T | null
    return { response, payload }
  }, [baseUrl])

  const makeSigner = useCallback(() => {
    if (!ADDRESS_PATTERN.test(walletAddress) || !/^(?:0x)?[0-9a-f]{64}$/i.test(privateKey)) {
      throw new Error('Unlock a valid local TRON wallet before using sponsor requests.')
    }
    const signer = new TronWeb({ fullHost: MAINNET_RPC, privateKey: privateKey.replace(/^0x/i, '') }) as any
    if (String(signer.defaultAddress?.base58 || '') !== walletAddress) {
      throw new Error('The unlocked private key does not match the displayed local wallet address.')
    }
    return signer
  }, [privateKey, walletAddress])

  const authenticate = useCallback(async (): Promise<string> => {
    if (session && session.expiresAt > Date.now() + 15_000) return session.token
    const signer = makeSigner()
    const challengeResult = await api<any>('/api/auth/tron/challenge', {
      method: 'POST',
      body: { address: walletAddress, network: 'mainnet' },
    })
    const challenge = challengeResult.payload
    if (!challengeResult.response.ok || challenge?.success !== true
      || typeof challenge.message !== 'string' || typeof challenge.nonce !== 'string') {
      throw new Error(errorText(challenge, 'The backend could not create a secure Mainnet wallet-identity challenge.'))
    }
    const signature = await signer.trx.signMessageV2(challenge.message)
    if (typeof signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(signature)) {
      throw new Error('The local wallet did not return a valid identity signature.')
    }
    const verifiedResult = await api<any>('/api/auth/tron/verify', {
      method: 'POST',
      body: { address: walletAddress, network: 'mainnet', nonce: challenge.nonce, signature },
    })
    const verified = verifiedResult.payload
    if (!verifiedResult.response.ok || verified?.success !== true || verified?.authenticated !== true
      || verified.address !== walletAddress || verified.network !== 'mainnet'
      || typeof verified.sessionToken !== 'string' || !Number.isFinite(Number(verified.expiresAt))) {
      throw new Error(errorText(verified, 'The backend did not verify this wallet identity or could not store the short-lived session.'))
    }
    const next = { token: verified.sessionToken as string, expiresAt: Number(verified.expiresAt) }
    setSession(next)
    return next.token
  }, [api, makeSigner, session, walletAddress])

  const refreshReadiness = useCallback(async () => {
    setReadinessLoading(true)
    setReadinessError('')
    try {
      const result = await api<Readiness>('/api/tron/sponsorship/mainnet-direct/readiness?refresh=1')
      const payload = result.payload
      if (!result.response.ok || payload?.success !== true || payload.network !== 'mainnet' || payload.readOnly !== true) {
        throw new Error(errorText(payload, 'Mainnet sponsor diagnostics could not be read.'))
      }
      setReadiness(payload)
    } catch (error) {
      setReadiness(null)
      setReadinessError(error instanceof Error ? error.message : 'Mainnet sponsor diagnostics are unavailable.')
    } finally {
      setReadinessLoading(false)
    }
  }, [api])

  useEffect(() => {
    let saved = ''
    try { saved = window.localStorage.getItem(REQUEST_KEY_PREFIX + walletAddress) || '' } catch {}
    if (KEY_PATTERN.test(saved)) setRequestKey(saved)
    setSession(null)
    setRequestStatus(null)
    setPrincipalQueue([])
    setFeeQueue([])
    setReadiness(null)
  }, [walletAddress])

  useEffect(() => {
    let cancelled = false
    let inFlight = false
    const refreshWhenVisible = () => {
      if (cancelled || document.visibilityState === 'hidden' || inFlight) return
      inFlight = true
      void refreshReadiness().finally(() => { inFlight = false })
    }
    refreshWhenVisible()
    const interval = window.setInterval(refreshWhenVisible, 30_000)
    window.addEventListener('focus', refreshWhenVisible)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      cancelled = true
      window.clearInterval(interval)
      window.removeEventListener('focus', refreshWhenVisible)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [refreshReadiness])

  async function submitRequest() {
    if (requestBusy) return
    setRequestBusy(true)
    setRequestError('')
    setRequestNotice('')
    try {
      const signer = makeSigner()
      if (!signer.isAddress(recipient.trim()) || recipient.trim() === walletAddress) {
        throw new Error('Enter a valid TRON recipient address different from your requester wallet.')
      }
      if (!amountBaseUnits) throw new Error('Enter a positive USDT amount with up to six decimal places.')
      if (typeof window.crypto?.randomUUID !== 'function') throw new Error('Secure request identifiers are unavailable in this browser.')
      const token = await authenticate()
      // A saved idempotency key may outlive the current component state. Look
      // it up before creating anything new so a reload cannot silently orphan
      // a pending request or cause a second sponsor review for the same input.
      if (requestKey && !requestRecord) {
        const existing = await api<any>(
          '/api/tron/sponsorship/mainnet-direct/requests/' + encodeURIComponent(requestKey),
          { token },
        )
        if (existing.response.ok && existing.payload?.success === true) {
          setRequestStatus(existing.payload)
          setRequestNotice('Recovered the existing saved request. No new sponsor request was created; review its status below.')
          return
        }
        if (existing.response.status !== 404) {
          throw new Error(errorText(existing.payload, 'Could not safely check the saved request reference. No new request was submitted.'))
        }
      }
      const idempotencyKey = requestKey && (!requestRecord
        || (requestRecord.recipientAddress === recipient.trim()
          && requestRecord.amountBaseUnits === amountBaseUnits))
        ? requestKey : window.crypto.randomUUID()
      const result = await api<any>('/api/tron/sponsorship/mainnet-direct/requests', {
        method: 'POST',
        token,
        body: {
          idempotencyKey,
          recipientAddress: recipient.trim(),
          tokenContract: OFFICIAL_USDT,
          amountBaseUnits,
          decimals: 6,
        },
      })
      const payload = result.payload
      if (!result.response.ok || payload?.success !== true
        || payload?.request?.idempotencyKey !== idempotencyKey) {
        throw new Error(errorText(payload, 'The sponsor review request could not be stored.'))
      }
      setRequestKey(idempotencyKey)
      try { window.localStorage.setItem(REQUEST_KEY_PREFIX + walletAddress, idempotencyKey) } catch {}
      setRequestStatus(payload)
      setRequestNotice(payload.duplicate === true
        ? 'The existing matching request was found. No second request or payment was created.'
        : 'Request stored for sponsor review. No USDT was reserved, signed or broadcast.')
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : 'Sponsor review request failed.')
    } finally {
      setRequestBusy(false)
    }
  }

  async function lookupRequest() {
    if (!requestKey || !KEY_PATTERN.test(requestKey)) {
      setRequestError('There is no valid saved sponsor request reference for this wallet.')
      return
    }
    setRequestBusy(true)
    setRequestError('')
    setRequestNotice('')
    try {
      const token = await authenticate()
      const result = await api<any>('/api/tron/sponsorship/mainnet-direct/requests/' + encodeURIComponent(requestKey), { token })
      if (!result.response.ok || result.payload?.success !== true) {
        throw new Error(errorText(result.payload, 'The saved sponsor request could not be found or checked.'))
      }
      setRequestStatus(result.payload)
      setRequestNotice('Saved request status refreshed. Approval status is shown separately from any transfer; this workflow still cannot broadcast.')
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : 'Sponsor request lookup failed.')
    } finally {
      setRequestBusy(false)
    }
  }

  async function loadQueue(role: 'principal' | 'fee') {
    setReviewBusy(role + '-queue')
    setQueueError('')
    setQueueNotice('')
    try {
      const token = await authenticate()
      const path = role === 'principal'
        ? '/api/tron/sponsorship/mainnet-direct/review-queue?limit=50'
        : '/api/tron/sponsorship/mainnet-direct/fee-review-queue?limit=50'
      const result = await api<any>(path, { token })
      if (!result.response.ok || result.payload?.success !== true || !Array.isArray(result.payload.requests)) {
        throw new Error(errorText(result.payload, role === 'principal'
          ? 'This wallet is not authorized for the configured USDT principal sponsor queue.'
          : 'This wallet is not authorized for the separately configured network-fee sponsor queue.'))
      }
      if (role === 'principal') setPrincipalQueue(result.payload.requests)
      else setFeeQueue(result.payload.requests)
      setQueueNotice(role === 'principal'
        ? 'Principal sponsor queue loaded. Review each recipient and amount before signing a request-specific approval statement.'
        : 'Fee sponsor queue loaded. A valid principal approval must already exist before fee approval can be requested.')
    } catch (error) {
      if (role === 'principal') setPrincipalQueue([])
      else setFeeQueue([])
      setQueueError(error instanceof Error ? error.message : 'Sponsor review queue is unavailable.')
    } finally {
      setReviewBusy('')
    }
  }

  async function approveRequest(request: MainnetRequest, role: 'principal' | 'fee') {
    if (reviewBusy) return
    setReviewBusy(role + '-approve')
    setQueueError('')
    setQueueNotice('')
    setActiveChallenge(null)
    setActiveChallengeRole(null)
    try {
      const token = await authenticate()
      const encodedKey = encodeURIComponent(request.idempotencyKey)
      const challengePath = role === 'principal'
        ? '/api/tron/sponsorship/mainnet-direct/requests/' + encodedKey + '/approval-challenge'
        : '/api/tron/sponsorship/mainnet-direct/requests/' + encodedKey + '/fee-approval-challenge'
      const challengeResult = await api<any>(challengePath, { method: 'POST', token })
      const challenge = challengeResult.payload
      if (!challengeResult.response.ok || challenge?.success !== true
        || typeof challenge.nonce !== 'string' || typeof challenge.message !== 'string') {
        throw new Error(errorText(challenge, 'The exact sponsor approval challenge could not be prepared.'))
      }
      setActiveChallenge({ nonce: challenge.nonce, message: challenge.message, expiresAt: challenge.expiresAt, request })
      setActiveChallengeRole(role)
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : 'Sponsor approval challenge failed.')
    } finally {
      setReviewBusy('')
    }
  }

  async function signApproval() {
    if (!activeChallenge || !activeChallengeRole || reviewBusy) return
    setReviewBusy(activeChallengeRole + '-sign')
    setQueueError('')
    try {
      if (Date.parse(activeChallenge.expiresAt) <= Date.now()) throw new Error('This one-time sponsor challenge has expired. Prepare a new challenge.')
      const signer = makeSigner()
      const signature = await signer.trx.signMessageV2(activeChallenge.message)
      if (typeof signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(signature)) {
        throw new Error('The local sponsor wallet did not return a valid signature.')
      }
      const token = await authenticate()
      const encodedKey = encodeURIComponent(activeChallenge.request.idempotencyKey)
      const endpoint = activeChallengeRole === 'principal'
        ? '/api/tron/sponsorship/mainnet-direct/requests/' + encodedKey + '/approve'
        : '/api/tron/sponsorship/mainnet-direct/requests/' + encodedKey + '/approve-fees'
      const result = await api<any>(endpoint, {
        method: 'POST',
        token,
        body: { nonce: activeChallenge.nonce, signature },
      })
      if (!result.response.ok || result.payload?.success !== true) {
        throw new Error(errorText(result.payload, 'Sponsor approval was not accepted by the backend.'))
      }
      setActiveChallenge(null)
      setActiveChallengeRole(null)
      setQueueNotice(activeChallengeRole === 'principal'
        ? 'Principal approval was recorded for this exact request only. Funds remain unreserved and no transaction was signed or broadcast.'
        : 'Fee approval was recorded for this exact request only. TRX/resources remain unreserved and no transaction was signed or broadcast.')
      await loadQueue(activeChallengeRole)
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : 'Sponsor approval could not be completed.')
    } finally {
      setReviewBusy('')
    }
  }

  return (
    <div className="wallet-vault-direct-sponsor">
      <section className="wallet-vault-panel wallet-vault-sponsor-route-intro">
        <div className="wallet-vault-panel-head">
          <span className="wallet-vault-step"><Send size={16} /></span>
          <div>
            <h2>Direct sponsor-to-recipient USDT</h2>
            <p>Your unlocked local wallet proves requester identity only. An independently authorized sponsor wallet would send genuine Mainnet USDT directly to the recipient; your personal wallet is not used as payout principal.</p>
          </div>
        </div>
        <div className="wallet-vault-transfer-warning" role="note">
          <strong>Request and approvals are available; actual payment execution is not</strong>
          <p>This workflow can store a request and verify request-specific sponsor approval messages. It does not reserve USDT or TRX, create a transaction, sign a transaction, or broadcast to TRON. Mainnet sponsored execution remains hard-disabled until the missing transaction, reservation and reconciliation path has been implemented and independently released.</p>
        </div>
        <div className="wallet-vault-review-grid">
          <div><small>Requester wallet</small><strong>{walletAddress}</strong></div>
          <div><small>Asset / network</small><strong>Official Tether USDT · TRON Mainnet</strong></div>
          <div className="wallet-vault-review-wide"><small>Official USDT contract</small><strong>{OFFICIAL_USDT}</strong></div>
          <div><small>Identity session</small><strong>{session && session.expiresAt > Date.now() ? 'Verified until ' + new Date(session.expiresAt).toLocaleTimeString() : 'Sign on first request or review action'}</strong></div>
        </div>
      </section>

      <section className="wallet-vault-panel">
        <div className="wallet-vault-panel-head">
          <span className="wallet-vault-step">01</span>
          <div><h2>Mainnet sponsor readiness</h2><p>Automatically refreshed read-only diagnostics. These checks do not establish legal authority or permission to spend.</p></div>
          <button type="button" className="wallet-vault-secondary" disabled={readinessLoading} onClick={() => void refreshReadiness()}><RefreshCw size={15} /> {readinessLoading ? 'Refreshing…' : 'Refresh'}</button>
        </div>
        {readinessError && <p className="wallet-vault-risk-note" role="alert">{readinessError}</p>}
        {readiness && (
          <>
            <div className="wallet-vault-review-grid">
              <div><small>Diagnostics</small><strong>{readiness.status || 'Unavailable'}</strong></div>
              <div><small>Last checked</small><strong>{readiness.checkedAt ? new Date(readiness.checkedAt).toLocaleString() : 'Not recorded'}</strong></div>
              <div><small>Database</small><strong>{readiness.database?.ready === true ? 'Ready' : 'Not ready'}</strong></div>
              <div><small>Distinct sponsor wallets</small><strong>{readiness.sponsorRoles?.addressesDistinct === true ? 'Verified' : 'Not verified'}</strong></div>
              <div><small>USDT principal balance</small><strong>{readiness.sponsorRoles?.assetPrincipalSponsor?.officialUsdtBalanceVerified === true ? 'Positive balance verified' : 'Not verified'}</strong></div>
              <div><small>Network-fee sponsor resources</small><strong>{readiness.sponsorRoles?.networkFeeSponsor?.resourceRead === true ? 'Read' : 'Not verified'}</strong></div>
              <div><small>Principal agreement scope</small><strong>{readiness.sponsorRoles?.assetPrincipalSponsor?.agreementScopeConfigured === true ? 'Configured' : 'Not configured'}</strong></div>
              <div><small>Fee agreement scope</small><strong>{readiness.sponsorRoles?.networkFeeSponsor?.agreementScopeConfigured === true ? 'Configured' : 'Not configured'}</strong></div>
              <div><small>Fee-to-principal resource audit</small><strong>{readiness.sponsorRoles?.feeResourceDelegationTransactionAuditVerified === true ? 'Verified' : 'Not verified'}</strong></div>
              <div><small>Mainnet signing / submission</small><strong>{readiness.canCreateSigningIntent === true || readiness.canSubmitSponsoredTransfer === true ? 'Not expected in this build' : 'Disabled'}</strong></div>
            </div>
            {(readiness.blockers || []).length > 0 && <div className="wallet-vault-risk-note" role="status"><strong>Current blockers</strong><p>{readiness.blockers?.map(item => item.replaceAll('-', ' ')).join('; ')}</p></div>}
          </>
        )}
        {!readiness && !readinessError && <p className="wallet-vault-caption">{readinessLoading ? 'Reading Mainnet sponsor diagnostics…' : 'No readiness response received yet.'}</p>}
      </section>

      <section className="wallet-vault-panel">
        <div className="wallet-vault-panel-head">
          <span className="wallet-vault-step">02</span>
          <div><h2>Request an organization-funded payout</h2><p>The destination is an external TRON wallet or exchange deposit address. Check the receiving service's TRC20 network, minimum and memo instructions before submitting.</p></div>
        </div>
        <div className="wallet-vault-form">
          <label htmlFor="direct-sponsor-recipient">External TRON recipient address</label>
          <input id="direct-sponsor-recipient" value={recipient} onChange={event => setRecipient(event.target.value.trim())} placeholder="T… recipient address" autoComplete="off" spellCheck={false} disabled={requestBusy} />
          <label htmlFor="direct-sponsor-amount">Requested amount</label>
          <div className="wallet-vault-form-row">
            <input id="direct-sponsor-amount" value={amount} onChange={event => setAmount(event.target.value)} inputMode="decimal" placeholder="1.00" autoComplete="off" disabled={requestBusy} />
            <span>USDT · TRC20 · 6 decimals</span>
          </div>
          {amount.trim() && !amountBaseUnits && <p className="wallet-vault-risk-note">Enter a positive USDT amount with no more than six decimal places.</p>}
          <div className="wallet-vault-transfer-warning" role="note">
            <strong>Nothing is taken from your wallet</strong>
            <p>Your wallet signs one short identity challenge. It does not approve a transfer or pay the network fee. The sponsor organization must separately approve the exact recipient and amount.</p>
          </div>
          <button type="button" className="wallet-vault-primary" disabled={requestBusy || !amountBaseUnits || !ADDRESS_PATTERN.test(recipient.trim())} onClick={() => void submitRequest()}>
            <Send size={16} /> {requestBusy ? 'Storing sponsor request…' : 'Submit for sponsor review'}
          </button>
        </div>
        {requestError && <p className="wallet-vault-risk-note" role="alert">{requestError}</p>}
        {requestNotice && <p className="wallet-vault-caption" role="status"><CheckCircle2 size={15} /> {requestNotice}</p>}
        {requestKey && (
          <div className="wallet-vault-review-grid">
            <div className="wallet-vault-review-wide"><small>Saved request reference</small><strong>{requestKey}</strong></div>
            <button type="button" className="wallet-vault-secondary" disabled={requestBusy} onClick={() => void lookupRequest()}><RefreshCw size={15} /> {requestBusy ? 'Checking…' : 'Check saved request status'}</button>
          </div>
        )}
        {requestStatus && requestRecord && (
          <div className="wallet-vault-review-grid">
            <div><small>Request state</small><strong>{requestRecord.status.replaceAll('-', ' ')}</strong></div>
            <div><small>Principal approval</small><strong>{requestStatus.sponsorApproval?.status || requestRecord.sponsorApproval?.status || 'Not approved'}</strong></div>
            <div><small>Network-fee approval</small><strong>{requestStatus.feeSponsorApproval?.status || requestRecord.feeSponsorApproval?.status || 'Not approved'}</strong></div>
            <div><small>Requested USDT</small><strong>{formatUsdt(requestRecord.amountBaseUnits)} USDT</strong></div>
            <div className="wallet-vault-review-wide"><small>Recipient</small><strong>{requestRecord.recipientAddress}</strong></div>
            <div><small>Budget reserved</small><strong>No</strong></div>
            <div><small>TRON transaction broadcast</small><strong>No</strong></div>
          </div>
        )}
      </section>

      <section className="wallet-vault-panel">
        <div className="wallet-vault-panel-head">
          <span className="wallet-vault-step">03</span>
          <div><h2>Authorized sponsor review</h2><p>These review tools work only when the currently unlocked local wallet is the exact independently configured sponsor address for that role.</p></div>
        </div>
        <button type="button" className="wallet-vault-secondary" onClick={() => setShowSponsorTools(value => !value)} aria-expanded={showSponsorTools}>
          <ShieldCheck size={15} /> {showSponsorTools ? 'Hide sponsor review tools' : 'Open sponsor review tools'}
        </button>
        {showSponsorTools && (
          <>
            <div className="wallet-vault-transfer-warning" role="note">
              <strong>Organization signers only</strong>
              <p>Do not sign requests unless you are authorized by the sponsor organization and the agreement covers the exact Mainnet USDT principal or network-fee scope. An approval message is not a transaction signature.</p>
            </div>
            <div className="wallet-vault-review-grid">
              <div>
                <small>USDT principal sponsor queue</small>
                <button type="button" className="wallet-vault-secondary" disabled={Boolean(reviewBusy)} onClick={() => void loadQueue('principal')}>{reviewBusy === 'principal-queue' ? 'Loading…' : 'Load principal sponsor queue'}</button>
              </div>
              <div>
                <small>Network-fee sponsor queue</small>
                <button type="button" className="wallet-vault-secondary" disabled={Boolean(reviewBusy)} onClick={() => void loadQueue('fee')}>{reviewBusy === 'fee-queue' ? 'Loading…' : 'Load fee sponsor queue'}</button>
              </div>
            </div>
            {queueError && <p className="wallet-vault-risk-note" role="alert">{queueError}</p>}
            {queueNotice && <p className="wallet-vault-caption" role="status">{queueNotice}</p>}
            {principalQueue.map(request => (
              <div className="wallet-vault-account-card" key={'principal-' + request.idempotencyKey}>
                <strong>USDT principal · {formatUsdt(request.amountBaseUnits)} USDT</strong>
                <p>Recipient: {request.recipientAddress}</p>
                <p>Reference: {request.idempotencyKey}</p>
                <p>Approval: {request.sponsorApproval?.status || 'not approved'}</p>
                <button type="button" className="wallet-vault-secondary" disabled={Boolean(reviewBusy) || request.sponsorApproval?.status === 'approved-active'} onClick={() => void approveRequest(request, 'principal')}>Prepare exact principal approval</button>
              </div>
            ))}
            {feeQueue.map(request => (
              <div className="wallet-vault-account-card" key={'fee-' + request.idempotencyKey}>
                <strong>Network fee · {formatUsdt(request.amountBaseUnits)} USDT principal request</strong>
                <p>Recipient: {request.recipientAddress}</p>
                <p>Reference: {request.idempotencyKey}</p>
                <p>Fee approval: {request.feeSponsorApproval?.status || 'not approved'}</p>
                <button type="button" className="wallet-vault-secondary" disabled={Boolean(reviewBusy) || request.feeSponsorApproval?.status === 'approved-active'} onClick={() => void approveRequest(request, 'fee')}>Prepare exact fee approval</button>
              </div>
            ))}
            {activeChallenge && activeChallengeRole && (
              <div className="wallet-vault-form">
                <label>Exact {activeChallengeRole === 'principal' ? 'USDT principal' : 'network fee'} approval message</label>
                <textarea rows={10} readOnly value={activeChallenge.message} />
                <p className="wallet-vault-caption">The local wallet will sign only this exact one-request message. It is not a transaction and does not reserve funds or resources.</p>
                <button type="button" className="wallet-vault-primary" disabled={Boolean(reviewBusy) || Date.parse(activeChallenge.expiresAt) <= Date.now()} onClick={() => void signApproval()}>
                  <ShieldCheck size={15} /> {reviewBusy.endsWith('-sign') ? 'Verifying approval…' : 'Sign and record exact approval'}
                </button>
                <button type="button" className="wallet-vault-secondary" disabled={Boolean(reviewBusy)} onClick={() => { setActiveChallenge(null); setActiveChallengeRole(null) }}>Cancel approval challenge</button>
              </div>
            )}
          </>
        )}
        <p className="wallet-vault-caption">Principal and fee approvals remain distinct. They do not reserve budgets, delegate resources or enable Mainnet payout execution.</p>
      </section>

      <section className="wallet-vault-panel wallet-vault-transfer-warning">
        <div><AlertTriangle size={18} /><strong>Mainnet withdrawal execution is disabled in this build.</strong></div>
        <p>The remaining work includes atomic reservation, sponsor-controlled transaction signing, fee/resource enforcement, chain broadcast, solidified receipt verification and ledger reconciliation. No real payment can be sent by this interface yet.</p>
      </section>
    </div>
  )
}
