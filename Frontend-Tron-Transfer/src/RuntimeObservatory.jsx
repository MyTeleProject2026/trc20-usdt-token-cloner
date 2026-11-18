import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, ArrowUpRight, Clock3, Cpu, Database, Globe2, Layers3, Radio, RefreshCw, Server, Waves, Zap } from 'lucide-react'
import './runtime-observatory.css'

const OWNER = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'

function formatUptime(seconds = 0) {
  const value = Math.max(0, Number(seconds) || 0)
  const days = Math.floor(value / 86400)
  const hours = Math.floor((value % 86400) / 3600)
  const minutes = Math.floor((value % 3600) / 60)
  const secs = Math.floor(value % 60)
  return [days ? days + 'd' : null, hours ? hours + 'h' : null, minutes ? minutes + 'm' : null, secs + 's'].filter(Boolean).join(' ')
}
function formatBytes(value = 0) {
  const bytes = Number(value) || 0
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}
function shortHash(value) {
  return value ? value.slice(0, 10) + '…' + value.slice(-8) : 'Transaction hash unavailable'
}
function time(value) {
  return value ? new Date(value).toLocaleTimeString() : '—'
}
function Status({ value = 'unknown' }) {
  const label = value === 'online' ? 'LIVE' : value === 'offline' ? 'OFFLINE' : value === 'warning' ? 'DEGRADED' : value === 'checking' ? 'CHECKING' : 'NOT CONNECTED'
  return <span className={'ro-status ' + value}><i/>{label}</span>
}
function Sparkline({ samples = [] }) {
  const values = samples.map(item => Number(item.eventLoopP95Ms) || 0)
  const max = Math.max(5, ...values)
  const points = values.map((value, index) => `${values.length < 2 ? 0 : index / (values.length - 1) * 100},${30 - value / max * 26}`).join(' ')
  return <svg className="ro-sparkline" viewBox="0 0 100 32" preserveAspectRatio="none" role="img" aria-label="Event loop latency trend"><polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.8" vectorEffect="non-scaling-stroke"/></svg>
}

