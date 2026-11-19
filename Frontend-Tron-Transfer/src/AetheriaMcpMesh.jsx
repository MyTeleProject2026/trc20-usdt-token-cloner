import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, AlertTriangle, ArrowDownUp, ArrowUpRight, CheckCircle2, Clock3, Cpu,
  Database, ExternalLink, Globe2, Layers3, Network, Radio, RefreshCw, Server,
  ShieldCheck, Terminal, Wallet, Waves, Zap,
} from 'lucide-react'
import './aetheria-mcp-mesh.css'

const RESOURCE_API = (import.meta.env.VITE_RESOURCE_API_URL || 'https://tron-transfer-resource-api.onrender.com').replace(/\/$/, '')
const OWNER = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const POLL = Object.freeze({
  health: 5_000,
  runtime: 1_000,
  resources: 15_000,
  tenergy: 15_000,
  transactions: 10_000,
  renderEvents: 30_000,
  uptime: 60_000,
  renderMetrics: 60_000,
})
const API_FLOWS = [
  { id: 'health', hub: 'RESOURCE API', fn: 'platform.health.read', method: 'GET', path: '/health', interval: '5s' },
  { id: 'runtime', hub: 'RUNTIME CORE', fn: 'runtime.snapshot.read', method: 'GET', path: '/api/observatory/snapshot', interval: '1s' },
  { id: 'resources', hub: 'TRON MAINNET', fn: 'mainnet.resources.read', method: 'GET', path: '/v1/resources/{owner}', interval: '15s · cached' },
  { id: 'tenergy', hub: 'TENERGY', fn: 'tenergy.promotion.status', method: 'GET', path: '/api/tron/tenergy/promo?address={owner}', interval: '15s' },
  { id: 'transactions', hub: 'TRON MAINNET', fn: 'mainnet.confirmed.transactions', method: 'GET', path: '/api/observatory/transactions?address={owner}', interval: '10s' },
  { id: 'renderEvents', hub: 'RENDER CONTROL PLANE', fn: 'render.service.events.list', method: 'GET', path: '/api/observatory/render-events', interval: '30s' },
  { id: 'uptime', hub: 'GITHUB ARCHIVE', fn: 'uptime.history.read', method: 'GET', path: '/api/observatory/uptime-history', interval: '60s' },
  { id: 'renderMetrics', hub: 'RENDER CONTROL PLANE', fn: 'render.metrics.read', method: 'GET', path: '/api/observatory/render-metrics', interval: '60s · API cache 5m' },
]
const INITIAL_CALLS = Object.fromEntries(API_FLOWS.map(flow => [flow.id, {
  state: 'checking', statusCode: null, latencyMs: null, requestedAt: null, returnedAt: null,
  requestId: null, detail: 'Awaiting first invocation', callback: 'pending',
}]))

function stamp(value) {
  return value ? new Date(value).toLocaleTimeString() : '—'
}
function age(value, now) {
  if (!value) return '—'
  const ms = Math.max(0, now - Date.parse(value))
  return ms < 1000 ? 'just now' : ms < 60_000 ? Math.floor(ms / 1000) + 's ago' : Math.floor(ms / 60_000) + 'm ago'
}
function bytes(value = 0) {
  const n = Number(value) || 0
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}
function duration(value = 0) {
  const n = Math.max(0, Number(value) || 0)
  const d = Math.floor(n / 86400)
  const h = Math.floor(n % 86400 / 3600)
  const m = Math.floor(n % 3600 / 60)
  const s = Math.floor(n % 60)
  return [d && d + 'd', h && h + 'h', m && m + 'm', s + 's'].filter(Boolean).join(' ')
}
function short(value, start = 9, end = 6) {
  return value ? value.slice(0, start) + '…' + value.slice(-end) : 'Not connected'
}
function Status({ state = 'unknown', label }) {
  const text = label || ({ online: 'ONLINE', warning: 'DEGRADED', offline: 'OFFLINE', checking: 'CHECKING', unknown: 'NO SIGNAL' }[state] || 'NO SIGNAL')
  return <span className={'am-status ' + state}><i />{text}</span>
}
function Metric({ label, value, note, state }) {
  return <article className="am-metric">
    <span>{label}</span><b>{value ?? '—'}</b><small>{note}</small>
    {state && <Status state={state} />}
  </article>
}
function FlowLine({ state = 'checking' }) {
  return <span className={'am-flow-line ' + state}><i /><i /><i /></span>
}
function readJson(path, timeoutMs = 8_000) {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  const started = performance.now()
  return fetch(RESOURCE_API + path, {
    cache: 'no-store',
    signal: controller.signal,
    headers: { accept: 'application/json' },
  }).then(async response => {
    const body = await response.json().catch(() => ({}))
    const latencyMs = Math.round(performance.now() - started)
    if (!response.ok) throw Object.assign(new Error(body.message || body.error || 'HTTP ' + response.status), { statusCode: response.status, latencyMs })
    return { body, statusCode: response.status, latencyMs }
  }).finally(() => window.clearTimeout(timer))
}

