import { useState } from 'react'
import { AlertTriangle, ArrowLeft, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'

type OkxDeposit = {
  currency: string
  chain: string
  amount: string
  transactionId: string
  depositAddress: string
  memo: string
  statusCode: string
  status: string
  actualDepositBlockchainConfirmed: string
  recordedAt: string
  source: string
}
type OkxPayload = {
  success?: boolean
  status?: string
  message?: string
  note?: string
  count?: number
  deposits?: OkxDeposit[]
}

const API_BASE = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? '' : 'https://trc20-usdt-token-cloner-api.onrender.com')).replace(/\/+$/, '')
const ACCESS_TOKEN_MIN_LENGTH = 32

const STATUS_LABELS: Record<string, string> = {
  '0': 'Waiting for confirmation',
  '1': 'Credited · withdrawal not yet enabled',
  '2': 'Successful · OKX reports withdrawable',
  '8': 'Pending · temporary deposit suspension',
  '11': 'Address blacklist match',
  '12': 'Account or deposit frozen',
  '13': 'Sub-account deposit interception',
  '14': 'KYC limit',
  '17': 'Travel Rule response pending',
}

function formatRecordedAt(value: string): string {
  if (!/^\d{13}$/.test(value)) return 'Not supplied by OKX'
  const date = new Date(Number(value))
  return Number.isNaN(date.getTime()) ? 'Not supplied by OKX' : date.toLocaleString()
}

