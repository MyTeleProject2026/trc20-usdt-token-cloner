import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, AlertTriangle, ArrowDownUp, CheckCircle2, Clock3, Database, ExternalLink, Gauge, Radio, RefreshCw, Server, ShieldCheck, Zap } from 'lucide-react'
import './platform-monitor.css'
import RuntimeObservatory from './RuntimeObservatory.jsx'

const RESOURCE_API = (import.meta.env.VITE_RESOURCE_API_URL || 'https://tron-transfer-resource-api.onrender.com').replace(/\/$/, '')
const OWNER = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const POLL_MS = 15_000

async function readJson(url, timeoutMs = 8_000) {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  const started = performance.now()
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal, headers: { accept: 'application/json' } })
    const latencyMs = Math.round(performance.now() - started)
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.message || payload.error || `HTTP ${response.status}`)
    return { payload, latencyMs, statusCode: response.status }
  } finally {
    window.clearTimeout(timer)
  }
}

function stamp(value) {
  return value ? new Date(value).toLocaleTimeString() : 'Waiting for first check'
}
function shortAddress(value) {
  return value ? value.slice(0, 9) + '…' + value.slice(-6) : 'Not connected'
}
function StatePill({ state }) {
  const label = state === 'online' ? 'OPERATIONAL' : state === 'checking' ? 'CHECKING' : state === 'warning' ? 'DEGRADED' : state === 'offline' ? 'OFFLINE' : 'NOT CHECKED'
  return <span className={`pm-pill ${state || 'unknown'}`}><i/>{label}</span>
}

