import { useEffect, useState } from 'react'
import { Activity, AlertTriangle, CheckCircle2, RefreshCw, ShieldAlert } from 'lucide-react'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? '' : 'https://trc20-usdt-token-cloner-api.onrender.com')).replace(/\/+$/, '')

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
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`Endpoint returned an invalid JSON response (HTTP ${response.status}).`)
  }
  return { httpStatus: response.status, payload }
}

function errorItem(title: string, reason: unknown): Item {
  const detail = reason instanceof Error ? reason.message : 'The endpoint could not be reached.'
  return { title, tone: 'error', value: 'Unavailable', detail }
}

function statusItem(
  title: string,
  result: PromiseSettledResult<ProbeResponse | null>,
  evaluate: (result: ProbeResponse) => Item,
): Item {
  if (result.status === 'rejected') return errorItem(title, result.reason)
  if (result.value === null) return errorItem(title, new Error('This check is not supported on the selected network.'))
  return evaluate(result.value)
}

const initialItems: Item[] = [
  { title: 'Backend health', tone: 'checking', value: 'Checking…', detail: 'Reading /health' },
  { title: 'Database & provider readiness', tone: 'checking', value: 'Checking…', detail: 'Reading /api/readiness' },
  { title: 'Sponsorship authorization', tone: 'checking', value: 'Checking…', detail: 'Reading backend-enforced sponsorship policy' },
  { title: 'Sponsor chain balances', tone: 'checking', value: 'Checking…', detail: 'Reading verified balances for the selected network' },
  { title: 'Sponsor resource capacity', tone: 'checking', value: 'Checking…', detail: 'Reading solidified chain resource data' },
  { title: 'GasFree integration', tone: 'checking', value: 'Checking…', detail: 'Checking configured networks without exposing credentials' },
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
        readJson(`/api/tron/sponsorship/funding-status?network=${encodeURIComponent(network)}&refresh=1`),
        readJson(`/api/tron/sponsorship/resource-status?network=${encodeURIComponent(network)}&refresh=1`),
        readJson('/api/gasfree/config-status'),
        network === 'mainnet' ? readJson('/api/gasfree/capabilities?network=mainnet') : Promise.resolve(null),
      ])

      if (!active) return
      const [health, readiness, sponsorship, funding, resources, gasFreeConfig, gasFreeCapabilities] = results

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
          return {
            title: 'Database & provider readiness',
            tone: fullyReady ? 'healthy' : 'warning',
            value: fullyReady ? 'Read-only dependencies healthy' : 'Needs attention',
            detail: `Database: ${databaseReady ? 'ready' : 'not ready'} · Tatum read-only reachability: ${tatumReachable ? 'reachable' : 'not verified'} · HTTP ${httpStatus}. This does not authorize transfers.`,
          }
        }),
        statusItem('Sponsorship authorization', sponsorship, ({ httpStatus, payload }) => {
          const status = payload.sponsorship
          if (httpStatus !== 200 || !status) return { title: 'Sponsorship authorization', tone: 'error', value: 'Status unavailable', detail: `Sponsorship status endpoint returned HTTP ${httpStatus}.` }
          const enabled = status.enabled === true
            && status.canSubmitSponsoredTransfer === true
            && (network !== 'mainnet' || status.mainnetEnabled === true)
          return {
            title: 'Sponsorship authorization',
            tone: enabled ? 'healthy' : 'warning',
            value: enabled ? 'Backend reports enabled' : 'Disabled — fail-closed',
            detail: enabled
              ? `Backend reports a sponsorship capability for ${status.network || 'the configured network'}; transaction-specific funding and limits must still be checked.`
              : 'No verified sponsor authorization is active. This panel cannot activate it; no sponsor submission or user-funded fallback is available.',
          }
        }),
        statusItem('Sponsor chain balances', funding, ({ httpStatus, payload }) => {
          const snapshot = payload.funding
          if (!snapshot || typeof snapshot.onChainBalanceRead !== 'boolean') {
            return { title: 'Sponsor chain balances', tone: 'error', value: 'Unexpected response', detail: `Funding endpoint returned an unexpected response (HTTP ${httpStatus}).` }
          }
          const verified = httpStatus === 200 && payload.success === true && snapshot.onChainBalanceRead === true
          const nativeBalance = snapshot.native?.status === 'verified' && typeof snapshot.native.balanceTRX === 'string'
            ? `${snapshot.native.balanceTRX} TRX`
            : 'not verified'
          const verifiedTokenCount = Array.isArray(snapshot.tokens) ? snapshot.tokens.filter((token: any) => token?.status === 'verified').length : 0
          return {
            title: 'Sponsor chain balances',
            tone: verified ? 'healthy' : 'warning',
            value: verified ? 'Solidified-chain read verified' : (snapshot.status || 'Balance read incomplete'),
            detail: verified
              ? `Network: ${network}. Native TRX: ${nativeBalance}. Token balances verified: ${verifiedTokenCount}. Chain balances are not an approved budget, grant, or receiver credit.`
              : `Network: ${network}. ${snapshot.status || payload.error || 'No complete balance snapshot was verified'}. Do not treat missing/unavailable data as zero, and do not display this as receiver balance.`,
          }
        }),
        statusItem('Sponsor resource capacity', resources, ({ httpStatus, payload }) => {
          const snapshot = payload.resources
          const verified = httpStatus === 200 && payload.success === true && snapshot?.success === true && snapshot.resourceRead === true
          const energy = snapshot?.resources?.currentlyAvailableEnergy
          const bandwidth = snapshot?.resources?.currentlyAvailableBandwidth
          return {
            title: 'Sponsor resource capacity',
            tone: verified ? 'healthy' : 'warning',
            value: verified ? 'Solidified resource read verified' : (snapshot?.status || payload.error || 'Resource read incomplete'),
            detail: verified
              ? `Network: ${network}. Available Energy: ${energy ?? 'unknown'} · Bandwidth: ${bandwidth ?? 'unknown'}. Capacity is a snapshot, not proof a transaction will be fully covered.`
              : `Network: ${network}. Sponsor resource state is not verified. No delegation or transfer was made; no user-funded fallback is permitted.`,
          }
        }),
        statusItem('GasFree integration', gasFreeConfig, ({ httpStatus, payload }) => {
          const networks = payload.networks
          if (httpStatus !== 200 || !networks || typeof networks.mainnet?.configured !== 'boolean' || typeof networks.nile?.configured !== 'boolean') {
            return { title: 'GasFree integration', tone: 'error', value: 'Status unavailable', detail: `Credential diagnostic endpoint returned HTTP ${httpStatus} or an unexpected response.` }
          }
          const capabilityResult = gasFreeCapabilities.status === 'fulfilled' ? gasFreeCapabilities.value : null
          if (network === 'shasta') {
            return {
              title: 'GasFree integration',
              tone: 'warning',
              value: 'Shasta unsupported',
              detail: `GasFree is configured for Mainnet and Nile only; no cross-network fallback is used. Mainnet credentials: ${networks.mainnet.configured ? 'present' : 'missing'} · Nile credentials: ${networks.nile.configured ? 'present' : 'missing'}.`,
            }
          }
          const capability = capabilityResult && typeof capabilityResult === 'object' ? capabilityResult.payload : null
          const providerReachable = capabilityResult !== null
            && capabilityResult.httpStatus === 200
            && capability?.configured === true
            && capability?.reachable === true
          const credentialsPresent = networks.mainnet.configured === true
          return {
            title: 'GasFree integration',
            tone: providerReachable ? 'healthy' : 'warning',
            value: providerReachable ? 'Read-only provider API reachable' : credentialsPresent ? 'Provider reachability not verified' : 'Mainnet credentials missing',
            detail: `Mainnet credentials: ${credentialsPresent ? 'present' : 'missing'}. API reachability: ${providerReachable ? 'verified' : 'not verified'}${capability?.reason ? ` (${String(capability.reason)})` : ''}. Funding, provider authorization, and sponsored submission remain separate and are not enabled by this check.`,
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
        errorItem('Sponsorship authorization', new Error('Diagnostics request failed.')),
        errorItem('Sponsor chain balances', new Error('Diagnostics request failed.')),
        errorItem('Sponsor resource capacity', new Error('Diagnostics request failed.')),
        errorItem('GasFree integration', new Error('Diagnostics request failed.')),
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
          <p className="mt-xs text-xs text-tertiary">Live read-only checks for the selected {network === 'mainnet' ? 'TRON Mainnet' : 'Shasta testnet'} network, including actual sponsor chain balance and resource reads. None of these checks signs or submits a transfer.</p>
        </div>
        <button type="button" onClick={() => { setLoading(true); setRefreshNonce((value) => value + 1) }} disabled={loading} className="inline-flex items-center gap-xs rounded-lg border border-primary px-md py-sm text-xs font-semibold text-brand-primary disabled:opacity-50">
          <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
          {loading ? 'Checking integrations…' : 'Refresh all diagnostics'}
        </button>
      </div>
      <div className="mt-md grid grid-cols-1 gap-sm sm:grid-cols-2 xl:grid-cols-3">
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
        {' '}Credential values are never requested or displayed.
      </p>
    </section>
  )
}
