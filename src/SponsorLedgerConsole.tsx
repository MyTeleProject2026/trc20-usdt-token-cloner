import { useEffect, useState } from 'react'
import { AlertTriangle, ClipboardList, RefreshCw, ShieldAlert } from 'lucide-react'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? '' : 'https://trc20-usdt-token-cloner-api.onrender.com')).replace(/\/+$/, '')

type Network = 'mainnet' | 'shasta' | 'nile'
type Budget = {
  id?: string
  sponsor_reference?: string
  sponsor_address?: string
  network?: string
  purpose?: string
  asset?: string
  token_contract?: string | null
  budget_base_units?: string
  reserved_base_units?: string
  spent_base_units?: string
  ledger_available_base_units?: string
  status?: string
  approval_reference?: string | null
  review_reference?: string | null
  approved_at?: string | null
  created_at?: string
  updated_at?: string
}
type Transfer = {
  id?: string
  sponsor_reference?: string
  network?: string
  purpose?: string
  asset?: string
  token_contract?: string | null
  receiver_address?: string
  amount_base_units?: string
  status?: string
  transaction_hash?: string | null
  authorization_reference?: string | null
  created_at?: string
  updated_at?: string
}
type LedgerResult = { success: boolean; status?: string; budgets?: Budget[]; transfers?: Transfer[]; count?: number; truncated?: boolean; error?: string; message?: string; reason?: string }

async function protectedRead(path: string, token: string): Promise<LedgerResult> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    credentials: 'omit',
    cache: 'no-store',
  })
  const payload = await response.json().catch(() => null)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`Ledger endpoint returned invalid JSON (HTTP ${response.status}).`)
  }
  if (!response.ok || payload.success !== true) {
    const detail = typeof payload.message === 'string' ? payload.message
      : typeof payload.error === 'string' ? payload.error
        : typeof payload.reason === 'string' ? payload.reason
          : `HTTP ${response.status}`
    throw new Error(detail)
  }
  return payload as LedgerResult
}

function shortAddress(address?: string | null) {
  if (!address) return '—'
  return address.length > 18 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address
}

function units(value?: string | null) {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) ? value : '—'
}

function statusLabel(status?: string | null) {
  return typeof status === 'string' && status ? status.replaceAll('-', ' ') : 'unknown'
}

