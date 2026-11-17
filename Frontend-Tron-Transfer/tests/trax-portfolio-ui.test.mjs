import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const panelUrl = new URL('../src/TRXMainnetPanel.jsx', import.meta.url)
const appUrl = new URL('../src/App.jsx', import.meta.url)
const iconUrl = new URL('../public/trax-token-mark.svg', import.meta.url)
const pricingUrl = new URL('../src/trax-pricing.mjs', import.meta.url)

test('portfolio presents one estimated USD total while preserving each underlying asset quantity', async () => {
  const panel = await readFile(panelUrl, 'utf8')
  const pricing = await readFile(pricingUrl, 'utf8')
  assert.match(panel, /Combined wallet portfolio value/)
  assert.match(panel, /Estimated combined portfolio value/)
  assert.match(panel, /Native TRX/)
  assert.match(panel, /TRӾ reference value/)
  assert.match(panel, /Official USDT/)
  assert.match(panel, /not a guaranteed exchange trading price/)
  assert.match(panel, /Combined estimated portfolio value/)
  assert.match(pricing, /traxReferenceUsd/)
  assert.match(pricing, /0\.000001/)
  assert.match(pricing, /valuationType: 'reference-estimate'/)
})

test('TRӾ uses the requested theSVG TRON icon', async () => {
  const panel = await readFile(panelUrl, 'utf8')
  const app = await readFile(appUrl, 'utf8')
  const icon = await readFile(iconUrl, 'utf8')
  assert.ok(panel.includes('src="https://thesvg.org/icons/tron/default.svg"'))
  assert.ok(panel.includes('aria-label="TRӾ custom token"'))
  assert.ok(panel.includes('background:"#000"'))
  assert.ok(app.includes('background:"#000"'))
  assert.ok(app.includes('src="https://thesvg.org/icons/tron/default.svg"'))
  assert.ok(app.includes('icon:TraxNavIcon'))
  assert.ok(panel.includes('thesvg.org/icons/tron/default.svg'))
  assert.ok(app.includes('thesvg.org/icons/tron/default.svg'))
  assert.ok(icon.includes('<svg'))
})