export default function PlatformMonitor({ wallet, onNavigate }) {
  const [health, setHealth] = useState({ state: 'checking' })
  const [resources, setResources] = useState({ state: 'checking' })
  const [promo, setPromo] = useState({ state: 'checking' })
  const [tokenApi, setTokenApi] = useState({ state: 'unknown', message: 'Not yet independently checked from this browser.' })
  const [events, setEvents] = useState([])
  const [refreshing, setRefreshing] = useState(false)
  const [lastCycle, setLastCycle] = useState(null)
  const [cycleCount, setCycleCount] = useState(0)
  const alive = useRef(true)
  const inFlight = useRef(false)

  const record = useCallback((title, detail, state = 'online') => {
    setEvents(previous => [{ id: `${Date.now()}-${Math.random()}`, at: new Date().toISOString(), title, detail, state }, ...previous].slice(0, 30))
  }, [])

  const refresh = useCallback(async (manual = false) => {
    if (inFlight.current) return
    inFlight.current = true
    if (manual) setRefreshing(true)
    const checkedAt = new Date().toISOString()
    const [h, r, t] = await Promise.allSettled([
      readJson(RESOURCE_API + '/health'),
      readJson(RESOURCE_API + '/v1/resources/' + OWNER),
      readJson(RESOURCE_API + '/api/tron/tenergy/promo?address=' + encodeURIComponent(OWNER)),
    ])
    if (!alive.current) { inFlight.current = false; return }
    if (h.status === 'fulfilled') {
      const body = h.value.payload
      const state = body.ok && body.network === 'TRON Mainnet' ? 'online' : 'warning'
      setHealth({ state, payload: body, latencyMs: h.value.latencyMs, checkedAt, message: body.rpc || 'Health response received' })
      if (state !== 'online') record('Resource API health changed', 'Health endpoint returned an unexpected network or status.', 'warning')
    } else {
      setHealth({ state: 'offline', message: h.reason?.message || 'Health check failed', checkedAt })
      record('Resource API unreachable', h.reason?.message || 'Health request failed', 'offline')
    }
    if (r.status === 'fulfilled') {
      const body = r.value.payload
      const valid = body.network === 'TRON Mainnet' && body.address === OWNER && body.energy && body.bandwidth
      setResources({ state: valid ? 'online' : 'warning', payload: body, latencyMs: r.value.latencyMs, checkedAt, message: valid ? 'Live account resources received from Mainnet RPC.' : 'Resource response did not match expected schema.' })
      if (valid) record('Mainnet resource snapshot refreshed', `Energy ${body.energy.available} available · Bandwidth ${body.bandwidth.maxSingleTransactionAvailable} max single-transaction bytes · RPC ${Object.values(body.rpc?.providersUsed || {}).join('/') || 'provider not reported'}`)
    } else {
      setResources({ state: 'offline', message: r.reason?.message || 'Resource read failed', checkedAt })
      record('Mainnet resource read failed', r.reason?.message || 'Resource endpoint failed', 'offline')
    }
    if (t.status === 'fulfilled') {
      const body = t.value.payload
      const redemption = body.redemption
      const state = body.success ? (body.promo?.state === 'active' ? 'online' : 'warning') : 'warning'
      setPromo({ state, payload: body, latencyMs: t.value.latencyMs, checkedAt, message: body.promo?.state || body.error || 'Provider responded' })
      if (redemption?.status) record('TEnergy redemption state observed', `Provider status: ${redemption.status}`, redemption.status === 'delegated' ? 'online' : 'warning')
    } else {
      setPromo({ state: 'warning', message: t.reason?.message || 'TEnergy status unavailable', checkedAt })
      record('TEnergy status unavailable', t.reason?.message || 'Provider check failed', 'warning')
    }
    setLastCycle(checkedAt)
    setCycleCount(value => value + 1)
    setRefreshing(false)
    inFlight.current = false
  }, [record])

  useEffect(() => {
    alive.current = true
    refresh()
    const timer = window.setInterval(() => refresh(), POLL_MS)
    return () => { alive.current = false; window.clearInterval(timer) }
  }, [refresh])

  const resource = resources.payload
  const providers = health.payload?.rpcProviderPriority || []
  const providerUsed = resource?.rpc?.providersUsed || {}
  const ownerConnected = wallet?.address === OWNER
  const energy = resource?.energy?.available
  const bandwidth = resource?.bandwidth?.maxSingleTransactionAvailable
  const checks = [
    { label: 'Resource API', state: health.state, detail: health.message, latency: health.latencyMs },
    { label: 'TRON Mainnet RPC', state: resources.state, detail: Object.entries(providerUsed).length ? Object.entries(providerUsed).map(([k,v]) => `${k}: ${v}`).join(' · ') : resources.message, latency: resources.latencyMs },
    { label: 'TEnergy promotion', state: promo.state, detail: promo.message, latency: promo.latencyMs },
    { label: 'Owner wallet session', state: ownerConnected ? 'online' : 'warning', detail: ownerConnected ? 'Configured owner address connected in TronLink.' : 'Connect the configured owner wallet to authorize a promo claim.' },
  ]

  return <section className="platform-monitor" aria-label="Tron Transfer platform monitoring">
    <div className="pm-hero">
      <div>
        <span className="pm-eyebrow"><Radio size={13}/> TRON TRANSFER · OPERATIONS CENTER</span>
        <h2>Platform command center</h2>
        <p>Live checks against deployed services and TRON Mainnet. Every indicator below is based on a real endpoint response, not a simulated status.</p>
      </div>
      <div className="pm-hero-actions"><span className="pm-live"><i/> LIVE POLLING · 15 SEC</span><button className="pm-refresh" onClick={() => refresh(true)} disabled={refreshing}><RefreshCw size={15} className={refreshing ? 'pm-spin' : ''}/>{refreshing ? 'Refreshing' : 'Refresh now'}</button></div>
    </div>

    <RuntimeObservatory apiBase={RESOURCE_API} resourceState={resources.state} promoState={promo.state}/>

    <div className="pm-summary-grid">
      <article className="pm-summary-card"><span>Resource API</span><b><StatePill state={health.state}/></b><small>{health.latencyMs != null ? `${health.latencyMs} ms response` : health.message || 'Waiting for check'}</small></article>
      <article className="pm-summary-card"><span>Mainnet Energy</span><b>{energy == null ? '—' : Number(energy).toLocaleString()}</b><small>{energy === 0 ? 'No available Energy reported' : 'Available from current account snapshot'}</small></article>
      <article className="pm-summary-card"><span>Bandwidth coverage</span><b>{bandwidth == null ? '—' : Number(bandwidth).toLocaleString()}</b><small>Maximum bytes covered by one source</small></article>
      <article className="pm-summary-card"><span>Monitor cycles</span><b>{cycleCount}</b><small>Last successful cycle: {stamp(lastCycle)}</small></article>
    </div>

    <div className="pm-section-heading"><div><span className="pm-eyebrow">SERVICE CONNECTIVITY</span><h3>Live connection matrix</h3><p>Health, response latency and current integration evidence.</p></div><span className="pm-update-time"><Clock3 size={14}/> Last check {stamp(lastCycle)}</span></div>
    <div className="pm-connection-grid">
      {checks.map(item => <article className="pm-connection-card" key={item.label}><div className="pm-card-top"><span className="pm-service-icon"><Server size={17}/></span><StatePill state={item.state}/></div><h4>{item.label}</h4><p>{item.detail || 'Waiting for endpoint response.'}</p><small>{item.latency != null ? `Response ${item.latency} ms` : 'Live status'}</small></article>)}
    </div>

    <div className="pm-main-grid">
      <article className="pm-panel">
        <div className="pm-panel-heading"><div><span className="pm-eyebrow">PROVIDER ROUTING</span><h3>Tatum & TronGrid RPC</h3></div><ShieldCheck size={19}/></div>
        <div className="pm-provider-row"><span>Tatum Mainnet</span><StatePill state={providers.includes('tatum') ? 'online' : 'warning'}/></div>
        <div className="pm-provider-row"><span>TronGrid fallback</span><StatePill state={providers.includes('trongrid') ? 'online' : 'warning'}/></div>
        <p className="pm-footnote">Configured priority: {providers.join(' → ') || 'Not reported'}. Actual provider use is shown from the last account-resource response, not inferred from environment-variable presence.</p>
        <div className="pm-provider-used">{Object.entries(providerUsed).map(([key,value]) => <span key={key}><b>{key}</b>{value}</span>)}</div>
      </article>
      <article className="pm-panel">
        <div className="pm-panel-heading"><div><span className="pm-eyebrow">PROMOTIONAL RESOURCE</span><h3>TEnergy authorization</h3></div><Zap size={19}/></div>
        <div className="pm-provider-row"><span>Promotion state</span><StatePill state={promo.state}/></div>
        <p className="pm-footnote">{promo.payload?.promo?.state ? `Provider promotion: ${promo.payload.promo.state}` : promo.message || 'Awaiting provider response.'}</p>
        <p className="pm-footnote">Claim requires a TronLink message signature. TEnergy provides Energy only; it does not provide Bandwidth or deployment fees.</p>
        {promo.payload?.redemption?.status && <div className="pm-provider-used"><span><b>Redemption</b>{promo.payload.redemption.status}</span></div>}
        <button className="pm-action" onClick={() => onNavigate('deploy')}>Open deployment & claim workflow <ExternalLink size={14}/></button>
      </article>
    </div>

    <div className="pm-section-heading"><div><span className="pm-eyebrow">RESOURCE INTELLIGENCE</span><h3>Mainnet resource snapshot</h3><p>Current account resources for the configured owner address.</p></div><span className="pm-owner">{shortAddress(OWNER)}</span></div>
    <div className="pm-resource-grid">
      <article><span>Energy available</span><b>{energy == null ? '—' : Number(energy).toLocaleString()}</b><small>Limit {resource?.energy?.limit ?? '—'} · Used {resource?.energy?.used ?? '—'}</small></article>
      <article><span>Free Bandwidth</span><b>{resource?.bandwidth?.freeAvailable ?? '—'}</b><small>Limit {resource?.bandwidth?.freeLimit ?? '—'} · Used {resource?.bandwidth?.freeUsed ?? '—'}</small></article>
      <article><span>Staked / delegated Bandwidth</span><b>{resource?.bandwidth?.stakedOrDelegatedAvailable ?? '—'}</b><small>Limit {resource?.bandwidth?.stakedOrDelegatedLimit ?? '—'} · Used {resource?.bandwidth?.stakedOrDelegatedUsed ?? '—'}</small></article>
      <article><span>Native TRX balance</span><b>{resource?.balanceSun == null ? '—' : (Number(resource.balanceSun) / 1_000_000).toFixed(6)}</b><small>TRX · read from Mainnet account</small></article>
    </div>
    <div className="pm-caution"><AlertTriangle size={16}/><span>Free and staked/delegated Bandwidth are not combined to cover one transaction. No public Energy grant, Bandwidth sponsorship or zero-cost deployment is assumed. A deployment must pass its own exact resource simulation.</span></div>

    <div className="pm-section-heading"><div><span className="pm-eyebrow">EVENT STREAM</span><h3>Live integration activity</h3><p>Timestamped observations produced by real polling cycles in this browser session.</p></div><span className="pm-count">{events.length} events</span></div>
    <div className="pm-event-list" aria-live="polite">
      {events.length === 0 ? <p className="pm-empty">Waiting for first monitoring cycle…</p> : events.map(event => <div className="pm-event" key={event.id}><span className={`pm-event-dot ${event.state}`}/><time>{stamp(event.at)}</time><b>{event.title}</b><span>{event.detail}</span></div>)}
    </div>
    <div className="pm-footer-actions"><button className="pm-action" onClick={() => onNavigate('portfolio')}>Open owner portfolio <ArrowDownUp size={14}/></button><button className="pm-action" onClick={() => onNavigate('deploy')}>Open deployment preflight <Gauge size={14}/></button></div>
    <p className="pm-disclaimer"><Database size={13}/> Monitoring is active only while this dashboard is open. Historical uptime percentages and Render infrastructure events require a persistent server-side monitor and authenticated Render metrics access; this page does not fabricate either.</p>
  </section>
}