export default function SponsorLedgerConsole({ network }: { network: Network }) {
  const [adminToken, setAdminToken] = useState('')
  const [ledgerNetwork, setLedgerNetwork] = useState<Network>(network)
  const [transferStatus, setTransferStatus] = useState('')
  const [sponsorReference, setSponsorReference] = useState('')
  const [budgets, setBudgets] = useState<Budget[] | null>(null)
  const [transfers, setTransfers] = useState<Transfer[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [checkedAt, setCheckedAt] = useState<number | null>(null)

  useEffect(() => {
    setLedgerNetwork(network)
    setBudgets(null)
    setTransfers(null)
    setTruncated(false)
    setError('')
    setNotice('')
  }, [network])

  const loadLedger = async () => {
    const token = adminToken.trim()
    if (token.length < 32) {
      setError('Enter the server-configured sponsor admin token (at least 32 characters). The token is never saved to browser storage.')
      setNotice('')
      return
    }
    setLoading(true)
    setError('')
    setNotice('')
    try {
      const query = new URLSearchParams({ network: ledgerNetwork, limit: '100' })
      const transfersQuery = new URLSearchParams({ network: ledgerNetwork, limit: '100' })
      if (transferStatus) transfersQuery.set('status', transferStatus)
      if (sponsorReference.trim()) transfersQuery.set('sponsorReference', sponsorReference.trim())

      const [budgetResult, transferResult] = await Promise.all([
        protectedRead(`/api/tron/sponsorship/budgets?${query.toString()}`, token),
        protectedRead(`/api/tron/sponsorship/transfers?${transfersQuery.toString()}`, token),
      ])
      setBudgets(Array.isArray(budgetResult.budgets) ? budgetResult.budgets : [])
      setTransfers(Array.isArray(transferResult.transfers) ? transferResult.transfers : [])
      setTruncated(transferResult.truncated === true)
      setCheckedAt(Date.now())
      setNotice('Protected ledger records loaded. These are internal accounting/lifecycle records, not proof of chain settlement or exchange credit. No records were changed.')
    } catch (err) {
      setBudgets(null)
      setTransfers(null)
      setTruncated(false)
      setCheckedAt(Date.now())
      setError(err instanceof Error ? err.message : 'Could not load the protected sponsor ledger.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-lg" aria-labelledby="sponsor-ledger-heading" aria-live="polite">
      <div className="flex items-start gap-md">
        <span className="rounded-xl bg-utility-warning-50 p-md">
          <ClipboardList className="size-5 text-utility-warning-600" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 id="sponsor-ledger-heading" className="text-heading-xs font-semibold text-primary">Protected sponsor ledger & transfer audit</h2>
          <p className="mt-xs text-sm text-tertiary">Read-only access to the real PostgreSQL sponsor budget and transfer lifecycle tables. This panel does not create, activate, pause, reserve, sign, or submit transfers.</p>
        </div>
      </div>
      <div className="rounded-lg border border-utility-warning-200 bg-utility-warning-50 p-md text-xs text-utility-warning-700">
        <strong>Admin access required.</strong> Enter the server-side <code>SPONSOR_ADMIN_API_TOKEN</code>. The token remains in this component's memory only; it is not written to localStorage or sessionStorage. Never paste wallet keys or provider API secrets here.
      </div>
      <div className="grid grid-cols-1 gap-md md:grid-cols-2">
        <label className="flex flex-col gap-xs text-sm font-medium text-secondary">
          Sponsor admin token
          <input type="password" autoComplete="off" spellCheck={false} value={adminToken} onChange={(event) => setAdminToken(event.target.value)} maxLength={512} placeholder="Server-configured token (not a wallet key)" aria-label="Sponsor admin token" />
        </label>
        <label className="flex flex-col gap-xs text-sm font-medium text-secondary">
          Ledger network
          <select value={ledgerNetwork} onChange={(event) => { setLedgerNetwork(event.target.value as Network); setBudgets(null); setTransfers(null); setNotice(''); setError('') }}>
            <option value="shasta">Shasta testnet</option>
            <option value="nile">Nile testnet</option>
            <option value="mainnet">TRON Mainnet (read-only)</option>
          </select>
        </label>
        <label className="flex flex-col gap-xs text-sm font-medium text-secondary">
          Transfer status filter
          <select value={transferStatus} onChange={(event) => { setTransferStatus(event.target.value); setTransfers(null); setNotice('') }}>
            <option value="">All statuses</option>
            <option value="pending-review">Pending review</option>
            <option value="authorized">Authorized (ledger state only)</option>
            <option value="submitted">Submitted</option>
            <option value="confirmed">Confirmed (verify chain independently)</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </label>
        <label className="flex flex-col gap-xs text-sm font-medium text-secondary">
          Sponsor reference (optional)
          <input value={sponsorReference} onChange={(event) => { setSponsorReference(event.target.value); setTransfers(null); setNotice('') }} maxLength={128} placeholder="Filter transfer history" />
        </label>
      </div>
      <div className="flex flex-wrap gap-sm">
        <button type="button" onClick={() => void loadLedger()} disabled={loading || adminToken.trim().length < 32} className="inline-flex items-center gap-xs rounded-lg bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand disabled:opacity-50">
          <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
          {loading ? 'Loading protected ledger…' : 'Load / refresh ledger'}
        </button>
        <button type="button" onClick={() => { setAdminToken(''); setBudgets(null); setTransfers(null); setTruncated(false); setError(''); setNotice(''); setCheckedAt(null) }} disabled={loading} className="rounded-lg border border-primary px-md py-sm text-sm font-semibold text-secondary disabled:opacity-50">Clear token and records</button>
      </div>
      {error && <div role="alert" className="rounded-lg border border-utility-error-200 bg-utility-error-50 p-md text-sm text-utility-error-700"><strong>Ledger read failed:</strong> {error}. No records were changed.</div>}
      {notice && <p role="status" className="rounded-lg border border-secondary bg-secondary p-md text-xs text-tertiary">{notice}</p>}
      {checkedAt && !loading && <p className="text-xs text-tertiary">Last request completed at {new Date(checkedAt).toLocaleTimeString()}.</p>}
      {budgets !== null && (
        <div className="space-y-sm">
          <div className="flex flex-wrap items-center justify-between gap-sm">
            <h3 className="text-sm font-semibold text-primary">Sponsor budgets ({budgets.length})</h3>
            <span className="text-xs text-tertiary">{ledgerNetwork === 'mainnet' ? 'TRON Mainnet' : ledgerNetwork === 'nile' ? 'Nile testnet' : 'Shasta testnet'}</span>
          </div>
          <p className="text-xs text-tertiary">Amounts below are ledger base units. “Ledger available” = configured cap minus recorded reservations and spend; it is not a chain balance or spendable receiver credit.</p>
          {budgets.length === 0
            ? <p className="rounded-lg border border-secondary bg-secondary p-md text-sm text-tertiary">No sponsor budget rows were returned for this network.</p>
            : <div className="overflow-x-auto rounded-lg border border-secondary">
                <table className="min-w-[860px] text-left text-xs">
                  <thead><tr className="border-b border-secondary bg-secondary text-tertiary">
                    <th className="p-sm">ID / status</th><th className="p-sm">Sponsor</th><th className="p-sm">Purpose / asset</th><th className="p-sm">Budget (base units)</th><th className="p-sm">Reserved</th><th className="p-sm">Spent</th><th className="p-sm">Ledger available</th>
                  </tr></thead>
                  <tbody>{budgets.map((budget) => <tr key={budget.id} className="border-b border-secondary last:border-b-0">
                    <td className="p-sm"><span className="font-mono">{budget.id || '—'}</span><span className="mt-xs block capitalize text-tertiary">{statusLabel(budget.status)}</span></td>
                    <td className="p-sm"><span>{budget.sponsor_reference || '—'}</span><span className="mt-xs block font-mono text-tertiary">{shortAddress(budget.sponsor_address)}</span></td>
                    <td className="p-sm">{budget.purpose || '—'} / {budget.asset || '—'}<span className="mt-xs block break-all text-tertiary">{budget.token_contract || 'native asset'}</span></td>
                    <td className="p-sm font-mono">{units(budget.budget_base_units)}</td>
                    <td className="p-sm font-mono">{units(budget.reserved_base_units)}</td>
                    <td className="p-sm font-mono">{units(budget.spent_base_units)}</td>
                    <td className="p-sm font-mono">{units(budget.ledger_available_base_units)}</td>
                  </tr>)}</tbody>
                </table>
              </div>}
        </div>
      )}
      {transfers !== null && (
        <div className="space-y-sm">
          <div className="flex flex-wrap items-center justify-between gap-sm">
            <h3 className="text-sm font-semibold text-primary">Transfer lifecycle records ({transfers.length})</h3>
            {truncated && <span className="text-xs text-utility-warning-600">History truncated — refine filters.</span>}
          </div>
          <p className="text-xs text-tertiary">These are internal lifecycle rows, not independent chain proof. Confirm transaction hashes and exact sender/receiver/asset/amount with the separate solidified-chain verifier.</p>
          {transfers.length === 0
            ? <p className="rounded-lg border border-secondary bg-secondary p-md text-sm text-tertiary">No transfer lifecycle rows matched the selected filters.</p>
            : <div className="overflow-x-auto rounded-lg border border-secondary">
                <table className="min-w-[800px] text-left text-xs">
                  <thead><tr className="border-b border-secondary bg-secondary text-tertiary">
                    <th className="p-sm">ID / status</th><th className="p-sm">Sponsor / purpose</th><th className="p-sm">Receiver</th><th className="p-sm">Asset / amount (base units)</th><th className="p-sm">Transaction hash</th><th className="p-sm">Updated</th>
                  </tr></thead>
                  <tbody>{transfers.map((transfer) => <tr key={transfer.id} className="border-b border-secondary last:border-b-0">
                    <td className="p-sm"><span className="font-mono">{transfer.id || '—'}</span><span className="mt-xs block capitalize text-tertiary">{statusLabel(transfer.status)}</span></td>
                    <td className="p-sm">{transfer.sponsor_reference || '—'}<span className="mt-xs block text-tertiary">{transfer.purpose || '—'}</span></td>
                    <td className="p-sm font-mono">{shortAddress(transfer.receiver_address)}</td>
                    <td className="p-sm">{transfer.asset || '—'}<span className="mt-xs block font-mono">{units(transfer.amount_base_units)}</span></td>
                    <td className="p-sm font-mono break-all">{transfer.transaction_hash || 'not submitted'}</td>
                    <td className="p-sm text-tertiary">{transfer.updated_at ? new Date(transfer.updated_at).toLocaleString() : '—'}</td>
                  </tr>)}</tbody>
                </table>
              </div>}
        </div>
      )}
      <div className="flex items-start gap-sm rounded-lg border border-secondary bg-secondary p-md text-xs text-tertiary">
        <ShieldAlert className="mt-xxs size-4 shrink-0 text-utility-warning-600" aria-hidden="true" />
        <p>Read-only audit view only. Budget activation remains dependent on the server-side agreement allowlist and fresh on-chain funding checks. Sponsored transaction submission is independently disabled. A confirmed chain transfer does not guarantee exchange credit.</p>
      </div>
    </section>
  )
}
