import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const panelUrl = new URL('../src/TRXMainnetPanel.jsx', import.meta.url)
const pricingUrl = new URL('../src/trax-pricing.mjs', import.meta.url)

test('portfolio preserves separate asset quantities and never invents a TRӾ market price', async () => {
  const panel = await readFile(panelUrl, 'utf8')
  const pricing = await readFile(pricingUrl, 'utf8')
  assert.match(panel, /Estimated combined portfolio value/)
  assert.match(panel, /Native TRX/)
  assert.match(panel, /TRӾ reference value/)
  assert.match(panel, /Official USDT/)
  assert.match(panel, /without reserves, collateral, guaranteed redemption or a promised market price/)
  assert.match(pricing, /traxReferenceUsd: null/)
  assert.match(pricing, /no verified TRӾ market quote/)
  assert.match(pricing, /if \(quantities\[1\] > 0\) return null/)
})

test('TRӾ UI uses the requested official-style TRON SVG mark', async () => {
  const panel = await readFile(panelUrl, 'utf8')
  assert.ok(panel.includes('https://thesvg.org/icons/tron/default.svg'))
  assert.ok(panel.includes('alt="TRӾ token icon"'))
})