export default function AetheriaMcpMesh({ wallet, onNavigate }) {
  const [calls, setCalls] = useState(INITIAL_CALLS)
  const [health, setHealth] = useState(null)
  const [runtime, setRuntime] = useState(null)
  const [resources, setResources] = useState(null)
  const [promo, setPromo] = useState(null)
  const [transactions, setTransactions] = useState([])
  const [renderEvents, setRenderEvents] = useState([])
  const [uptimeRuns, setUptimeRuns] = useState([])
  const [renderMetrics, setRenderMetrics] = useState([])
  const [events, setEvents] = useState([])
  const [clockNow, setClockNow] = useState(Date.now())
  const [refreshing, setRefreshing] = useState(false)
  const inFlight = useRef(new Set())
  const alive = useRef(true)

  const recordEvent = useCallback((flow, result, detail) => {
    const id = (globalThis.crypto?.randomUUID?.() || String(Date.now()) + Math.random())
    setEvents(previous => [{
      id, at: new Date().toISOString(), flow, result, detail,
    }, ...previous].slice(0, 32))
  }, [])

  const invoke = useCallback(async (id, path, consume) => {
    if (inFlight.current.has(id)) return
    inFlight.current.add(id)
    const requestedAt = new Date().toISOString()
    const requestId = (globalThis.crypto?.randomUUID?.() || String(Date.now()) + '-' + id)
    setCalls(previous => ({ ...previous, [id]: {
      ...previous[id], state: 'checking', requestedAt, requestId, callback: 'awaiting',
    } }))
    try {
      const result = await readJson(path)
      if (!alive.current) return
      const outcome = consume(result.body) || {}
      const returnedAt = new Date().toISOString()
      setCalls(previous => ({ ...previous, [id]: {
        state: outcome.state || 'online', statusCode: result.statusCode, latencyMs: result.latencyMs,
        requestedAt, returnedAt, requestId, callback: 'received',
        detail: outcome.detail || ('HTTP ' + result.statusCode + ' · callback received'),
      } }))
      recordEvent(id, 'success', 'Return callback received in ' + result.latencyMs + ' ms')
    } catch (error) {
      if (!alive.current) return
      const returnedAt = new Date().toISOString()
      setCalls(previous => ({ ...previous, [id]: {
        state: error.statusCode >= 500 ? 'offline' : 'warning',
        statusCode: error.statusCode || 0, latencyMs: error.latencyMs ?? null,
        requestedAt, returnedAt, requestId, callback: 'error',
        detail: error.message || 'No response callback',
      } }))
      recordEvent(id, 'error', error.message || 'Request failed')
    } finally {
      inFlight.current.delete(id)
    }
  }, [recordEvent])

  const refreshHealth = useCallback(() => invoke('health', '/health', body => { setHealth(body); return body.ok && body.network === 'TRON Mainnet' ? null : { state: 'warning', detail: 'Health payload did not confirm TRON Mainnet' } }), [invoke])
  const refreshRuntime = useCallback(() => invoke('runtime', '/api/observatory/snapshot', body => {
    if (!body?.ok) throw new Error('Runtime snapshot payload is not healthy')
    setRuntime(body)
  }), [invoke])
  const refreshResources = useCallback(() => invoke('resources', '/v1/resources/' + OWNER, body => {
    const valid = body.network === 'TRON Mainnet' && body.address === OWNER && body.energy && body.bandwidth
    if (!valid) throw new Error('Mainnet resource response did not match the expected owner/network schema')
    setResources(body)
  }), [invoke])
  const refreshPromo = useCallback(() => invoke('tenergy', '/api/tron/tenergy/promo?address=' + encodeURIComponent(OWNER), body => {
    if (!body.success) throw new Error(body.error || 'TEnergy promotion response was unsuccessful')
    setPromo(body)
    return body.promo?.state === 'active' ? null : { state: 'warning', detail: 'TEnergy promotion is not active; provider response received' }
  }), [invoke])
  const refreshTransactions = useCallback(() => invoke('transactions', '/api/observatory/transactions?address=' + encodeURIComponent(OWNER), body => {
    if (!body.success) throw new Error(body.message || 'Confirmed transaction response was unsuccessful')
    setTransactions(Array.isArray(body.transactions) ? body.transactions : [])
  }), [invoke])
  const refreshRenderEvents = useCallback(() => invoke('renderEvents', '/api/observatory/render-events', body => {
    if (!body.success) throw new Error(body.message || 'Render events response was unsuccessful')
    setRenderEvents(Array.isArray(body.events) ? body.events : [])
    return body.configured ? null : { state: 'warning', detail: body.note || 'Render API credential is not configured' }
  }), [invoke])
  const refreshUptime = useCallback(() => invoke('uptime', '/api/observatory/uptime-history', body => {
    if (!body.success) throw new Error(body.message || 'Uptime history response was unsuccessful')
    setUptimeRuns(Array.isArray(body.runs) ? body.runs : [])
    return Array.isArray(body.runs) && body.runs.length ? null : { state: 'warning', detail: 'Archive is reachable but currently contains no records' }
  }), [invoke])
  const refreshRenderMetrics = useCallback(() => invoke('renderMetrics', '/api/observatory/render-metrics', body => {
    if (!body.success) throw new Error(body.message || 'Render metrics response was unsuccessful')
    setRenderMetrics(Array.isArray(body.metrics) ? body.metrics : [])
    const hasSamples = body.metrics?.some(item => ['cpu', 'memory'].includes(item.id) && item.points?.length)
    return body.configured && hasSamples ? null : { state: 'warning', detail: body.note || 'Authenticated Render metrics samples are not available' }
  }), [invoke])

  const refreshAll = useCallback(async () => {
    setRefreshing(true)
    try {
      await Promise.all([refreshHealth(), refreshRuntime(), refreshResources(), refreshPromo(), refreshTransactions(), refreshRenderEvents(), refreshUptime(), refreshRenderMetrics()])
    } finally { setRefreshing(false) }
  }, [refreshHealth, refreshRuntime, refreshResources, refreshPromo, refreshTransactions, refreshRenderEvents, refreshUptime, refreshRenderMetrics])

  useEffect(() => {
    alive.current = true
    let timers = []
    const stopPolling = () => {
      timers.forEach(timer => window.clearInterval(timer))
      timers = []
    }
    const startPolling = () => {
      if (document.visibilityState === 'hidden') return
      refreshHealth()
      refreshRuntime()
      refreshResources()
      refreshPromo()
      refreshTransactions()
      refreshRenderEvents()
      refreshUptime()
      refreshRenderMetrics()
      timers = [
        window.setInterval(refreshHealth, POLL.health),
        window.setInterval(refreshRuntime, POLL.runtime),
        window.setInterval(refreshResources, POLL.resources),
        window.setInterval(refreshPromo, POLL.tenergy),
        window.setInterval(refreshTransactions, POLL.transactions),
        window.setInterval(refreshRenderEvents, POLL.renderEvents),
        window.setInterval(refreshUptime, POLL.uptime),
        window.setInterval(refreshRenderMetrics, POLL.renderMetrics),
        window.setInterval(() => setClockNow(Date.now()), 1000),
      ]
    }
    const onVisibility = () => {
      stopPolling()
      if (document.visibilityState === 'visible') startPolling()
    }
    startPolling()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      alive.current = false
      stopPolling()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refreshHealth, refreshRuntime, refreshResources, refreshPromo, refreshTransactions, refreshRenderEvents, refreshUptime, refreshRenderMetrics])

  const heartbeat = runtime?.heartbeat
  const process = runtime?.process
  const requestMetrics = runtime?.requests
  const heartbeatAge = heartbeat?.lastAt ? Math.max(0, clockNow - Date.parse(heartbeat.lastAt)) : null
  const runtimeState = calls.runtime.state === 'offline' && !runtime ? 'offline'
    : heartbeatAge != null && heartbeatAge <= 3500 && calls.runtime.state === 'online' ? 'online'
      : runtime ? 'warning' : 'checking'
  const resourceState = calls.resources.state
  const promoState = calls.tenergy.state === 'online' && promo?.promo?.state === 'active' ? 'online' : calls.tenergy.state === 'online' ? 'warning' : calls.tenergy.state
  const ownerConnected = wallet?.address === OWNER
  const energy = resources?.energy?.available
  const bandwidth = resources?.bandwidth?.maxSingleTransactionAvailable
  const providers = health?.rpcProviderPriority || []
  const providerUsed = resources?.rpc?.providersUsed || {}
    const flowCount = API_FLOWS.length
  const allFlowCount = API_FLOWS.filter(item => calls[item.id].state === 'online').length
  const latestTick = calls.runtime.returnedAt
  const metricsById = useMemo(() => Object.fromEntries(renderMetrics.map(metric => [metric.id, metric])), [renderMetrics])
  const cpu = metricsById.cpu
  const memory = metricsById.memory
  const nodes = [
    { id: 'owner', label: 'OWNER CONSOLE', sub: ownerConnected ? 'Configured owner wallet connected' : 'Dashboard session · wallet not connected', state: ownerConnected ? 'online' : 'warning', x: 500, y: 220, icon: Wallet },
    { id: 'gateway', label: 'MCP GATEWAY', sub: 'Resource API · 1:1 routes', state: calls.health.state === 'online' && runtimeState === 'online' ? 'online' : calls.health.state, x: 500, y: 78, icon: Network },
    { id: 'mainnet', label: 'TRON MAINNET', sub: 'Owner resources · confirmed chain', state: calls.resources.state, x: 210, y: 220, icon: Globe2 },
    { id: 'tatum', label: 'TATUM RPC', sub: 'Primary provider route', state: providers.includes('tatum') ? 'online' : calls.resources.state === 'online' ? 'warning' : 'checking', x: 115, y: 85, icon: Server },
    { id: 'trongrid', label: 'TRONGRID RPC', sub: 'Fallback provider route', state: providers.includes('trongrid') ? 'online' : calls.resources.state === 'online' ? 'warning' : 'checking', x: 115, y: 355, icon: Server },
    { id: 'tenergy', label: 'TENERGY HUB', sub: 'Promotion & redemption', state: promoState, x: 790, y: 85, icon: Zap },
    { id: 'render', label: 'RENDER CONTROL', sub: 'Service events · metrics', state: calls.renderEvents.state === 'online' && calls.renderMetrics.state === 'online' ? 'online' : calls.renderEvents.state, x: 790, y: 355, icon: Layers3 },
    { id: 'archive', label: 'GITHUB ARCHIVE', sub: 'Persistent uptime callbacks', state: calls.uptime.state, x: 500, y: 390, icon: Database },
  ]
  const links = [
    ['owner', 'gateway'], ['gateway', 'mainnet'], ['mainnet', 'tatum'], ['mainnet', 'trongrid'],
    ['gateway', 'tenergy'], ['gateway', 'render'], ['gateway', 'archive'], ['owner', 'mainnet'],
  ]
  const callAge = id => age(calls[id].returnedAt, clockNow)
  const liveFlows = API_FLOWS.map(flow => ({ ...flow, call: calls[flow.id] }))
  const txTime = tx => {
    const value = tx.block_timestamp || tx.raw_data?.timestamp
    return value ? new Date(Number(value)).toLocaleTimeString() : '—'
  }

  return <section className="aetheria-mesh" aria-label="AETHERIA global MCP mesh runtime monitoring">
    <header className="am-hero">
      <div className="am-brandline"><span className="am-brand-mark"><Network size={19}/></span><div><span>AETHERIA // GLOBAL MCP MESH</span><small>TRON TRANSFER · OWNER ADMIN RUNTIME FABRIC</small></div></div>
      <div className="am-hero-copy"><div><span className="am-eyebrow"><Radio size={13}/> MULTI-HUB OBSERVABILITY · TRON MAINNET</span><h2>One mesh. Every live execution path.</h2><p>One-to-one API routes, function invocations and return callbacks mapped onto the live infrastructure graph. The one-second clock refreshes telemetry age and runtime heartbeat; upstream services retain their safe polling intervals.</p></div>
        <div className="am-hero-actions"><span className={'am-live-badge ' + (runtimeState === 'online' ? 'online' : 'stale')}><i/>{runtimeState === 'online' ? 'MESH LIVE · 1S TICK' : 'MESH SIGNAL · ' + runtimeState.toUpperCase()}</span><button type="button" onClick={refreshAll} disabled={refreshing}><RefreshCw size={14} className={refreshing ? 'am-spin' : ''}/>{refreshing ? 'Dispatching' : 'Invoke all flows'}</button></div>
      </div>
      <div className="am-telemetry-bar"><span><Clock3 size={13}/> LOCAL TICK <b>{stamp(clockNow)}</b></span><span><Activity size={13}/> RUNTIME HEARTBEAT <b>{heartbeatAge == null ? '—' : heartbeatAge + ' ms'}</b></span><span><Radio size={13}/> LAST CALLBACK <b>{latestTick ? age(latestTick, clockNow) : 'Awaiting'}</b></span><span><Waves size={13}/> API ROUTES <b>{allFlowCount}/{flowCount} online</b></span></div>
    </header>

    <div className="am-section-head"><div><span className="am-eyebrow">01 / SPATIAL TOPOLOGY</span><h3>Global hub constellation</h3><p>Every link represents an implemented service path; animated packets indicate the visual route, not fabricated transaction throughput.</p></div><div className="am-legend"><span><i className="ok"/> live</span><span><i className="warn"/> degraded</span><span><i className="bad"/> offline</span><span><i className="pulse"/> callback pulse</span></div></div>
    <div className="am-mesh-stage">
      <div className="am-grid-floor"/>
      <svg className="am-connection-svg" viewBox="0 0 1000 460" role="img" aria-label="AETHERIA hub connections">
        <defs><linearGradient id="am-link-gradient"><stop offset="0%" stopColor="#41d8d0" stopOpacity=".12"/><stop offset="50%" stopColor="#71baff" stopOpacity=".78"/><stop offset="100%" stopColor="#a58bff" stopOpacity=".16"/></linearGradient><filter id="am-glow"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
        {links.map(([from,to]) => { const a=nodes.find(n=>n.id===from); const b=nodes.find(n=>n.id===to); return <g key={from+'-'+to}><line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="am-link-base"/><line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={'am-link-active ' + (a.state === 'online' && b.state === 'online' ? 'online' : 'degraded')}/><circle r="4" className="am-packet" filter="url(#am-glow)"><animateMotion dur="3.2s" repeatCount="indefinite" path={'M'+a.x+','+a.y+' L'+b.x+','+b.y}/></circle></g> })}
      </svg>
      <div className="am-hub-field">
        {nodes.map(node => { const Icon=node.icon; return <article key={node.id} className={'am-hub '+node.state} style={{left:(node.x/10)+'%',top:(node.y/4.6)+'%'}}>
          <span className="am-hub-orbit"><i/><Icon size={17}/></span><b>{node.label}</b><small>{node.sub}</small><Status state={node.state}/>
        </article> })}
      </div>
      <div className="am-stage-foot"><span>FABRIC STATUS <b>{flowOnline}/{flowCount} RESPONSE CHANNELS ONLINE</b></span><span>OWNER <b>{short(OWNER)}</b></span><span>CHAIN <b>TRON MAINNET</b></span></div>
    </div>

    <div className="am-kpi-grid">
      <Metric label="API routes responding" value={allFlowCount + ' / ' + flowCount} note="One-to-one endpoint callbacks" state={allFlowCount === flowCount ? 'online' : 'warning'}/>
      <Metric label="Process uptime" value={runtime ? duration(runtime.uptimeSeconds) : '—'} note="Resource API process lifetime"/>
      <Metric label="Process memory" value={process ? bytes(process.rssBytes) : '—'} note={'Heap ' + (process ? bytes(process.heapUsedBytes) : '—')}/>
      <Metric label="HTTP · rolling 60s" value={requestMetrics?.count ?? '—'} note={requestMetrics ? requestMetrics.errors5xx + ' errors · p95 ' + requestMetrics.p95LatencyMs + ' ms' : 'Awaiting process sample'}/>
      <Metric label="Mainnet Energy" value={energy == null ? '—' : Number(energy).toLocaleString()} note="Current owner account resource snapshot" state={resourceState}/>
      <Metric label="TRX balance" value={resources?.balanceSun == null ? '—' : (Number(resources.balanceSun)/1_000_000).toFixed(6)} note="Native TRX · Mainnet account"/>
    </div>

    <div className="am-section-head"><div><span className="am-eyebrow">02 / MCP EXECUTION ROUTER</span><h3>One-to-one API & function pathways</h3><p>Each function is bound to one endpoint. Request dispatch and return callback state are tracked independently.</p></div><Status state={allFlowCount === flowCount ? 'online' : 'warning'} label={allFlowCount + ' / ' + flowCount + ' RETURNED'}/></div>
    <div className="am-flow-grid">
      {liveFlows.map(flow => <article className="am-flow-card" key={flow.id}>
        <div className="am-flow-top"><span className="am-flow-method">{flow.method}</span><Status state={flow.call.state}/></div>
        <span className="am-flow-hub">{flow.hub}</span><h4>{flow.fn}</h4><code>{flow.path}</code>
        <FlowLine state={flow.call.state}/>
        <div className="am-flow-meta"><span>REQUEST <b>{stamp(flow.call.requestedAt)}</b></span><span>CALLBACK <b>{flow.call.callback.toUpperCase()}</b></span><span>RETURN <b>{flow.call.latencyMs == null ? '—' : flow.call.latencyMs + ' ms'}</b></span><span>AGE <b>{callAge(flow.id)}</b></span></div>
        <p className="am-flow-detail">{flow.call.detail}</p>
      </article>)}
    </div>

    <div className="am-dual-grid">
      <section className="am-panel"><div className="am-panel-head"><div><span className="am-eyebrow">03 / LIVE INFRASTRUCTURE</span><h3>Runtime & service health</h3></div><Status state={runtimeState}/></div>
        <div className="am-infra-grid">
          <Metric label="Heartbeat ticks" value={runtime?.heartbeat?.count?.toLocaleString() || '—'} note={heartbeat ? heartbeat.intervalMs + ' ms · ' + heartbeat.missedIntervals + ' missed' : 'No server heartbeat'}/>
          <Metric label="Heartbeat delivery" value={heartbeat?.successPercent == null ? '—' : heartbeat.successPercent + '%'} note="Process-local ratio, not an SLA"/>
          <Metric label="Event-loop p95" value={process ? Number(process.eventLoopP95Ms).toFixed(2)+' ms' : '—'} note="Node event-loop delay"/>
          <Metric label="Browser → API RTT" value={calls.runtime.latencyMs == null ? '—' : calls.runtime.latencyMs+' ms'} note={'Last return ' + callAge('runtime')}/>
        </div>
        <div className="am-runtime-foot"><span><Cpu size={14}/> RSS {process ? bytes(process.rssBytes) : '—'} · Heap {process ? bytes(process.heapUsedBytes) : '—'} / {process ? bytes(process.heapTotalBytes) : '—'}</span><span><Server size={14}/> PID {process?.pid ?? '—'} · {process?.nodeVersion ?? 'Node runtime pending'}</span></div>
        <p className="am-note">{runtime?.retention || 'Process samples are volatile and reset when the API restarts.'}</p>
      </section>
      <section className="am-panel"><div className="am-panel-head"><div><span className="am-eyebrow">04 / API CONNECTIONS</span><h3>Provider routing & callbacks</h3></div><Status state={calls.health.state}/></div>
        <div className="am-provider"><span>Tatum Mainnet · primary</span><Status state={providers.includes('tatum') ? 'online' : 'warning'} label={providers.includes('tatum') ? 'IN PRIORITY' : 'NOT REPORTED'}/></div>
        <div className="am-provider"><span>TronGrid · fallback</span><Status state={providers.includes('trongrid') ? 'online' : 'warning'} label={providers.includes('trongrid') ? 'IN PRIORITY' : 'NOT REPORTED'}/></div>
        <div className="am-provider"><span>TEnergy promotion</span><Status state={promoState}/></div>
        <div className="am-provider"><span>Render control plane</span><Status state={calls.renderEvents.state}/></div>
        <div className="am-provider"><span>GitHub archive</span><Status state={calls.uptime.state}/></div>
        <p className="am-note">Provider priority is reported by the API. Actual provider usage comes from the latest resource response; a configured provider is not proof that a request used it.</p>
        <div className="am-provider-used">{Object.entries(providerUsed).map(([key,value])=><span key={key}><b>{key}</b>{value}</span>)}</div>
      </section>
    </div>

    <div className="am-section-head"><div><span className="am-eyebrow">05 / TRON MAINNET RESOURCE HUB</span><h3>Owner account resource telemetry</h3><p>Read-only Mainnet values for the configured owner address. Values update from the live resource endpoint; one-second tick updates their age and connection state.</p></div><span className="am-owner-chip">{short(OWNER)}</span></div>
    <div className="am-resource-grid">
      <Metric label="Energy available" value={energy == null ? '—' : Number(energy).toLocaleString()} note={'Limit ' + (resources?.energy?.limit ?? '—') + ' · Used ' + (resources?.energy?.used ?? '—')} state={resourceState}/>
      <Metric label="Free Bandwidth" value={resources?.bandwidth?.freeAvailable == null ? '—' : Number(resources.bandwidth.freeAvailable).toLocaleString()} note={'Limit ' + (resources?.bandwidth?.freeLimit ?? '—') + ' · Used ' + (resources?.bandwidth?.freeUsed ?? '—')}/>
      <Metric label="Staked / delegated Bandwidth" value={resources?.bandwidth?.stakedOrDelegatedAvailable == null ? '—' : Number(resources.bandwidth.stakedOrDelegatedAvailable).toLocaleString()} note={'Limit ' + (resources?.bandwidth?.stakedOrDelegatedLimit ?? '—') + ' · Used ' + (resources?.bandwidth?.stakedOrDelegatedUsed ?? '—')}/>
      <Metric label="Max single-transaction Bandwidth" value={bandwidth == null ? '—' : Number(bandwidth).toLocaleString()} note="Reported maximum bytes from the resource API"/>
      <Metric label="Native TRX" value={resources?.balanceSun == null ? '—' : (Number(resources.balanceSun)/1_000_000).toFixed(6)} note="TRX · exact Mainnet account balance"/>
      <Metric label="TEnergy promotion" value={promo?.promo?.state || '—'} note={promo?.redemption?.status ? 'Redemption: ' + promo.redemption.status : 'Promotion endpoint response'} state={promoState}/>
    </div>
    <div className="am-safety-note"><ShieldCheck size={15}/><span>Observability is read-only. It does not sign, broadcast, claim, deploy or transfer. Resource availability is not a deployment approval: exact simulation, fee balance and TronLink owner approval remain mandatory.</span></div>

    <div className="am-dual-grid">
      <section className="am-panel"><div className="am-panel-head"><div><span className="am-eyebrow">06 / RENDER TELEMETRY</span><h3>Infrastructure metrics</h3></div><Status state={calls.renderMetrics.state}/></div>
        <p className="am-note">{calls.renderMetrics.detail}</p>
        <div className="am-render-metrics">{['cpu','memory','http_requests','http_latency','bandwidth'].map(id=>{const metric=metricsById[id];const point=metric?.points?.reduce((a,b)=>!a||Date.parse(b.timestamp)>Date.parse(a.timestamp)?b:a,null);const value=metric?.state==='unavailable'?'Unavailable':point?(Number(point.value).toLocaleString(undefined,{maximumFractionDigits:2})+(point.unit?' '+point.unit:'')):'No data';return <div key={id}><span>{metric?.label||id.replaceAll('_',' ')}</span><b>{value}</b><small>{metric?.note|| (metric?.points?.length?metric.points.length+' platform samples':'Awaiting platform samples')}</small></div>})}</div>
      </section>
      <section className="am-panel"><div className="am-panel-head"><div><span className="am-eyebrow">07 / EXTERNAL UPTIME</span><h3>Persistent probe archive</h3></div><Status state={calls.uptime.state}/></div>
        <p className="am-note">{uptimeRuns.length+' archived runs returned'} · <a href="https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/tree/monitoring-history/history" target="_blank" rel="noreferrer">Open archive <ExternalLink size={11}/></a></p>
        <div className="am-archive-list">{uptimeRuns.slice(0,5).map(run=><div key={run.id}><span>RUN #{run.runNumber}</span><b className={run.conclusion==='success'?'good':'bad'}>{run.conclusion||run.status}</b><time>{stamp(run.checkedAt||run.updatedAt||run.createdAt)}</time></div>)}</div>
      </section>
    </div>

    <div className="am-dual-grid">
      <section className="am-panel"><div className="am-panel-head"><div><span className="am-eyebrow">08 / CONFIRMED CHAIN ACTIVITY</span><h3>Owner wallet transactions</h3></div><Status state={calls.transactions.state}/></div>
        <div className="am-tx-list">{transactions.length?transactions.slice(0,8).map((tx,index)=>{const hash=tx.txID||tx.txid||tx.transaction_id;const type=tx.raw_data?.contract?.[0]?.type||tx.contractType||'TRON transaction';const result=tx.ret?.[0]?.contractRet||tx.ret?.[0]?.contract_ret||'CONFIRMED';return <div key={hash||index}><span className="am-tx-icon"><ArrowUpRight size={13}/></span><div><b>{type.replace(/Contract$/,'')}</b><small>{short(hash,10,8)} · Block {tx.blockNumber||tx.block_number||'—'}</small></div><Status state={result==='SUCCESS'?'online':'warning'} label={result}/><time>{txTime(tx)}</time>{hash&&<a href={'https://tronscan.org/#/transaction/'+encodeURIComponent(hash)} target="_blank" rel="noreferrer">TRONSCAN <ExternalLink size={10}/></a>}</div>}) : <p className="am-note">No confirmed owner-wallet transactions returned. This is not treated as proof of zero historical activity.</p>}</div>
      </section>
      <section className="am-panel"><div className="am-panel-head"><div><span className="am-eyebrow">09 / FUNCTION RETURN BUS</span><h3>Execution & callback trace</h3></div><span className="am-count">{events.length} events</span></div>
        <div className="am-event-list" aria-live="polite">{events.length?events.slice(0,10).map(event=><div key={event.id}><i className={event.result}/><time>{stamp(event.at)}</time><b>{event.flow}</b><span>{event.detail}</span></div>):<p className="am-note">Waiting for the first function return callback.</p>}</div>
      </section>
    </div>

    <footer className="am-footer"><span><Activity size={13}/> MESH CLOCK · 1 SECOND</span><span>RESOURCE API 15s CACHE · RENDER METRICS 60s POLL / 5m SERVER CACHE</span><span>READ ONLY · NO TRANSACTION SIGNING</span></footer>
  </section>
}
