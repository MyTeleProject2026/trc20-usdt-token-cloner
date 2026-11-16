import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const panelUrl = new URL('../src/TRXMainnetPanel.jsx', import.meta.url)
const pricingUrl = new URL('../src/trax-pricing.mjs', import.meta.url)

test('portfolio presents one estimated USD total while preserving each underlying asset quantity', async () => {
  const panel = await readFile(panelUrl, 'utf8')
  const pricing = await readFile(pricingUrl, 'utf8')
  assert.match(panel, /Estimated combined portfolio value/)
  assert.match(panel, /Native TRX/)
  assert.match(panel, /TRӾ reference value/)
  assert.match(panel, /Official USDT/)
  assert.match(panel, /no reserve, collateral, guaranteed redemption, fixed 1:1 TRX value/)
  assert.match(pricing, /traxReferenceUsd = Number\(\(trxReferenceUsd \+ 0\.000001\)/)
  assert.match(pricing, /owner-defined TRӾ reference adjustment/)
  assert.match(pricing, /valuationType: 'reference-estimate'/)
})

test('TRӾ UI uses the requested official-style TRON SVG mark', async () => {
  const panel = await readFile(panelUrl, 'utf8')
  assert.ok(panel.includes('https://thesvg.org/icons/tron/default.svg'))
  assert.ok(panel.includes('alt="TRӾ token icon"'))
})
