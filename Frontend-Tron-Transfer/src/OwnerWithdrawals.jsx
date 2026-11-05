import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowUpRight, CheckCircle2, ExternalLink, History, RefreshCw, ShieldCheck, Wallet } from 'lucide-react'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'https://trc20-usdt-token-cloner-api.onrender.com').replace(/\/+$/, '')
const MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/

function isAddress(value, tronWeb) {
  try { return ADDRESS_RE.test(String(value || '')) && tronWeb?.isAddress(String(value)) === true } catch { return false }
}
function formatUnits(value, decimals = 6) {
  try {
    const n = BigInt(String(value ?? '0')), base = 10n ** BigInt(decimals)
    const fraction = (n % base).toString().padStart(decimals, '0').replace(/0+$/, '')
    return (n / base).toString() + (fraction ? '.' + fraction : '')
  } catch { return 'Unavailable' }
}
function formatTrx(sun) { return sun === null || sun === undefined ? 'Unavailable' : formatUnits(sun, 6) }
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
  if (!response.ok && response.status !== 202) throw new Error(body?.message || body?.error || 'The withdrawal API request failed.')
  if (!body || typeof body !== 'object') throw new Error('The withdrawal API returned an unreadable response.')
  if (body.success === false && response.status !== 202) throw new Error(body.message || body.error || 'The withdrawal API rejected the request.')
  return body
}

