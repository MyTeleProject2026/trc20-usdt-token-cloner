import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const panelUrl = new URL('../src/TRXMainnetPanel.jsx', import.meta.url)
const appUrl = new URL('../src/App.jsx', import.meta.url)
const iconUrl = new URL('../public/trax-token-mark.svg', import.meta.url)

test('portfolio shows native TRX and custom TRAX as separate, identified holdings', async () => {
  const panel = await readFile(panelUrl, 'utf8')
  assert.match(panel, /Wallet portfolio overview/)
  assert.match(panel, /Native TRX · network fees/)
  assert.match(panel, /TRӾ \/ TRAX · custom TRC-20/)
  assert.match(panel, /different units and transfer rules/)
  assert.match(panel, /custom-token contract address/)
  assert.match(panel, /native TRX does not have a TRC-20 contract address/)
})

test('TRAX uses the user-supplied red-circle, black-geometric-mark image', async () => {
  const panel = await readFile(panelUrl, 'utf8')
  const app = await readFile(appUrl, 'utf8')
  const icon = await readFile(iconUrl, 'utf8')
  assert.ok(panel.includes('src="/trax-token-mark.svg"'))
  assert.ok(panel.includes('aria-label="TRӾ custom token"'))
  assert.ok(app.includes('src="/trax-token-mark.svg"'))
  assert.ok(app.includes('icon:TraxNavIcon'))
  assert.match(icon, /viewBox="0 0 512 512"/)
  assert.match(icon, /fill="#ff0013"/)
  assert.match(icon, /L231,447/)
})
