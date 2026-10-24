import test from 'node:test'
import assert from 'node:assert/strict'
import { isReadOnlyServiceReady } from '../server/readiness-policy.mjs'

const healthy = {
  database: { ready: true },
  providers: {
    tatum: { reachable: true },
    frontendOrigin: { configured: true },
  },
}

test('read-only readiness requires storage, provider reachability and browser origin configuration', () => {
  assert.equal(isReadOnlyServiceReady(healthy), true)

  assert.equal(isReadOnlyServiceReady({
    ...healthy,
    providers: {
      ...healthy.providers,
      frontendOrigin: { configured: false },
    },
  }), false)

  assert.equal(isReadOnlyServiceReady({
    ...healthy,
    providers: {
      ...healthy.providers,
      tatum: { reachable: false },
    },
  }), false)

  assert.equal(isReadOnlyServiceReady({
    ...healthy,
    database: { ready: false },
  }), false)
})

test('read-only readiness fails closed for incomplete or malformed status objects', () => {
  assert.equal(isReadOnlyServiceReady(), false)
  assert.equal(isReadOnlyServiceReady({ database: { ready: true }, providers: {} }), false)
  assert.equal(isReadOnlyServiceReady({
    database: { ready: true },
    providers: {
      tatum: { reachable: true },
      frontendOrigin: { configured: 'true' },
    },
  }), false)
})
