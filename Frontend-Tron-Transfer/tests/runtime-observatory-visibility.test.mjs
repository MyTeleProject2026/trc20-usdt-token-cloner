import test from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/AetheriaMcpMesh.jsx', import.meta.url), 'utf8')
const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')

test('AETHERIA home maps every live monitoring endpoint to a one-to-one function flow', () => {
  for (const id of ['health', 'runtime', 'resources', 'tenergy', 'transactions', 'renderEvents', 'uptime', 'renderMetrics']) {
    assert.match(source, new RegExp("id: '" + id + "'"))
  }
  for (const endpoint of ['/health', '/api/observatory/snapshot', '/v1/resources/', '/api/tron/tenergy/promo', '/api/observatory/transactions', '/api/observatory/render-events', '/api/observatory/uptime-history', '/api/observatory/render-metrics']) {
    assert.ok(source.includes(endpoint), 'Missing live endpoint mapping: ' + endpoint)
  }
  assert.match(source, /callback: 'received'/)
  assert.match(source, /MCP EXECUTION ROUTER/)
  assert.match(source, /FUNCTION RETURN BUS/)
})

test('mesh UI ticks every second while upstream polling respects service cache and rate limits', () => {
  assert.match(source, /runtime: 1_000/)
  assert.match(source, /resources: 15_000/)
  assert.match(source, /tenergy: 15_000/)
  assert.match(source, /transactions: 10_000/)
  assert.match(source, /renderEvents: 30_000/)
  assert.match(source, /uptime: 60_000/)
  assert.match(source, /renderMetrics: 60_000/)
  assert.match(source, /window\\.setInterval\\(\\(\\) => setClockNow\\(Date\\.now\\(\\)\\), 1000\\)/)
})

test('mesh suspends polling while hidden and clears timers on unmount', () => {
  assert.match(source, /document\\.visibilityState === 'hidden'/)
  assert.match(source, /document\\.addEventListener\\('visibilitychange', onVisibility\\)/)
  assert.match(source, /document\\.removeEventListener\\('visibilitychange', onVisibility\\)/)
  assert.match(source, /timers\\.forEach\\(timer => window\\.clearInterval\\(timer\\)\\)/)
  assert.match(source, /alive\\.current = false/)
})

test('Owner Admin Home mounts AETHERIA directly and removes the former monitor route import', () => {
  assert.match(app, /import AetheriaMcpMesh from '\\.\\/AetheriaMcpMesh\\.jsx'/)
  assert.match(app, /activePage === 'home' \\? <AetheriaMcpMesh/)
  assert.doesNotMatch(app, /PlatformMonitor|RuntimeObservatory|overview/)
})

test('former platform monitor UI sources are removed rather than retained beside the mesh', async () => {
  for (const path of ['../src/PlatformMonitor.jsx', '../src/RuntimeObservatory.jsx', '../src/platform-monitor.css', '../src/runtime-observatory.css']) {
    await assert.rejects(access(new URL(path, import.meta.url)))
  }
})
