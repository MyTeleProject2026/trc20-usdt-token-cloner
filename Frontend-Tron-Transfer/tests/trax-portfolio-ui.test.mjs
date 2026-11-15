import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const panelUrl = new URL('../src/TRXMainnetPanel.jsx', import.meta.url)
const iconUrl = new URL('../public/trax-token-mark.svg', import.meta.url)
const pricingUrl = new URL('../src/trax-pricing.mjs', import.meta.url)

test('portfolio presents one estimated USD total while preserving each underlying asset quantity', async () => {
  const panel = await readFile(panelUrl, 'utf8')
  const pricing = await readFile(pricingUrl, 'utf8')
  assert.match(panel, /Estimated combined portfolio value/)
  assert.match(panel, /Native TRX/)
  assert.match(panel, /TRӾ reference value/)
  assert.match(panel, /Official USDT/)
  assert.match(panel, /no reserve, collateral, guaranteed redemption, fixed 1:1 TRX value/)
  assert.match(pricing, /traxReferenceUsd: tronUsd/)
  assert.match(pricing, /valuationType: 'reference-estimate'/)
})

test('TRAX UI references the repository TRӾ token image asset', async () => {
  const panel = await readFile(panelUrl, 'utf8')
  const icon = await readFile(iconUrl, 'utf8')
  assert.ok(panel.includes('src="/trax-token-mark.svg"'))
  assert.match(icon, /viewBox="0 0 512 512"/)
  assert.match(icon, /fill="#ff0013"/)
  assert.match(icon, /L231,447/)
})
