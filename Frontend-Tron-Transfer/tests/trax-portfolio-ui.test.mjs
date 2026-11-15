import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const panelUrl = new URL('../src/TRXMainnetPanel.jsx', import.meta.url)
const iconUrl = new URL('../public/trax-token-mark.png', import.meta.url)

test('portfolio shows native TRX and custom TRAX as separate, identified holdings', async () => {
  const panel = await readFile(panelUrl, 'utf8')
  assert.match(panel, /Wallet portfolio overview/)
  assert.match(panel, /Native TRX · network fees/)
  assert.match(panel, /TRӾ \/ TRAX · custom TRC-20/)
  assert.match(panel, /different units and transfer rules/)
  assert.match(panel, /custom-token contract address/)
  assert.match(panel, /native TRX does not have a TRC-20 contract address/)
})

test('TRAX uses the exact user-supplied red-circle, black-TRON-mark image', async () => {
  const panel = await readFile(panelUrl, 'utf8')
  const icon = await readFile(iconUrl)
  assert.match(panel, /src="\/trax-token-mark\.png"/)
  assert.ok(icon.length > 7000)
  assert.equal(icon.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
})
