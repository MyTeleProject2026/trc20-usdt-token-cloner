import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveTronScanApiKey } from '../tronscan-config.mjs'

test('preferred TronScan Pro key is selected without exposing its value in metadata', () => {
  const result = resolveTronScanApiKey({
    TRONSCAN_PRO_API_KEY: '  pro-secret-value  ',
    TRONSCAN_API_KEY: 'fallback-secret-value',
  })
  assert.equal(result.value, 'pro-secret-value')
  assert.equal(result.source, 'TRONSCAN_PRO_API_KEY')
})

test('generic TronScan API key is accepted as a compatibility fallback', () => {
  const result = resolveTronScanApiKey({ TRONSCAN_API_KEY: 'generic-secret-value' })
  assert.equal(result.value, 'generic-secret-value')
  assert.equal(result.source, 'TRONSCAN_API_KEY')
})

test('empty and whitespace-only TronScan keys remain unconfigured', () => {
  assert.deepEqual(resolveTronScanApiKey({ TRONSCAN_PRO_API_KEY: ' ', TRONSCAN_API_KEY: '' }), {
    value: '', source: null,
  })
})
