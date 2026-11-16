import test from 'node:test'
import assert from 'node:assert/strict'
import { calculatePortfolioValue, fetchTRXReferencePrice } from '../src/trax-pricing.mjs'

test('TRӾ reference price follows the live TRX reference quote without claiming exchange execution', async () => {
  const updatedAt = 1_800_000_000
  const quote = await fetchTRXReferencePrice({
    now: () => updatedAt * 1000 + 1000,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        tron: { usd: 0.307369, last_updated_at: updatedAt },
        tether: { usd: 1.0001 },
      }),
    }),
  })
  assert.equal(quote.trxUsd, 0.307369)
  assert.equal(quote.traxReferenceUsd, 0.307370)
  assert.equal(quote.usdtUsd, 1.0001)
  assert.match(quote.source, /CoinGecko TRX quote/)
  assert.match(quote.source, /owner-defined TRӾ reference adjustment/)
})

test('stale or invalid price data is rejected rather than shown as live', async () => {
  await assert.rejects(fetchTRXReferencePrice({
    now: () => 2_000_000_000_000,
    fetchImpl: async () => ({ ok: true, json: async () => ({ tron: { usd: 0.3, last_updated_at: 1 }, tether: { usd: 1 } }) }),
  }), /stale/)
  await assert.rejects(fetchTRXReferencePrice({
    fetchImpl: async () => ({ ok: true, json: async () => ({ tron: { usd: 0, last_updated_at: 1800000000 }, tether: { usd: 1 } }) }),
  }), /invalid/)
})

test('combined portfolio valuation sums TRX, TRӾ reference value and USDT without merging token units', () => {
  const result = calculatePortfolioValue({
    trx: '100',
    trax: '10000',
    usdt: '5000',
    prices: { trxUsd: 0.307369, traxReferenceUsd: 0.307370, usdtUsd: 1 },
  })
  assert.equal(result.valuationType, 'reference-estimate')
  assert.ok(Math.abs(result.totalUsd - (30.7369 + 3073.70 + 5000)) < 1e-8)
  assert.equal(calculatePortfolioValue({ trx: '1', trax: '1', usdt: '1' }), null)
})