export default function RuntimeObservatory({ apiBase, resourceState, promoState }) {
  const [runtime, setRuntime] = useState(null)
  const [runtimeError, setRuntimeError] = useState('')
  const [transactions, setTransactions] = useState([])
  const [transactionState, setTransactionState] = useState('checking')
  const [transactionError, setTransactionError] = useState('')
  const [lastTransactionCheck, setLastTransactionCheck] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const [renderEvents, setRenderEvents] = useState([])
  const [renderState, setRenderState] = useState('checking')
  const [renderNote, setRenderNote] = useState('')
  const [clockNow, setClockNow] = useState(Date.now())
  const [lastRuntimeAt, setLastRuntimeAt] = useState(null)
  const [runtimeLatency, setRuntimeLatency] = useState(null)
  const runtimeInFlight = useRef(false)

  const refreshRuntime = useCallback(async (manual = false) => {
    if (runtimeInFlight.current) return
    runtimeInFlight.current = true
    if (manual) setRefreshing(true)
    const started = performance.now()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 7000)
    try {
      const response = await fetch(apiBase + '/api/observatory/snapshot', { cache: 'no-store', signal: controller.signal, headers: { accept: 'application/json' } })
      const body = await response.json()
      if (!response.ok || !body.ok) throw new Error(body.message || 'Runtime snapshot unavailable')
      setRuntime(body)
      setRuntimeError('')
      setLastRuntimeAt(Date.now())
      setRuntimeLatency(Math.round(performance.now() - started))
    } catch (error) {
      setRuntimeError(error?.message || 'Runtime heartbeat unavailable')
    } finally {
      window.clearTimeout(timeout)
      runtimeInFlight.current = false
      if (manual) setRefreshing(false)
    }
  }, [apiBase])

  const refreshTransactions = useCallback(async () => {
    try {
      const response = await fetch(apiBase + '/api/observatory/transactions?address=' + encodeURIComponent(OWNER), { cache: 'no-store', headers: { accept: 'application/json' } })
      const body = await response.json()
      if (!response.ok || !body.success) throw new Error(body.message || body.error || 'Mainnet transaction feed unavailable')
      setTransactions(Array.isArray(body.transactions) ? body.transactions : [])
      setTransactionState('online')
      setTransactionError('')
      setLastTransactionCheck(body.checkedAt)
    } catch (error) {
      setTransactionState('warning')
      setTransactionError(error?.message || 'Confirmed transaction feed unavailable')
    }
  }, [apiBase])

  const refreshRenderEvents = useCallback(async () => {
    try {
      const response = await fetch(apiBase + '/api/observatory/render-events', { cache: 'no-store', headers: { accept: 'application/json' } })
      const body = await response.json()
      if (!response.ok || !body.success) throw new Error(body.message || body.error || 'Render event feed unavailable')
      setRenderEvents(Array.isArray(body.events) ? body.events : [])
      setRenderState(body.configured ? 'online' : 'warning')
      setRenderNote(body.note || (body.configured ? 'Authenticated Render control-plane events' : 'Render API key is not configured on the backend.'))
    } catch (error) {
      setRenderState('warning')
      setRenderNote(error?.message || 'Render control-plane events unavailable')
    }
  }, [apiBase])

  useEffect(() => {
    const clock = window.setInterval(() => setClockNow(Date.now()), 250)
    refreshRuntime()
    refreshTransactions()
    refreshRenderEvents()
    const heartbeat = window.setInterval(refreshRuntime, 1000)
    const chainFeed = window.setInterval(refreshTransactions, 10_000)
    const renderFeed = window.setInterval(refreshRenderEvents, 30_000)
    return () => {
      window.clearInterval(heartbeat)
      window.clearInterval(chainFeed)
      window.clearInterval(renderFeed)
      window.clearInterval(clock)
    }
  }, [refreshRuntime, refreshTransactions, refreshRenderEvents])

  const heartbeat = runtime?.heartbeat
  const process = runtime?.process
  const requests = runtime?.requests
  const heartbeatAgeMs = heartbeat?.lastAt ? Math.max(0, clockNow - Date.parse(heartbeat.lastAt)) : null
  const runtimeFresh = heartbeatAgeMs != null && heartbeatAgeMs <= 3500 && !runtimeError
  const runtimeState = runtimeError && !runtime ? 'offline' : runtimeFresh ? 'online' : runtime ? 'warning' : 'checking'
  const renderNodeState = renderState === 'online' ? 'online' : renderState === 'warning' ? 'warning' : 'checking'
  const nodes = [
    { id: 'browser', label: 'Owner console', state: 'online', detail: 'This dashboard session', icon: Activity },
    { id: 'api', label: 'Resource API', state: runtimeState, detail: runtimeFresh ? 'Heartbeat age ' + heartbeatAgeMs + ' ms' : runtimeError || 'Heartbeat stale or awaiting sample', icon: Server },
    { id: 'tron', label: 'TRON Mainnet', state: resourceState || 'checking', detail: 'Live resource + confirmed history reads', icon: Globe2 },
    { id: 'tenergy', label: 'TEnergy', state: promoState || 'checking', detail: 'Promotion endpoint response', icon: Zap },
    { id: 'render', label: 'Render control plane', state: renderNodeState, detail: renderState === 'online' ? 'Authenticated service events' : renderNote || 'API key / event feed status', icon: Layers3 },
  ]
  const events = runtime?.events || []

  return <section className="runtime-observatory" aria-label="Live runtime observatory">
    <div className="ro-header">
      <div><span className="ro-eyebrow"><Activity size={13}/> LIVE RUNTIME OBSERVATORY</span><h3>Runtime signal & network activity</h3><p>One-second backend process heartbeat, real API request traces and confirmed TRON Mainnet transactions.</p></div>
      <div className="ro-header-actions"><span className={"ro-live-indicator " + (runtimeState === "online" ? "is-live" : "is-stale")}><i/> {runtimeState === "online" ? "LIVE · 1 SEC" : runtimeState === "offline" ? "SIGNAL LOST" : "SIGNAL STALE"}</span><button type="button" onClick={() => { refreshRuntime(true); refreshTransactions(); refreshRenderEvents() }} disabled={refreshing}><RefreshCw size={14} className={refreshing ? 'ro-spin' : ''}/>Refresh feeds</button></div>
    </div>

    <div className="ro-live-strip"><span><Clock3 size={13}/> LOCAL CLOCK <b>{new Date(clockNow).toLocaleTimeString()}</b></span><span><Radio size={13}/> LAST SNAPSHOT <b>{lastRuntimeAt ? formatUptime(Math.floor((clockNow - lastRuntimeAt) / 1000)) + " ago" : "Waiting"}</b></span><span><Activity size={13}/> SNAPSHOT RTT <b>{runtimeLatency == null ? "—" : runtimeLatency + " ms"}</b></span><span><Server size={13}/> HEARTBEAT AGE <b>{heartbeatAgeMs == null ? "—" : heartbeatAgeMs + " ms"}</b></span></div>

    <div className="ro-metrics-grid">
      <article className="ro-metric"><span>API process uptime</span><b>{runtime ? formatUptime(runtime.uptimeSeconds) : '—'}</b><small>Since current process start</small></article>
      <article className="ro-metric"><span>Heartbeat ticks</span><b>{heartbeat?.count?.toLocaleString() || '—'}</b><small>{heartbeat ? heartbeat.intervalMs + ' ms interval · ' + heartbeat.missedIntervals + ' missed' : 'Awaiting server heartbeat'}</small></article>
      <article className="ro-metric"><span>Memory resident</span><b>{process ? formatBytes(process.rssBytes) : '—'}</b><small>Heap {process ? formatBytes(process.heapUsedBytes) : '—'}</small></article>
      <article className="ro-metric"><span>HTTP requests · 60 sec</span><b>{requests?.count ?? '—'}</b><small>{requests ? requests.errors5xx + ' server errors · p95 ' + requests.p95LatencyMs + ' ms' : 'Waiting for request samples'}</small></article>
      <article className="ro-metric"><span>Event-loop p95</span><b>{process ? process.eventLoopP95Ms.toFixed(2) + ' ms' : '—'}</b><small>Node.js event-loop delay sample</small></article>
      <article className="ro-metric"><span>Heartbeat delivery</span><b>{heartbeat?.successPercent == null ? '—' : heartbeat.successPercent + '%'}</b><small>Process-local tick ratio · not external uptime SLA</small></article>
    </div>

    <div className="ro-main-grid">
      <article className="ro-panel ro-topology-panel">
        <div className="ro-panel-title"><div><span className="ro-eyebrow">CONNECTION TOPOLOGY</span><h4>Live service pathways</h4></div><Waves size={18}/></div>
        <div className="ro-topology">
          {nodes.map((node, index) => { const Icon = node.icon; return <div className={'ro-node ' + node.state} key={node.id}>
            <span className="ro-node-orbit"><i/><Icon size={15}/></span><b>{node.label}</b><small>{node.detail}</small><Status value={node.state}/>
            {index < nodes.length - 1 && <span className="ro-link-line"><i/></span>}
          </div> })}
        </div>
        <div className="ro-render-note"><Server size={14}/><span>{renderNote || "Render service lifecycle integration status is shown in the event feed below."}</span></div>
      </article>
      <article className="ro-panel ro-runtime-panel">
        <div className="ro-panel-title"><div><span className="ro-eyebrow">PROCESS TELEMETRY</span><h4>Runtime performance</h4></div><Cpu size={18}/></div>
        <div className="ro-chart-wrap"><div><span>Event-loop p95 delay</span><b>{process ? process.eventLoopP95Ms.toFixed(2) + ' ms' : '—'}</b></div><Sparkline samples={runtime?.samples}/></div>
        <div className="ro-runtime-row"><span><Database size={14}/> Heap allocated</span><b>{process ? formatBytes(process.heapTotalBytes) : '—'}</b></div>
        <div className="ro-runtime-row"><span><Zap size={14}/> HTTP error rate</span><b>{requests ? requests.errorRatePercent + '%' : '—'}</b></div>
        <div className="ro-runtime-row"><span><Radio size={14}/> Last heartbeat</span><b>{time(heartbeat?.lastAt)}</b></div>
        <p className="ro-retention-note">{runtime?.retention || 'Runtime samples are collected by the API process.'}</p>
      </article>
    </div>

    <div className="ro-section-heading"><div><span className="ro-eyebrow">RENDER CONTROL PLANE</span><h4>Deploy & service events</h4><p>Actual Render service lifecycle events, read through the backend using a server-side API key.</p></div><Status value={renderState}/></div>
    <p className="ro-render-state-note">{renderNote}</p>
    <div className="ro-render-events">
      {renderEvents.length ? renderEvents.map(event => <div className="ro-render-event" key={event.id}><span>{event.serviceLabel}</span><b>{event.type.replaceAll('_', ' ')}</b><time>{time(event.timestamp)}</time></div>) : <div className="ro-empty">{renderState === 'warning' ? 'Render event integration is not configured or is temporarily unavailable.' : 'No recent Render service events were returned.'}</div>}
    </div>

    <div className="ro-section-heading"><div><span className="ro-eyebrow">CHAIN ACTIVITY · READ ONLY</span><h4>Confirmed owner-wallet transactions</h4><p>Fetched from TRON Mainnet RPC; only confirmed records are requested.</p></div><Status value={transactionState}/></div>
    {transactionError && <p className="ro-inline-warning">{transactionError}</p>}
    <div className="ro-transactions">
      {transactions.length ? transactions.map((tx, index) => {
        const hash = tx.txID || tx.txid || tx.transaction_id
        const contract = tx.raw_data?.contract?.[0]
        const type = contract?.type || tx.contractType || 'TRON transaction'
        const result = tx.ret?.[0]?.contractRet || tx.ret?.[0]?.contract_ret || 'CONFIRMED'
        const successful = result === 'SUCCESS'
        const timestamp = tx.block_timestamp || tx.raw_data?.timestamp
        return <div className="ro-transaction" key={hash || index}>
          <span className={'ro-tx-icon ' + (successful ? 'success' : 'warning')}><ArrowUpRight size={15}/></span>
          <div className="ro-tx-info"><b>{type.replace(/Contract$/, '')}</b><small>{shortHash(hash)} · Block {tx.blockNumber || tx.block_number || '—'}</small></div>
          <span className={'ro-tx-result ' + (successful ? 'success' : 'warning')}>{result}</span>
          <time>{timestamp ? time(new Date(Number(timestamp)).toISOString()) : '—'}</time>
          {hash && <a href={'https://tronscan.org/#/transaction/' + encodeURIComponent(hash)} target="_blank" rel="noreferrer" aria-label="Open transaction in TRONSCAN">Open <ArrowUpRight size={12}/></a>}
        </div>
      }) : <div className="ro-empty">{transactionState === 'checking' ? 'Loading confirmed Mainnet transactions…' : transactionError ? 'Transaction data is currently unavailable. No activity is being fabricated.' : 'No confirmed owner-wallet transactions were returned by Mainnet RPC.'}</div>}
    </div>
    <p className="ro-feed-time">Last chain feed check: {time(lastTransactionCheck)} · Owner: {OWNER.slice(0, 8)}…{OWNER.slice(-6)}</p>

    <div className="ro-section-heading"><div><span className="ro-eyebrow">RUNTIME EVENT TRACE</span><h4>Actual API activity</h4><p>Requests observed by the backend, with address and query parameters removed.</p></div><span className="ro-event-count">{events.length} events</span></div>
    <div className="ro-events" aria-live="polite">
      {events.length ? events.slice(0, 12).map(event => <div className="ro-event" key={event.id}><i className={event.state}/><time>{time(event.at)}</time><b>{event.title}</b><span>{event.detail}</span></div>) : <div className="ro-empty">Waiting for real API actions…</div>}
    </div>
    <div className="ro-monitor-legend"><span><i className="ok"/> Confirmed live response</span><span><i className="warn"/> Degraded / not configured</span><span><i className="bad"/> Request failed</span><span><i className="pulse"/> Animated indicator = recent backend heartbeat</span></div>
    <p className="ro-scope-note">Uptime and samples shown here cover the current API process only. The existing free Render service can suspend or restart; durable 24/7 history requires persistent storage and an always-on monitoring process. Render platform metrics are sampled at coarser intervals and are not represented as one-second data.</p>
  </section>
}
