import { useEffect, useState } from 'react'
import { Activity, AlertTriangle, CheckCircle2, RefreshCw, ShieldAlert } from 'lucide-react'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? '' : 'https://trc20-usdt-token-cloner-api.onrender.com')).replace(/\\/+$/, '')

type ProbeResponse = { httpStatus: number; payload: any }
type Tone = 'checking' | 'healthy' | 'warning' | 'error'
type Item = { title: string; tone: Tone; value: string; detail: string }

async function readJson(path: string): Promise<ProbeResponse> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    credentials: 'omit',
  })
  const payload = await response.json().catch(() => null)
  if (!payload || typeof payload !== 'object') {
    throw new Error(`Endpoint returned an invalid JSON response (HTTP ${response.status}).`)
  }
  return { httpStatus: response.status, payload }
}

function errorItem(title: string, reason: unknown): Item {
  const detail = reason instanceof Error ? reason.message : 'The endpoint could not be reached.'
  return { title, tone: 'error', value: 'Unavailable', detail }
}

function statusItem(title: string, result: PromiseSettledResult<ProbeResponse>, evaluate: (result: ProbeResponse) => Item): Item {
  if (result.status === 'rejected') return errorItem(title, result.reason)
  return evaluate(result.value)
}

const initialItems: Item[] = [
  { title: 'Backend health', tone: 'checking', value: 'Checking…', detail: 'Reading /health' },
  { title: 'Database & provider readiness', tone: 'checking', value: 'Checking…', detail: 'Reading /api/readiness' },
  { title: 'Fee sponsorship', tone: 'checking', value: 'Checking…', detail: 'Reading server-enforced sponsorship status' },
  { title: 'GasFree credentials', tone: 'checking', value: 'Checking…', detail: 'Checking credential presence only' },
]

