import { useEffect, useState } from 'react'
import { RefreshCw, History, AlertCircle } from 'lucide-react'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '')

type Props = {
  network: 'mainnet' | 'shasta'
  address: string
  contract?: string
}

type HistoryRecord = {
  transactionId: string | null
  network: string
  senderAddress: string | null
  receiverAddress: string
  tokenContract: string | null
  tokenName: string | null
  tokenSymbol: string | null
  tokenDecimals: number | null
  amountBaseUnits: string | null
  timestamp: number | null
  verificationStatus: string
  verifiedOnChain: boolean
}

function formatUnits(raw: string | null, decimals: number | null) {
  if (raw === null || decimals === null || !/^\d+$/.test(raw)) return raw || 'Unknown'
  const value = BigInt(raw)
  const scale = 10n ** BigInt(Math.min(decimals, 30))
  const whole = value / scale
  const fraction = (value % scale).toString().padStart(Math.min(decimals, 30), '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

function recordKey(record: HistoryRecord) {
  return [
    record.network,
    record.transactionId || '',
    record.tokenContract || '',
    record.senderAddress || '',
    record.receiverAddress || '',
    record.amountBaseUnits || '',
    record.timestamp || '',
  ].join(':')
}

export default function ReceiverHistory({ network, address, contract = '' }: Props) {
  const [records, setRecords] = useState<HistoryRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [lastChecked, setLastChecked] = useState<number | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [nextFingerprint, setNextFingerprint] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setInterval> | undefined
    const load = async (showLoading: boolean) => {
      if (!address.trim()) {
        if (active) {
          setRecords([])
          setError('Enter a receiver address in the balance/account panel to monitor incoming transfers.')
          setLoading(false)
        }
        return
      }
      if (showLoading && active) setLoading(true)
      try {
        const params = new URLSearchParams({ network, address: address.trim(), limit: '20' })
        if (contract.trim()) params.set('contract', contract.trim())
        const response = await fetch(`${API_BASE}/api/tron/receiver-history?${params.toString()}`, { headers: { Accept: 'application/json' } })
        const payload = await response.json()
        if (!response.ok || !payload?.success || !Array.isArray(payload.records)) {
          throw new Error(payload?.message || payload?.error || 'Incoming transfer history is unavailable.')
        }
        // Persisted worker results are optional: keep live indexer history
        // usable when DB monitoring is not configured, but prefer verified status.
        let persistedRecords: HistoryRecord[] = []
        try {
          const storedParams = new URLSearchParams({ network, address: address.trim(), limit: '50' })
          if (contract.trim()) storedParams.set('contract', contract.trim())
          const storedResponse = await fetch(`${API_BASE}/api/tron/receiver-history/persisted?${storedParams.toString()}`, { headers: { Accept: 'application/json' } })
          const storedPayload = await storedResponse.json()
          if (storedResponse.ok && storedPayload?.success && Array.isArray(storedPayload.records)) {
            persistedRecords = storedPayload.records
          }
        } catch { /* The live indexer feed remains available independently. */ }
        if (active) {
          setRecords((current) => {
            const incoming = [...persistedRecords, ...payload.records]
            const merged = showLoading ? incoming : [...incoming, ...current]
            const unique = new Map<string, HistoryRecord>()
            for (const record of merged) {
              const key = recordKey(record)
              const previous = unique.get(key)
              // Persisted worker evidence wins over indexer-only candidate data.
              if (!previous || record.verifiedOnChain || !previous.verifiedOnChain) unique.set(key, record)
            }
            return [...unique.values()]
          })
          setNextFingerprint((current) => showLoading || !current
            ? (typeof payload.nextFingerprint === 'string' && payload.nextFingerprint ? payload.nextFingerprint : null)
            : current)
          setError('')
          setLastChecked(Date.now())
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Incoming transfer history is unavailable.')
      } finally {
        if (active && showLoading) setLoading(false)
      }
    }
    void load(true)
    timer = setInterval(() => { void load(false) }, 30000)
    return () => {
      active = false
      if (timer) clearInterval(timer)
    }
  }, [network, address, contract, refreshNonce])

  const loadOlder = async () => {
    if (!nextFingerprint || loadingMore || !address.trim()) return
    setLoadingMore(true)
    try {
      const params = new URLSearchParams({ network, address: address.trim(), limit: '20', fingerprint: nextFingerprint })
      if (contract.trim()) params.set('contract', contract.trim())
      const response = await fetch(`${API_BASE}/api/tron/receiver-history?${params.toString()}`, { headers: { Accept: 'application/json' } })
      const payload = await response.json()
      if (!response.ok || !payload?.success || !Array.isArray(payload.records)) {
        throw new Error(payload?.message || payload?.error || 'Older receiver history is unavailable.')
      }
      setRecords((current) => {
        const unique = new Map<string, HistoryRecord>()
        for (const record of [...current, ...payload.records]) {
          unique.set(recordKey(record), record)
        }
        return [...unique.values()]
      })
      setNextFingerprint(typeof payload.nextFingerprint === 'string' && payload.nextFingerprint ? payload.nextFingerprint : null)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Older receiver history is unavailable.')
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <section className="rounded-xl border border-secondary bg-primary p-xl space-y-lg" aria-live="polite">
      <div className="flex flex-wrap items-start justify-between gap-md">
        <div className="flex items-start gap-sm">
          <History className="mt-xxs size-5 shrink-0 text-brand-primary" aria-hidden="true" />
          <div>
            <h2 className="text-heading-xs font-semibold text-primary">Incoming TRC-20 receiver history</h2>
            <p className="mt-xs text-xs text-tertiary">Selected network: {network} · Auto-refresh every 30 seconds while this panel is open.</p>
          </div>
        </div>
        <button type="button" onClick={() => setRefreshNonce((n) => n + 1)} disabled={loading} className="inline-flex items-center gap-xs rounded-lg border border-primary px-md py-sm text-sm font-semibold text-secondary disabled:opacity-50">
          <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
          {loading ? 'Loading history…' : 'Refresh history'}
        </button>
      </div>
      <div className="rounded-lg border border-utility-warning-200 bg-utility-warning-50 p-md text-xs text-utility-warning-700">
        Indexer records are incoming-transfer candidates, not final proof. A row is not marked completed until its exact transaction, solidified receipt, contract, sender, receiver and amount are independently verified. This panel does not change balances or promise exchange credit.
      </div>
      {error && <div className="flex items-start gap-sm rounded-lg border border-secondary bg-secondary p-md text-sm text-secondary"><AlertCircle className="mt-xxs size-4 shrink-0" />{error}</div>}
      {lastChecked !== null && <p className="text-xs text-tertiary">Last successful check: {new Date(lastChecked).toLocaleString()} · Receiver: <span className="break-all font-mono">{address || 'not set'}</span></p>}
      {!error && records.length === 0 && <p className="rounded-lg border border-secondary bg-secondary p-lg text-sm text-tertiary">No incoming TRC-20 records were returned for this address and filter. Indexers may lag; this is not proof that no transfer exists.</p>}
      <div className="space-y-md">
        {records.map((record, index) => (
          <article key={`${record.network}:${record.transactionId || index}:${record.tokenContract || ''}`} className="rounded-lg border border-secondary bg-secondary p-lg space-y-sm">
            <div className="flex flex-wrap items-center justify-between gap-sm">
              <p className="text-sm font-semibold text-primary">{record.tokenSymbol || record.tokenName || 'TRC-20 token'} · {formatUnits(record.amountBaseUnits, record.tokenDecimals)}</p>
              <span className={`rounded-full border px-sm py-xxs text-xs ${record.verifiedOnChain ? 'border-utility-success-200 text-utility-success-700' : record.verificationStatus === 'not-verified' ? 'border-utility-danger-200 text-utility-danger-700' : 'border-utility-warning-200 text-utility-warning-700'}`}>
                {record.verifiedOnChain ? 'Solidified on-chain verified' : record.verificationStatus === 'not-verified' ? 'Verification failed' : record.verificationStatus === 'provider-error' ? 'Verification provider error' : record.verificationStatus === 'awaiting-solidified-receipt' ? 'Awaiting solidified receipt' : 'Awaiting solidified verification'}
              </span>
            </div>
            <p className="text-xs text-tertiary">Network: {record.network} · Indexed time: {record.timestamp ? new Date(record.timestamp).toLocaleString() : 'not provided'}</p>
            <p className="break-all text-xs font-mono text-secondary">From: {record.senderAddress || 'unknown'}</p>
            <p className="break-all text-xs font-mono text-secondary">To: {record.receiverAddress}</p>
            <p className="break-all text-xs font-mono text-tertiary">Token contract: {record.tokenContract || 'not provided'}</p>
            {record.transactionId && <p className="break-all text-xs font-mono text-tertiary">Transaction ID: {record.transactionId}</p>}
            <p className="text-xs text-tertiary">On-chain verified: {record.verifiedOnChain ? 'yes — solidified receipt and exact Transfer event matched' : 'no'} · Exchange credit: not known</p>
          </article>
        ))}
      </div>
      {nextFingerprint && <div className="flex justify-center">
        <button type="button" onClick={() => void loadOlder()} disabled={loadingMore || loading} className="rounded-lg border border-primary px-md py-sm text-sm font-semibold text-secondary disabled:opacity-50">
          {loadingMore ? 'Loading older records…' : 'Load older records'}
        </button>
      </div>}
    </section>
  )
}
