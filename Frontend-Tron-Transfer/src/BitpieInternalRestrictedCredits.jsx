import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, RefreshCw, ShieldCheck } from 'lucide-react'
import { TronWeb } from 'tronweb'

const BITPIE_ADDRESS = String(import.meta.env.VITE_RESTRICTED_TRX_BENEFICIARY_ADDRESS || '').trim()
const API_BASE = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? '' : 'https://trc20-usdt-token-cloner-api.onrender.com')).replace(/\/+$/, '')

function toSun(value) {
  const raw = String(value || '').trim()
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(raw)) throw new Error('Enter a positive TRX amount with up to 6 decimal places.')
  const [whole, fraction = ''] = raw.split('.')
  const amount = BigInt(whole) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6))
  if (amount <= 0n) throw new Error('Amount must be greater than zero.')
  return amount.toString()
}

function formatSun(value) {
  try {
    const sun = BigInt(String(value))
    const whole = sun / 1_000_000n
    const fraction = (sun % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
    return whole.toString() + (fraction ? '.' + fraction : '')
  } catch { return '0' }
}

export default function BitpieInternalRestrictedCredits() {
  const [credits, setCredits] = useState([])
  const [totalSun, setTotalSun] = useState('0')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const pendingIdempotencyKey = useRef(null)

  const request = useCallback(async (method = 'GET', body = null) => {
    const token = sessionStorage.getItem('tron-transfer:owner-session:v1') || ''
    if (!token) throw new Error('Sign in as the platform owner to access internal credits.')
    if (!BITPIE_ADDRESS || !TronWeb.isAddress(BITPIE_ADDRESS)) throw new Error('Configure and verify the Bitpie TRON address first.')
    const response = await fetch(API_BASE + '/api/owner/bitpie-internal-credits' +
      (method === 'GET' ? '?address=' + encodeURIComponent(BITPIE_ADDRESS) : ''), {
      method,
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + token, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
      credentials: 'omit', cache: 'no-store', redirect: 'error',
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    })
    const payload = await response.json()
    if (!response.ok || payload.success !== true) throw new Error(payload.error || 'Internal credit ledger request failed.')
    return payload
  }, [])

  const refresh = useCallback(async () => {
    setBusy(true); setError('')
    try {
      const payload = await request('GET')
      setCredits(payload.credits || [])
      setTotalSun(String(payload.totalAmountSun || '0'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load internal credit ledger.')
    } finally { setBusy(false) }
  }, [request])

  useEffect(() => { void refresh() }, [refresh])

  async function createCredit(event) {
    event.preventDefault()
    setBusy(true); setError(''); setNotice('')
    try {
      const amountSun = toSun(amount)
      const normalizedReason = reason.trim()
      if (!pendingIdempotencyKey.current
        || pendingIdempotencyKey.current.amountSun !== amountSun
        || pendingIdempotencyKey.current.reason !== normalizedReason) {
        pendingIdempotencyKey.current = { key: crypto.randomUUID(), amountSun, reason: normalizedReason }
      }
      const payload = await request('POST', {
        beneficiaryAddress: BITPIE_ADDRESS,
        amountSun,
        idempotencyKey: pendingIdempotencyKey.current.key,
        creditType: 'display_only_non_asset',
        reason: normalizedReason,
      })
      pendingIdempotencyKey.current = null
      setNotice(payload.duplicate ? 'This idempotent internal credit entry already exists.' : 'Internal restricted-credit entry recorded.')
      setAmount(''); setReason('')
      const updated = await request('GET')
      setCredits(updated.credits || [])
      setTotalSun(String(updated.totalAmountSun || '0'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not record internal credit.')
    } finally { setBusy(false) }
  }

  return (
    <section className="panel provider-panel">
      <div className="section-heading">
        <div><span className="eyebrow">TRON TRANSFER · INTERNAL LEDGER ONLY</span><h2>Bitpie-linked restricted credits</h2><p>Owner-managed bookkeeping entries associated with the configured Bitpie address. This is not a Bitpie integration or a TRX asset balance.</p></div>
        <div className="panel-icon"><ShieldCheck/></div>
      </div>
      <div className="notice notice-warning"><AlertTriangle size={17}/><div><b>Not a Bitpie wallet credit</b><p>Bitpie does not expose a published API for this credit operation. These records exist only inside Tron Transfer; they are not visible in the Bitpie app, are not backed by blockchain TRX, cannot be transferred or withdrawn, and do not change any on-chain balance.</p></div></div>
      <div className="recipient-balance-grid">
        <article className="metric-card"><span>Tron Transfer internal credit total</span><strong>{formatSun(totalSun)} <small>TRX units (bookkeeping only)</small></strong></article>
        <article className="metric-card"><span>Bitpie API status</span><strong>Not available / not connected</strong></article>
      </div>
      <form className="transfer-form" onSubmit={createCredit}>
        <label>Verified Bitpie TRON address<input value={BITPIE_ADDRESS} readOnly/></label>
        <label>Internal credit amount (TRX units)<input inputMode="decimal" value={amount} onChange={event=>setAmount(event.target.value)} placeholder="e.g. 100.000000" required/></label>
        <label>Reason / reference<input value={reason} onChange={event=>setReason(event.target.value)} placeholder="Internal bookkeeping reason" minLength={3} maxLength={240} required/></label>
        <button className="primary-button" disabled={busy || !amount.trim() || reason.trim().length<3}><ShieldCheck size={15}/>{busy?'Saving…':'Record internal restricted credit'}</button>
      </form>
      {error&&<div className="notice notice-error" role="alert"><AlertTriangle size={16}/><span>{error}</span></div>}
      {notice&&<div className="notice notice-success" role="status"><ShieldCheck size={16}/><span>{notice}</span></div>}
      <div className="section-heading"><div><span className="eyebrow">APPEND-ONLY LEDGER</span><h3>Internal credit entries</h3></div><button className="secondary-button" type="button" disabled={busy} onClick={()=>void refresh()}><RefreshCw size={14}/> Refresh</button></div>
      {!credits.length ? <div className="empty-state">No internal credit entries have been recorded.</div> : credits.map(item=><article className="history-item" key={item.id}><div className="history-icon incoming"><ShieldCheck size={16}/></div><div className="history-main"><b>{formatSun(item.amountSun)} TRX units · internal only</b><small>{item.reason} · {item.createdAt?new Date(item.createdAt).toLocaleString():'date unavailable'}</small><span className="status-text">Restricted internal bookkeeping · no withdrawal</span></div></article>)}
      <p className="fine-print">Entries are append-only and owner-authenticated. They are not proof of provider funding, a debt owed by Bitpie, a token issuance, or redeemable TRX. No Bitpie endpoint is called.</p>
    </section>
  )
}
