import test from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/AetheriaMcpMesh.jsx', import.meta.url), 'utf8')
const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')

test('AETHERIA home maps every live monitoring endpoint to a one-to-one function flow', () => {
  for (const id of ['health', 'runtime', 'resources', 'tenergy', 'transactions', 'renderEvents', 'uptime', 'renderMetrics']) {
    assert.ok(source.includes("id: '" + id + "'"), 'Missing flow: ' + id)
  }
  for (const endpoint of ['/health', '/api/observatory/snapshot', '/v1/resources/', '/api/tron/tenergy/promo', '/api/observatory/transactions', '/api/observatory/render-events', '/api/observatory/uptime-history', '/api/observatory/render-metrics']) {
    assert.ok(source.includes(endpoint), 'Missing live endpoint mapping: ' + endpoint)
  }
  assert.ok(source.includes("callback: 'received'"))
  assert.ok(source.includes('MCP EXECUTION ROUTER'))
  assert.ok(source.includes('FUNCTION RETURN BUS'))
})

test('mesh UI ticks every second while upstream polling respects service cache and rate limits', () => {
  for (const cadence of ['runtime: 1_000', 'resources: 15_000', 'tenergy: 15_000', 'transactions: 10_000', 'renderEvents: 30_000', 'uptime: 60_000', 'renderMetrics: 60_000']) {
    assert.ok(source.includes(cadence), 'Missing polling cadence: ' + cadence)
  }
  assert.ok(source.includes('window.setInterval(() => setClockNow(Date.now()), 1000)'))
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
  assert.doesNotMatch(app, /PlatformMonitor|RuntimeObservatory|overview/)
})

test('former platform monitor UI sources are removed rather than retained beside the mesh', async () => {
  for (const path of ['../src/PlatformMonitor.jsx', '../src/RuntimeObservatory.jsx', '../src/platform-monitor.css', '../src/runtime-observatory.css']) {
    await assert.rejects(access(new URL(path, import.meta.url)))
  }
})
