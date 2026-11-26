import test from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/AetheriaMcpMesh.jsx', import.meta.url), 'utf8')
const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
const mobileNav = await readFile(new URL('../src/MobileNavBar.jsx', import.meta.url), 'utf8')

test('AETHERIA home maps every live monitoring endpoint to a one-to-one function flow', () => {
  for (const id of ['health', 'providers', 'explorer', 'runtime', 'resources', 'transactions', 'renderEvents', 'uptime', 'renderMetrics']) {
    assert.ok(source.includes("id: '" + id + "'"), 'Missing flow: ' + id)
  }
  for (const endpoint of ['/health', '/api/mainnet/provider-health', '/api/mainnet/explorer-health', '/api/observatory/snapshot', '/v1/resources/', '/api/observatory/transactions', '/api/observatory/render-events', '/api/observatory/uptime-history', '/api/observatory/render-metrics']) {
    assert.ok(source.includes(endpoint), 'Missing live endpoint mapping: ' + endpoint)
  }
  assert.ok(source.includes("callback: 'received'"))
  assert.ok(source.includes('MCP EXECUTION ROUTER'))
  assert.ok(source.includes('FUNCTION RETURN BUS'))
})

test('mesh keeps its one-second clock local and polls upstream services conservatively', () => {
  for (const cadence of ['health: 30_000', 'providers: 60_000', 'explorer: 120_000', 'runtime: 5_000', 'resources: 30_000', 'transactions: 60_000', 'renderEvents: 60_000', 'uptime: 300_000', 'renderMetrics: 300_000']) {
    assert.ok(source.includes(cadence), 'Missing polling cadence: ' + cadence)
  }
  assert.ok(source.includes("path: '/health', interval: '30s'"))
  assert.ok(source.includes("path: '/api/mainnet/provider-health', interval: '60s · 30s cache'"))
  assert.ok(source.includes("path: '/api/mainnet/explorer-health', interval: '120s · 60s cache'"))
  assert.ok(source.includes("path: '/api/observatory/snapshot', interval: '5s'"))
  assert.ok(source.includes('heartbeatAge <= 8000'))
  assert.ok(source.includes('window.setInterval(() => setClockNow(Date.now()), 1000)'))
  assert.doesNotMatch(source, /tenergy|promo/i)
  assert.match(source, /Tatum Mainnet · primary RPC/)
  assert.match(source, /TronGrid Mainnet · fallback RPC/)
  assert.match(source, /TronScan Mainnet · explorer\/indexer/)
})

test('mesh suspends polling while hidden and clears timers on unmount', () => {
  assert.ok(source.includes("document.visibilityState === 'hidden'"))
  assert.ok(source.includes("document.addEventListener('visibilitychange', onVisibility)"))
  assert.ok(source.includes("document.removeEventListener('visibilitychange', onVisibility)"))
  assert.ok(source.includes('timers.forEach(timer => window.clearInterval(timer))'))
  assert.ok(source.includes('alive.current = false'))
})

test('Owner Admin Home mounts AETHERIA directly and removes the former monitor route import', () => {
  assert.ok(app.includes("import AetheriaMcpMesh from './AetheriaMcpMesh.jsx'"))
  assert.ok(app.includes("activePage === 'home' ? <AetheriaMcpMesh"))
  assert.doesNotMatch(app, /PlatformMonitor|RuntimeObservatory/)
  assert.ok(mobileNav.includes("const primaryIds = ['home', 'issuance', 'credits', 'transfers']"))
  assert.doesNotMatch(mobileNav, /overview/)
})

test('former platform monitor UI sources are removed rather than retained beside the mesh', async () => {
  for (const path of ['../src/PlatformMonitor.jsx', '../src/RuntimeObservatory.jsx', '../src/platform-monitor.css', '../src/runtime-observatory.css']) {
    await assert.rejects(access(new URL(path, import.meta.url)))
  }
})

test('Mainnet refresh honors Retry-After and cools down rate-limited flow requests', () => {
  assert.ok(source.includes("response.headers?.get?.('retry-after')"))
  assert.ok(source.includes('body.retryAfterSeconds'))
  assert.ok(source.includes('const cooldownUntil = useRef(new Map())'))
  assert.ok(source.includes("error.statusCode === 429"))
  assert.ok(source.includes("API rate limit; retry in "))
  assert.ok(source.includes("callback: 'cooldown'"))
})