export default function OwnerWithdrawals({ wallet, ownerSession, historyOnly = false }) {
  const [snapshot, setSnapshot] = useState(null)
  const [withdrawals, setWithdrawals] = useState([])
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [prepared, setPrepared] = useState(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const walletAddress = wallet?.address || ''
  const isOwnerWallet = Boolean(ownerSession?.address && walletAddress && ownerSession.address === walletAddress)
  const token = ownerSession?.sessionToken || ''
  const canInteract = Boolean(token && isOwnerWallet && wallet?.tronWeb?.trx)

  const apiStatus = useMemo(() => {
    if (!token) return 'Sign in as the configured owner first.'
    if (!walletAddress) return 'Connect the configured owner wallet in TronLink.'
    if (!isOwnerWallet) return 'The connected TronLink address does not match the configured owner address.'
    return 'Owner wallet and owner session match.'
  }, [token, walletAddress, isOwnerWallet])

  const refresh = useCallback(async () => {
    if (!token) {
      setSnapshot(null)
      setWithdrawals([])
      return
    }
    setRefreshing(true)
    setError('')
    try {
      const [readiness, history] = await Promise.all([
        api('/api/tron-owner-withdrawals/readiness', token),
        api('/api/tron-owner-withdrawals/', token),
      ])
      setSnapshot(readiness.snapshot || null)
      setWithdrawals(Array.isArray(history.withdrawals) ? history.withdrawals : [])
    } catch (cause) {
      setError(cause?.message || 'Could not refresh owner wallet readiness.')
    } finally {
      setRefreshing(false)
    }
  }, [token])

  useEffect(() => { void refresh() }, [refresh])

  async function prepareWithdrawal() {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      if (!canInteract) throw new Error(apiStatus)
      if (!isAddress(recipient.trim(), wallet.tronWeb)) throw new Error('Enter a valid TRON Mainnet receiving address.')
      if (recipient.trim() === walletAddress) throw new Error('Choose an external recipient address, not the sending wallet.')
      const parsed = amount.trim()
      if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(parsed) || /^0(?:\.0{1,6})?$/.test(parsed)) {
        throw new Error('Enter a positive USDT amount with up to six decimal places.')
      }
      const result = await api('/api/tron-owner-withdrawals/prepare', token, {
        method: 'POST',
        body: JSON.stringify({
          recipientAddress: recipient.trim(),
          amount: parsed,
          idempotencyKey: crypto.randomUUID(),
        }),
      })
      setPrepared({
        withdrawal: result.withdrawal,
        unsignedTransaction: result.unsignedTransaction,
        feeLimitSun: result.feeLimitSun,
        estimatedEnergy: result.estimatedEnergy,
        estimatedEnergyPenalty: result.estimatedEnergyPenalty,
      })
      setNotice('Unsigned transaction prepared. Review the destination, amount and fee limit before requesting the TronLink signature.')
      await refresh()
    } catch (cause) {
      setError(cause?.message || 'Could not prepare the withdrawal.')
    } finally {
      setBusy(false)
    }
  }

  async function signAndBroadcast() {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      if (!prepared?.withdrawal?.id || !prepared?.unsignedTransaction) throw new Error('Prepare a new withdrawal first.')
      if (!canInteract) throw new Error(apiStatus)
      const currentAddress = wallet.tronWeb.defaultAddress?.base58 || ''
      if (currentAddress !== ownerSession.address || currentAddress !== walletAddress) {
        throw new Error('The TronLink account changed. Reconnect the configured owner wallet before signing.')
      }
      // TronLink owns the signing key. Only its injected signer is used here.
      const signedTransaction = await wallet.tronWeb.trx.sign(prepared.unsignedTransaction)
      if (!signedTransaction || !Array.isArray(signedTransaction.signature) || signedTransaction.signature.length !== 1) {
        throw new Error('TronLink did not return a single owner signature. No broadcast was attempted.')
      }
      const result = await api('/api/tron-owner-withdrawals/' + encodeURIComponent(prepared.withdrawal.id) + '/broadcast', token, {
        method: 'POST',
        body: JSON.stringify({ signedTransaction }),
      })
      setNotice(result.note || 'Tatum accepted the signed transaction. Final confirmation is still pending.')
      setPrepared(null)
      setAmount('')
      await refresh()
    } catch (cause) {
      const message = typeof cause === 'string' ? cause : cause?.message
      setError(message || 'Signing or broadcast failed. Check the saved withdrawal status before retrying.')
    } finally {
      setBusy(false)
    }
  }

  async function refreshOne(id) {
    setBusy(true)
    setError('')
    try {
      const result = await api('/api/tron-owner-withdrawals/' + encodeURIComponent(id), token)
      setWithdrawals((current) => current.map((item) => item.id === id ? result.withdrawal : item))
      setNotice(result.note || 'Withdrawal status refreshed from Tatum Mainnet.')
    } catch (cause) {
      setError(cause?.message || 'Could not refresh this withdrawal status.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel owner-withdrawals-page">
      <div className="section-heading">
        <div>
          <span className="eyebrow">TATUM MAINNET · TRONLINK OWNER SIGNING</span>
          <h2>{historyOnly ? 'Direct USDT withdrawal history' : 'Send official USDT to an external TRON address'}</h2>
          <p>USDT moves directly from the configured owner wallet. Tatum prepares and broadcasts; TronLink signs the exact transaction after your approval.</p>
        </div>
        <div className="panel-icon"><ArrowUpRight /></div>
      </div>

      <div className="owner-session-card">
        <strong><ShieldCheck size={15} /> {canInteract ? 'Owner wallet verified for this session' : 'Owner signing checks'}</strong>
        <small>{apiStatus}</small>
        {walletAddress && <small>TronLink: {walletAddress}</small>}
        {ownerSession?.address && <small>Configured owner: {ownerSession.address}</small>}
      </div>

      {notice && <div className="notice notice-success" role="status"><CheckCircle2 size={16} /><span>{notice}</span></div>}
      {error && <div className="notice notice-error" role="alert"><AlertTriangle size={16} /><span>{error}</span></div>}

      {!historyOnly && <>
        <div className="owner-chain-snapshot">
          <div className="section-heading compact">
            <div><span className="eyebrow">LIVE SOLIDIFIED MAINNET SNAPSHOT</span><h3>Sending wallet assets and resources</h3></div>
            <button className="secondary-button" disabled={!token || refreshing || busy} onClick={() => void refresh()}><RefreshCw size={15} /> Refresh</button>
          </div>
          {!snapshot ? <p className="fine-print">Sign in as owner, connect the same TronLink address, then refresh to read actual balances from Tatum.</p> : <div className="recipient-balance-grid">
            <article className="metric-card"><span>Official USDT</span><strong>{formatUnits(snapshot.usdtBalanceBaseUnits)} <small>USDT</small></strong></article>
            <article className="metric-card"><span>TRX</span><strong>{formatTrx(snapshot.trxBalanceSun)} <small>TRX</small></strong></article>
            <article className="metric-card"><span>Available energy</span><strong>{snapshot.energyAvailable === null ? 'Unavailable' : Number(snapshot.energyAvailable).toLocaleString()}</strong></article>
            <article className="metric-card"><span>Available bandwidth</span><strong>{snapshot.bandwidthAvailable === null ? 'Unavailable' : Number(snapshot.bandwidthAvailable).toLocaleString()}</strong></article>
          </div>}
          {snapshot && <small className="fine-print">Read at {new Date(snapshot.checkedAt).toLocaleString()}. Actual energy, bandwidth and TRX consumption depend on current Mainnet conditions and the receiving contract state.</small>}
        </div>

        <div className="withdrawal-form-grid">
          <div className="form-stack">
            <label>External recipient TRON Mainnet address
              <input value={recipient} onChange={(event) => { setRecipient(event.target.value); setPrepared(null) }} placeholder="Exchange or external wallet address (T…)" autoComplete="off" spellCheck="false" />
            </label>
            <label>USDT amount
              <input value={amount} onChange={(event) => { setAmount(event.target.value); setPrepared(null) }} placeholder="e.g. 10.00" inputMode="decimal" />
            </label>
            <button className="primary-button" disabled={!canInteract || busy || refreshing || !snapshot || BigInt(snapshot.usdtBalanceBaseUnits || '0') <= 0n || Boolean(prepared)} onClick={() => void prepareWithdrawal()}>
              <ArrowUpRight size={16} /> Prepare direct withdrawal
            </button>
            {!canInteract && <p className="fine-print">A matching owner login and TronLink connection are both required. Requester identity login alone is not enough.</p>}
          </div>
          <aside className="withdrawal-eligibility">
            <span className="eyebrow">TRANSFER SAFETY</span>
            <h3>Official Tether USDT TRC20</h3>
            <div className="readiness-checks">
              <span>Network: TRON Mainnet</span>
              <span>Contract: {MAINNET_USDT}</span>
              <span>Signer: configured owner via TronLink</span>
              <span>Broadcast: Tatum Mainnet Gateway</span>
              <span>Confirmation: solidified receipt + exact Transfer event</span>
            </div>
            <p className="fine-print">The sending wallet must hold the requested USDT and enough TRON resources or TRX for network fees. Tatum does not provide the USDT principal.</p>
          </aside>
        </div>

        {prepared && <div className="prepared-withdrawal">
          <div className="section-heading compact"><div><span className="eyebrow">REVIEW BEFORE WALLET APPROVAL</span><h3>Withdrawal prepared · not sent</h3></div></div>
          <div className="prepared-details">
            <div><span>Recipient</span><b>{prepared.withdrawal.recipientAddress}</b></div>
            <div><span>Amount</span><b>{formatUnits(prepared.withdrawal.amountBaseUnits)} USDT</b></div>
            <div><span>Fee limit</span><b>{prepared.feeLimitSun ? formatTrx(prepared.feeLimitSun) + ' TRX' : 'Returned by Tatum'}</b></div>
            <div><span>Estimated energy</span><b>{prepared.estimatedEnergy === null ? 'Not returned' : Number(prepared.estimatedEnergy).toLocaleString()}</b></div>
            <div><span>Transaction ID</span><b>{prepared.withdrawal.transactionHash}</b></div>
          </div>
          <p className="fine-print">No funds have moved at this stage. Review the exact address and amount in this page and in the TronLink confirmation prompt. TronLink may ask for permission to sign this smart-contract transaction.</p>
          <div className="button-row">
            <button className="primary-button" disabled={!canInteract || busy} onClick={() => void signAndBroadcast()}><Wallet size={16} /> Sign with TronLink and broadcast</button>
            <button className="outline-button" disabled={busy} onClick={() => setPrepared(null)}>Cancel prepared review</button>
          </div>
        </div>}
      </>}

      <div className="section-heading compact owner-history-heading">
        <div><span className="eyebrow">TATUM MAINNET TRANSACTION RECORDS</span><h3><History size={17} /> Withdrawal history</h3></div>
        <button className="secondary-button" disabled={!token || refreshing || busy} onClick={() => void refresh()}><RefreshCw size={15} /> Refresh history</button>
      </div>
      {!withdrawals.length ? <div className="empty-state"><History size={24} /><b>No direct withdrawals recorded</b><p>Prepared, submitted and confirmed owner wallet transfers will appear here.</p></div> : <div className="transaction-list">
        {withdrawals.map((item) => <article className="transaction-row" key={item.id}>
          <div className="transaction-main">
            <strong>{formatUnits(item.amountBaseUnits)} USDT</strong>
            <span>To {item.recipientAddress} · {new Date(item.createdAt).toLocaleString()}</span>
            <small>Status: {item.status}</small>
            {item.transactionHash && <a href={'https://tronscan.org/#/transaction/' + item.transactionHash} target="_blank" rel="noreferrer">View on TRONSCAN <ExternalLink size={12} /></a>}
            {item.failureCode && <small>Detail: {item.failureCode}</small>}
          </div>
          <div className="transaction-actions">
            <button className="secondary-button" disabled={busy || !['submitted', 'outcome-unknown', 'broadcasting'].includes(item.status)} onClick={() => void refreshOne(item.id)}>Refresh confirmation</button>
          </div>
        </article>)}
      </div>}

      <div className="notice notice-warning owner-deposit-warning">
        <AlertTriangle size={17} />
        <div><b>Exchange deposit reminder</b><p>Use the exchange’s own TRON / TRC20 USDT deposit address and check the exchange's minimum deposit, confirmation and memo/tag instructions before sending. A solidified on-chain transfer does not guarantee the exchange will credit its internal account ledger.</p></div>
      </div>
      <p className="fine-print">This interface never asks for a seed phrase or private key. Do not retry a transaction with an unknown broadcast outcome until its fixed transaction ID has been checked on Mainnet.</p>
    </section>
  )
}
