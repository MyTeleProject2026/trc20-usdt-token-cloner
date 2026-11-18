import { monitorEventLoopDelay } from 'node:perf_hooks'

const finite = value => Number.isFinite(value) ? value : 0

export function createRuntimeObservatory({
  heartbeatIntervalMs = 1_000,
  maxSamples = 120,
  maxEvents = 100,
  now = Date.now,
} = {}) {
  const startedAt = now()
  const loopDelay = monitorEventLoopDelay({ resolution: 20 })
  loopDelay.enable()
  const samples = []
  const events = []
  const requests = []
  let heartbeatCount = 0
  let heartbeatMisses = 0
  let lastHeartbeatAt = startedAt
  let stopped = false

  function addEvent(event) {
    events.unshift({ id: `${now()}-${events.length}-${Math.random().toString(36).slice(2, 7)}`, at: new Date(now()).toISOString(), ...event })
    if (events.length > maxEvents) events.length = maxEvents
  }

  function pulse() {
    if (stopped) return
    const at = now()
    if (heartbeatCount > 0 && at - lastHeartbeatAt > heartbeatIntervalMs * 2.5) heartbeatMisses += 1
    heartbeatCount += 1
    lastHeartbeatAt = at
    const memory = process.memoryUsage()
    const sample = {
      at: new Date(at).toISOString(),
      uptimeSeconds: Math.floor((at - startedAt) / 1_000),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      eventLoopP95Ms: finite(loopDelay.percentile(95) / 1e6),
    }
    samples.push(sample)
    if (samples.length > maxSamples) samples.shift()
    loopDelay.reset()
  }

  function recordHttpRequest({ method = 'GET', path = '/', statusCode = 0, durationMs = 0 } = {}) {
    const at = now()
    const safePath = String(path).split('?')[0].replace(/T[1-9A-HJ-NP-Za-km-z]{33}/g, ':address').slice(0, 120)
    const request = { at, method: String(method).slice(0, 8), path: safePath, statusCode: Number(statusCode) || 0, durationMs: Math.max(0, finite(Number(durationMs))) }
    requests.push(request)
    while (requests.length && at - requests[0].at > 60_000) requests.shift()
    if (request.path !== '/api/observatory/snapshot' && (request.method !== 'GET' || request.path !== '/health')) {
      addEvent({
        type: 'http_request',
        state: request.statusCode >= 500 ? 'error' : request.statusCode >= 400 ? 'warning' : 'success',
        title: `${request.method} ${request.path}`,
        detail: `HTTP ${request.statusCode} · ${Math.round(request.durationMs)} ms`,
      })
    }
  }

  pulse()
  const timer = setInterval(pulse, heartbeatIntervalMs)
  timer.unref?.()

  return {
    recordHttpRequest,
    snapshot() {
      const at = now()
      const currentRequests = requests.filter(item => at - item.at <= 60_000)
      const sorted = currentRequests.map(item => item.durationMs).sort((a, b) => a - b)
      const errorCount = currentRequests.filter(item => item.statusCode >= 500).length
      const memory = process.memoryUsage()
      const latest = samples.at(-1)
      return {
        ok: true,
        service: 'tron-transfer-resource-api',
        scope: 'current-process-only',
        sampledAt: new Date(at).toISOString(),
        uptimeSeconds: Math.floor((at - startedAt) / 1_000),
        heartbeat: {
          state: 'online',
          intervalMs: heartbeatIntervalMs,
          count: heartbeatCount,
          missedIntervals: heartbeatMisses,
          lastAt: new Date(lastHeartbeatAt).toISOString(),
          successPercent: heartbeatCount ? Number(((heartbeatCount - heartbeatMisses) / heartbeatCount * 100).toFixed(3)) : 0,
        },
        process: {
          pid: process.pid,
          nodeVersion: process.version,
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
          heapTotalBytes: memory.heapTotal,
          eventLoopP95Ms: latest?.eventLoopP95Ms ?? 0,
        },
        requests: {
          windowSeconds: 60,
          count: currentRequests.length,
          errors5xx: errorCount,
          errorRatePercent: currentRequests.length ? Number((errorCount / currentRequests.length * 100).toFixed(2)) : 0,
          averageLatencyMs: sorted.length ? Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length) : 0,
          p95LatencyMs: sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * .95) - 1)]) : 0,
        },
        samples: samples.slice(-60),
        events: events.slice(0, 40),
        retention: 'Volatile memory; reset when this Render process restarts. Persistent historical uptime requires an active datastore.',
      }
    },
    stop() {
      stopped = true
      clearInterval(timer)
      loopDelay.disable()
    },
  }
}