export default function OkxDepositStatus() {
  const [accessToken, setAccessToken] = useState('')
  const [currency, setCurrency] = useState('USDT')
  const [transactionId, setTransactionId] = useState('')
  const [limit, setLimit] = useState('20')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [records, setRecords] = useState<OkxDeposit[]>([])
  const [loaded, setLoaded] = useState(false)
  const [responseNote, setResponseNote] = useState('')

  const clearResults = () => {
    setRecords([])
    setLoaded(false)
    setResponseNote('')
  }

  const loadRecords = async () => {
    setError('')
    if (accessToken.trim().length < ACCESS_TOKEN_MIN_LENGTH) {
      setError('Enter the server status-access token (at least 32 characters). Do not enter your OKX API key, secret, passphrase or wallet recovery phrase here.')
      return
    }
    const params = new URLSearchParams()
    if (currency.trim()) params.set('ccy', currency.trim().toUpperCase())
    if (transactionId.trim()) params.set('txId', transactionId.trim())
    params.set('limit', limit)

    setBusy(true)
    clearResults()
    try {
      const response = await fetch(API_BASE + '/api/okx/deposit-status?' + params.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer ' + accessToken.trim(),
        },
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      })
      const payload = await response.json().catch(() => null) as OkxPayload | null
      if (!response.ok || payload?.success !== true || !Array.isArray(payload.deposits)) {
        const message = response.status === 401
          ? 'The status-access token was rejected. Verify the token in your secure environment configuration.'
          : response.status === 503 || payload?.status === 'not-configured'
            ? 'The server-side OKX read-only integration is not configured yet.'
            : payload?.message || 'OKX deposit history could not be verified. No deposit status was inferred.'
        setError(message)
        return
      }
      setRecords(payload.deposits)
      setResponseNote(payload.note || '')
      setLoaded(true)
    } catch {
      setError('The backend or OKX could not be reached. No deposit status was inferred. Retry later or check the service health.')
    } finally {
      setBusy(false)
    }
  }

  const reset = () => {
    setAccessToken('')
    setCurrency('USDT')
    setTransactionId('')
    setLimit('20')
    setError('')
    clearResults()
  }

  return (
    <div className="studio-app mainnet-deposit-page">
      <header>
        <div>
          <div>
            <div className="studio-brand-mark"><ShieldCheck size={23} aria-hidden="true" /></div>
            <div>
              <h1>TRON Token Studio</h1>
              <p>Authenticated read-only exchange records</p>
            </div>
          </div>
          <div>
            <a className="studio-button studio-button--secondary" href="#/"><ArrowLeft size={15} aria-hidden="true" /> Back to studio</a>
            <span className="studio-pill">Read-only</span>
          </div>
        </div>
      </header>

      <div className="studio-shell">
        <main className="studio-main">
          <section className="studio-page-heading">
            <div>
              <p className="studio-eyebrow">Private account record lookup</p>
              <h1>OKX deposit history</h1>
              <p>Look up real records returned by the single OKX account configured on the backend. No balances are fabricated, and no transfer is started.</p>
            </div>
            <span className="studio-pill studio-pill--good">Read-only</span>
          </section>

          <div className="studio-notice studio-notice--warning" role="note">
            <AlertTriangle size={18} aria-hidden="true" />
            <div>
              <strong>Use only with the configured account owner’s authorization</strong>
              <p>This API reads the OKX account whose read-only API credentials are held server-side. It does not inspect another recipient’s OKX account. A TRON wallet login does not prove ownership of an OKX account. Never enter OKX API credentials, a private key or a recovery phrase in this page.</p>
            </div>
          </div>

          <section className="studio-panel">
            <div className="studio-panel-heading">
              <div className="studio-panel-icon"><ShieldCheck size={19} aria-hidden="true" /></div>
              <div>
                <p className="studio-eyebrow">Secure request</p>
                <h2>Authenticate the read-only lookup</h2>
                <p>The status-access token gates this endpoint. It remains in this page’s memory only and is not written to local storage, session storage or the URL.</p>
              </div>
            </div>
            <div className="studio-field-block">
              <label htmlFor="okx-status-access-token">Server status-access token</label>
              <input
                id="okx-status-access-token"
                type="password"
                value={accessToken}
                onChange={(event) => { setAccessToken(event.target.value); clearResults() }}
                autoComplete="off"
                spellCheck={false}
                minLength={ACCESS_TOKEN_MIN_LENGTH}
                maxLength={256}
                placeholder="Enter the separately generated status-access token"
              />
              <p className="studio-field-hint">Do not paste the OKX API key, secret or passphrase. Those remain server-side in Render.</p>
            </div>
            <div className="studio-field-block">
              <label htmlFor="okx-status-currency">Currency filter</label>
              <input
                id="okx-status-currency"
                value={currency}
                onChange={(event) => { setCurrency(event.target.value); clearResults() }}
                autoComplete="off"
                maxLength={20}
                placeholder="USDT"
              />
            </div>
            <div className="studio-field-block">
              <label htmlFor="okx-status-txid">Exact transaction ID filter (optional)</label>
              <input
                id="okx-status-txid"
                value={transactionId}
                onChange={(event) => { setTransactionId(event.target.value); clearResults() }}
                autoComplete="off"
                spellCheck={false}
                maxLength={160}
                placeholder="Paste the transaction hash if known"
              />
            </div>
            <div className="studio-field-block">
              <label htmlFor="okx-status-limit">Maximum records</label>
              <select id="okx-status-limit" value={limit} onChange={(event) => { setLimit(event.target.value); clearResults() }}>
                <option value="10">10 most recent matching records</option>
                <option value="20">20 most recent matching records</option>
                <option value="50">50 most recent matching records</option>
                <option value="100">100 most recent matching records</option>
              </select>
            </div>
            {error && <p className="studio-inline-error" role="alert">{error}</p>}
            <div className="studio-inline-actions">
              <button type="button" className="studio-button studio-button--primary" onClick={() => void loadRecords()} disabled={busy || accessToken.trim().length < ACCESS_TOKEN_MIN_LENGTH}>
                <RefreshCw size={15} aria-hidden="true" className={busy ? 'studio-spin' : undefined} />
                {busy ? 'Checking authenticated OKX records…' : 'Check OKX deposit history'}
              </button>
              <button type="button" className="studio-button studio-button--secondary" onClick={reset} disabled={busy}>
                <Trash2 size={15} aria-hidden="true" /> Clear token and results
              </button>
            </div>
          </section>

          {loaded && (
            <section className="studio-history-panel" aria-live="polite">
              <div className="studio-snapshot-heading">
                <div>
                  <h3>Exchange-returned records</h3>
                  <p>{records.length} record{records.length === 1 ? '' : 's'} returned for the selected filters.</p>
                </div>
                <span className="studio-pill studio-pill--good">Verified API response</span>
              </div>
              {records.length === 0 ? (
                <div className="studio-history-empty">
                  <AlertTriangle size={18} aria-hidden="true" />
                  <p>OKX returned no matching records for this query. This does not prove a particular transfer failed or was never credited. Check the destination network, address and any required memo in the official OKX account.</p>
                </div>
              ) : (
                <div className="studio-history-list">
                  {records.map((record, index) => (
                    <article className={record.statusCode === '2' ? 'studio-history-item is-verified' : 'studio-history-item'} key={record.transactionId + ':' + record.statusCode + ':' + index}>
                      <div className="studio-history-item-heading">
                        <strong>{record.currency || 'Currency not reported'} · {record.chain || 'Network not reported'}</strong>
                        <span className={record.statusCode === '2' ? 'studio-pill studio-pill--good' : 'studio-pill studio-pill--warning'}>
                          {STATUS_LABELS[record.statusCode] || 'Status reported by OKX: ' + (record.status || 'unknown')}
                        </span>
                      </div>
                      <p className="studio-history-meta"><strong>Amount:</strong> {record.amount || 'Not reported'} {record.currency}</p>
                      <p className="studio-history-meta"><strong>Transaction ID:</strong> <code>{record.transactionId || 'Not reported'}</code></p>
                      <p className="studio-history-meta"><strong>Deposit address:</strong> <code>{record.depositAddress || 'Not reported'}</code></p>
                      {record.memo && <p className="studio-history-meta"><strong>Memo / tag:</strong> <code>{record.memo}</code></p>}
                      <p className="studio-history-meta"><strong>Record created:</strong> {formatRecordedAt(record.recordedAt)} <span>· raw timestamp {record.recordedAt || 'not reported'}</span></p>
                      <p className="studio-history-meta"><strong>Raw OKX status code:</strong> <code>{record.statusCode || 'not reported'}</code></p>
                      <p className="studio-history-meta"><strong>Source:</strong> {record.source || 'Authenticated OKX deposit-history response'}</p>
                    </article>
                  ))}
                </div>
              )}
              {responseNote && <p className="studio-history-warning">{responseNote}</p>}
            </section>
          )}
          <p className="studio-auth-footnote">This page makes read-only GET requests. It does not sign wallet transactions, broadcast funds, initiate exchange transfers, or change an exchange account balance. For a missing or disputed deposit, verify directly with the exchange.</p>
        </main>
      </div>
    </div>
  )
}
