import { useEffect, useRef, useState } from 'react'
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
  eventIndex?: string | null
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
    record.eventIndex ?? '',
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
  const [notification, setNotification] = useState<{ key: string; message: string; transactionId: string | null } | null>(null)
  const [browserPermission, setBrowserPermission] = useState<NotificationPermission | 'unsupported'>(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  )
  const seenVerifiedKeys = useRef<Set<string>>(new Set())
  const historyInitialized = useRef(false)

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setInterval> | undefined
    // Do not treat old transactions as new notifications when the watched
    // address/network/filter changes or the user explicitly refreshes history.
    seenVerifiedKeys.current.clear()
    historyInitialized.current = false
    setNotification(null)
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
        // Persisted worker results are optional. Keep the live indexer feed
        // usable when database monitoring is unavailable, but prefer verified status.
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
          const incoming = [...persistedRecords, ...payload.records]
          const confirmedIncoming = incoming.filter((record) =>
            record.verifiedOnChain === true && record.verificationStatus === 'verified-on-chain',
          )
          if (!historyInitialized.current) {
            // Initial history is a baseline, not a stream of alerts for old transfers.
            for (const record of confirmedIncoming) seenVerifiedKeys.current.add(recordKey(record))
            historyInitialized.current = true
          } else {
            const newlyVerified = confirmedIncoming.find((record) => !seenVerifiedKeys.current.has(recordKey(record)))
            for (const record of confirmedIncoming) seenVerifiedKeys.current.add(recordKey(record))
            if (newlyVerified) {
              const symbol = newlyVerified.tokenSymbol || 'TRC-20 token'
              const amount = formatUnits(newlyVerified.amountBaseUnits, newlyVerified.tokenDecimals)
              const message = `Verified incoming ${amount} ${symbol} transfer observed on ${network}. Exchange credit is separate.`
              const key = recordKey(newlyVerified)
              setNotification({
                key,
                message,
                transactionId: newlyVerified.transactionId,
              })
              // Browser/system notifications are opt-in and only fire for a
              // newly observed, already solidified-and-verified incoming event.
              if (browserPermission === 'granted' && typeof Notification !== 'undefined') {
                try {
                  new Notification('Verified incoming transfer', { body: message, tag: key })
                } catch {
                  // In-app notification remains available if system notifications fail.
                }
              }
            }
          }
          setRecords((current) => {
            const merged = showLoading ? incoming : [...incoming, ...current]
            const unique = new Map<string, HistoryRecord>()
            for (const record of merged) {
              const key = recordKey(record)
              const previous = unique.get(key)
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
        if (active) {
          // If the live indexer is down, still show any history already saved by
          // the background worker rather than hiding persisted verification.
          let persistedOnly: HistoryRecord[] = []
          try {
            const storedParams = new URLSearchParams({ network, address: address.trim(), limit: '50' })
            if (contract.trim()) storedParams.set('contract', contract.trim())
            const storedResponse = await fetch(`${API_BASE}/api/tron/receiver-history/persisted?${storedParams.toString()}`, { headers: { Accept: 'application/json' } })
            const storedPayload = await storedResponse.json()
            if (storedResponse.ok && storedPayload?.success && Array.isArray(storedPayload.records)) {
              persistedOnly = storedPayload.records
            }
          } catch { /* Keep the original indexer error if persistence is unavailable too. */ }
          if (persistedOnly.length) {
            setRecords(persistedOnly)
            setLastChecked(Date.now())
            setError('Live indexer is unavailable; showing saved receiver history. New events may be delayed.')
          } else {
            setError(err instanceof Error ? err.message : 'Incoming transfer history is unavailable.')
          }
        }
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
  }, [network, address, contract, refreshNonce, browserPermission])

  const enableBrowserNotifications = async () => {
    if (typeof Notification === 'undefined') {
      setBrowserPermission('unsupported')
      return
    }
    try {
      const permission = await Notification.requestPermission()
      setBrowserPermission(permission)
      if (permission !== 'granted') {
        setError(permission === 'denied'
          ? 'Device notifications are blocked in browser settings. In-app verified-transfer messages remain available while this panel is open.'
          : 'Device notifications were not enabled. In-app verified-transfer messages remain available while this panel is open.')
      } else {
        setError('')
      }
    } catch {
      setError('Could not request device notification permission. In-app verified-transfer messages remain available while this panel is open.')
    }
  }

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
        <div className="flex flex-wrap items-center gap-sm">
          {browserPermission === 'granted' ? (
            <span role="status" className="text-xs text-utility-success-700">Device notifications enabled</span>
          ) : browserPermission === 'unsupported' ? (
            <span className="text-xs text-tertiary">Device notifications unsupported; in-app messages still work.</span>
          ) : (
            <button type="button" onClick={() => void enableBrowserNotifications()} className="rounded-lg border border-primary px-md py-sm text-sm font-semibold text-secondary">
              Enable device notifications
            </button>
          )}
          <button type="button" onClick={() => setRefreshNonce((n) => n + 1)} disabled={loading} className="inline-flex items-center gap-xs rounded-lg border border-primary px-md py-sm text-sm font-semibold text-secondary disabled:opacity-50">
            <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'Loading history…' : 'Refresh history'}
          </button>
        </div>
      </div>
      <div className="rounded-lg border border-utility-warning-200 bg-utility-warning-50 p-md text-xs text-utility-warning-700">
        Indexer records are incoming-transfer candidates, not final proof. A row is not marked completed until its exact transaction, solidified receipt, contract, sender, receiver and amount are independently verified. This panel does not change balances or promise exchange credit.
      </div>
      {error && <div className="flex items-start gap-sm rounded-lg border border-secondary bg-secondary p-md text-sm text-secondary"><AlertCircle className="mt-xxs size-4 shrink-0" />{error}</div>}
      {notification && <div role="status" aria-live="polite" className="rounded-lg border border-utility-success-200 bg-utility-success-50 p-md text-sm text-utility-success-700">
        <div className="flex items-start justify-between gap-md">
          <div className="min-w-0">
            <p className="font-semibold">Verified incoming transfer notification</p>
            <p className="mt-xs">{notification.message}</p>
            {notification.transactionId && <p className="mt-xs break-all font-mono text-xs">Transaction: {notification.transactionId}</p>}
            <p className="mt-xs text-xs">In-app notifications appear while this panel is open. Optional device notifications require browser permission and this page to be running; they are not push notifications from another wallet or exchange and do not prove exchange-account credit.</p>
          </div>
          <button type="button" onClick={() => setNotification(null)} className="shrink-0 rounded border border-current px-sm py-xs text-xs">Dismiss</button>
        </div>
      </div>}
      {lastChecked !== null && <p className="text-xs text-tertiary">Last successful check: {new Date(lastChecked).toLocaleString()} · Receiver: <span className="break-all font-mono">{address || 'not set'}</span></p>}
      {!error && records.length === 0 && <p className="rounded-lg border border-secondary bg-secondary p-lg text-sm text-tertiary">No incoming TRC-20 records were returned for this address and filter. Indexers may lag; this is not proof that no transfer exists.</p>}
      <div className="space-y-md">
        {records.map((record, index) => (
          <article key={`${record.network}:${record.transactionId || index}:${record.tokenContract || ''}:${record.eventIndex ?? ''}`} className="rounded-lg border border-secondary bg-secondary p-lg space-y-sm">
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
