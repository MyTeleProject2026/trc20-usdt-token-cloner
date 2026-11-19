import test from 'node:test'
import assert from 'node:assert/strict'
import { createRuntimeObservatory } from '../runtime-observatory.mjs'

test('runtime observatory emits one-second process heartbeats and bounded samples', async (t) => {
  const monitor = createRuntimeObservatory({ heartbeatIntervalMs: 10, maxSamples: 3 })
  t.after(() => monitor.stop())
  await new Promise(resolve => setTimeout(resolve, 45))
  const snapshot = monitor.snapshot()
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.heartbeat.state, 'online')
  assert.ok(snapshot.heartbeat.count >= 3)
  assert.equal(snapshot.samples.length, 3)
  assert.equal(snapshot.scope, 'current-process-only')
})

test('runtime observatory records sanitized HTTP actions and rolling request metrics', () => {
  const monitor = createRuntimeObservatory()
  try {
    monitor.recordHttpRequest({
      method: 'POST',
      path: '/api/tron/tenergy/promo/redeem?address=TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp',
      statusCode: 201,
      durationMs: 43.4,
    })
    const snapshot = monitor.snapshot()
    assert.equal(snapshot.requests.count, 1)
    assert.equal(snapshot.requests.errors5xx, 0)
    assert.equal(snapshot.events[0].state, 'success')
    assert.equal(snapshot.events[0].title, 'POST /api/tron/tenergy/promo/redeem')
    assert.equal(JSON.stringify(snapshot).includes('TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'), false)
  } finally {
    monitor.stop()
  }
})

test('runtime observatory flags server errors in the event stream', () => {
  const monitor = createRuntimeObservatory()
  try {
    monitor.recordHttpRequest({ method: 'GET', path: '/api/failing', statusCode: 503, durationMs: 900 })
    const snapshot = monitor.snapshot()
    assert.equal(snapshot.requests.errors5xx, 1)
    assert.equal(snapshot.events[0].state, 'error')
  } finally {
    monitor.stop()
  }
})
