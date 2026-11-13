import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = path => readFile(new URL(path, import.meta.url), 'utf8')

test('TRӾ Mainnet manager remains the primary frontend workflow', async () => {
  const app = await read('../src/App.jsx')
  const panel = await read('../src/TRXMainnetPanel.jsx')
  assert.ok(app.includes("import TRXMainnetPanel from './TRXMainnetPanel.jsx'"))
  assert.ok(panel.includes('TRӾ smart-contract manager'))
  assert.ok(panel.includes('Deploy both contracts automatically'))
  assert.ok(panel.includes('On-chain verification'))
})

test('TRӾ interface keeps wallet and transaction status accessible', async () => {
  const app = await read('../src/App.jsx')
  const panel = await read('../src/TRXMainnetPanel.jsx')
  assert.ok(app.includes('role="status"') || app.includes('role="status"'))
  assert.ok(app.includes('role="alert"') || app.includes('role="alert"'))
  assert.ok(panel.includes('aria-'))
  assert.ok(panel.includes('TRON Mainnet'))
})

test('responsive visual theme retains mobile breakpoints and accessible contrast tokens', async () => {
  const css = await read('../src/styles.css')
  assert.ok(css.includes('--bg: #080d18'))
  assert.ok(css.includes('--mint-bright: #48b5ff'))
  assert.ok(css.includes('@media (max-width: 820px)'))
  assert.ok(css.includes('@media (max-width: 560px)'))
})

test('frontend does not expose legacy sponsor payout workflow inside the TRӾ manager', async () => {
  const app = await read('../src/App.jsx')
  assert.ok(app.includes('TRXMainnetPanel'))
  assert.ok(!app.includes('<SponsorDirectPayouts'))
})