export default function IntegrationHealthPanel({ network }: { network: 'shasta' | 'mainnet' }) {
  const [items, setItems] = useState<Item[]>(initialItems)
  const [loading, setLoading] = useState(true)
  const [checkedAt, setCheckedAt] = useState<number | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true)

    const run = async () => {
      const results = await Promise.allSettled([
        readJson('/health'),
        readJson('/api/readiness'),
        readJson('/api/tron/sponsorship/status'),
        readJson('/api/gasfree/config-status'),
      ] as const)

      if (!active) return
      const [health, readiness, sponsorship, gasFree] = results

      const nextItems: Item[] = [
        statusItem('Backend health', health, ({ httpStatus, payload }) => {
          const ok = httpStatus === 200 && payload.status === 'ok'
          return {
            title: 'Backend health',
            tone: ok ? 'healthy' : 'error',
            value: ok ? 'Online' : `HTTP ${httpStatus}`,
            detail: ok ? 'The backend health endpoint responded successfully.' : 'The backend did not return its expected healthy response.',
          }
        }),
        statusItem('Database & provider readiness', readiness, ({ httpStatus, payload }) => {
          const shapeValid = typeof payload.success === 'boolean' && payload.database && payload.providers?.tatum
          if (!shapeValid) return { title: 'Database & provider readiness', tone: 'error', value: 'Unexpected response', detail: `Readiness response shape was not recognized (HTTP ${httpStatus}).` }
          const databaseReady = payload.database.configured === true && payload.database.ready === true
          const tatumReachable = payload.providers.tatum.reachable === true
          const fullyReady = payload.success === true && httpStatus === 200 && databaseReady && tatumReachable
          const state = fullyReady ? 'healthy' : (httpStatus === 503 || !databaseReady || !tatumReachable ? 'warning' : 'error')
          return {
            title: 'Database & provider readiness',
            tone: state,
            value: fullyReady ? 'Read-only dependencies healthy' : 'Needs attention',
            detail: `Database: ${databaseReady ? 'ready' : 'not ready'} · Tatum read-only reachability: ${tatumReachable ? 'reachable' : 'not verified'} · HTTP ${httpStatus}. This does not authorize transfers.`,
          }
        }),
        statusItem('Fee sponsorship', sponsorship, ({ httpStatus, payload }) => {
          const status = payload.sponsorship
          if (httpStatus !== 200 || !status) return { title: 'Fee sponsorship', tone: 'error', value: 'Status unavailable', detail: `Sponsorship status endpoint returned HTTP ${httpStatus}.` }
          const enabled = status.enabled === true && status.canSubmitSponsoredTransfer === true && (network !== 'mainnet' || status.mainnetEnabled === true)
          return {
            title: 'Fee sponsorship',
            tone: enabled ? 'healthy' : 'warning',
            value: enabled ? 'Enabled by backend' : 'Disabled — fail-closed',
            detail: enabled
              ? `Backend reports capability on ${status.network || 'the configured network'}; confirm funding and transaction-specific conditions separately.`
              : 'No verified sponsor authorization is active. No sponsored transfer is available and no user-funded fallback is permitted.',
          }
        }),
        statusItem('GasFree credentials', gasFree, ({ httpStatus, payload }) => {
          const networks = payload.networks
          if (httpStatus !== 200 || !networks || typeof networks.mainnet?.configured !== 'boolean' || typeof networks.nile?.configured !== 'boolean') {
            return { title: 'GasFree credentials', tone: 'error', value: 'Status unavailable', detail: `Credential diagnostic endpoint returned HTTP ${httpStatus} or an unexpected response.` }
          }
          const chosen = network === 'mainnet' ? networks.mainnet : networks.nile
          return {
            title: 'GasFree credentials',
            tone: chosen.configured ? 'warning' : 'warning',
            value: chosen.configured ? `${network === 'mainnet' ? 'Mainnet' : 'Nile'} credentials present` : `${network === 'mainnet' ? 'Mainnet' : 'Nile'} credentials missing`,
            detail: `Mainnet: ${networks.mainnet.configured ? 'configured' : 'missing'} · Nile: ${networks.nile.configured ? 'configured' : 'missing'}. Credential presence does not prove provider reachability or sponsor funding; submission remains disabled.`,
          }
        }),
      ]

      setItems(nextItems)
      setCheckedAt(Date.now())
      setLoading(false)
    }

    void run().catch(() => {
      if (!active) return
      setItems([
        errorItem('Backend health', new Error('Diagnostics request failed.')),
        errorItem('Database & provider readiness', new Error('Diagnostics request failed.')),
        errorItem('Fee sponsorship', new Error('Diagnostics request failed.')),
        errorItem('GasFree credentials', new Error('Diagnostics request failed.')),
      ])
      setCheckedAt(Date.now())
      setLoading(false)
    })

    return () => { active = false }
  }, [network, refreshNonce])

  const iconFor = (tone: Tone) => {
    if (tone === 'healthy') return <CheckCircle2 className="size-4 text-utility-success-600" aria-hidden="true" />
    if (tone === 'warning') return <ShieldAlert className="size-4 text-utility-warning-600" aria-hidden="true" />
    if (tone === 'error') return <AlertTriangle className="size-4 text-utility-error-600" aria-hidden="true" />
    return <Activity className="size-4 animate-pulse text-fg-tertiary" aria-hidden="true" />
  }

  return (
    <section className="mb-xl rounded-xl border border-secondary bg-primary p-lg" aria-labelledby="integration-health-heading" aria-live="polite">
      <div className="flex flex-wrap items-start justify-between gap-md">
        <div className="min-w-0">
          <div className="flex items-center gap-sm">
            <Activity className="size-5 text-fg-brand-primary" aria-hidden="true" />
            <h2 id="integration-health-heading" className="text-sm font-semibold text-primary">Live integration diagnostics</h2>
          </div>
          <p className="mt-xs text-xs text-tertiary">Read-only endpoint checks for the selected {network === 'mainnet' ? 'TRON Mainnet' : 'Shasta testnet'} workspace. A healthy endpoint is not proof of funded sponsorship or transfer authorization.</p>
        </div>
        <button type="button" onClick={() => { setLoading(true); setRefreshNonce((value) => value + 1) }} disabled={loading} className="inline-flex items-center gap-xs rounded-lg border border-primary px-md py-sm text-xs font-semibold text-brand-primary disabled:opacity-50">
          <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
          {loading ? 'Checking integrations…' : 'Refresh diagnostics'}
        </button>
      </div>
      <div className="mt-md grid grid-cols-1 gap-sm sm:grid-cols-2 xl:grid-cols-4">
        {items.map((item) => (
          <article key={item.title} className="rounded-lg border border-secondary bg-secondary p-md">
            <div className="flex items-center gap-xs">{iconFor(item.tone)}<p className="text-xs font-semibold text-primary">{item.title}</p></div>
            <p className="mt-sm text-sm font-semibold text-primary">{item.value}</p>
            <p className="mt-xs text-xs leading-relaxed text-tertiary">{item.detail}</p>
          </article>
        ))}
      </div>
      <p className="mt-sm text-xs text-tertiary">
        {loading ? 'Checking current endpoint responses…' : checkedAt ? `Last checked: ${new Date(checkedAt).toLocaleTimeString()}.` : 'No check has completed yet.'}
        {' '}Secrets are never requested or shown in this panel.
      </p>
    </section>
  )
}
