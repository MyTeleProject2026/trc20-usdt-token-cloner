import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = path => readFile(new URL(path, import.meta.url), 'utf8')

test('TRӾ Mainnet manager remains integrated into the production frontend', async () => {
  const app = await read('../src/App.jsx')
  const panel = await read('../src/TRXMainnetPanel.jsx')
  assert.ok(app.includes("import TRXMainnetPanel from './TRXMainnetPanel.jsx'"))
  assert.ok(panel.includes('TRӾ token control center'))
  assert.ok(app.includes('TRAXSidebar'))
  assert.ok(app.includes('MobileNavBar'))
  assert.ok(app.includes('trax-admin-shell'))
  assert.ok(panel.includes('Deploy TRӾ automatically'))
  assert.ok(panel.includes('verifyTRAXTokenContract'))
})

test('TRӾ interface keeps wallet and transaction status accessible', async () => {
  const app = await read('../src/App.jsx')
  const panel = await read('../src/TRXMainnetPanel.jsx')
  assert.match(app, /role=\{walletError \? 'alert' : 'status'\}/)
  assert.ok(panel.includes('role="status"'))
  assert.ok(panel.includes('role="alert"'))
  assert.ok(panel.includes('trax-actions'))
  assert.ok(panel.includes('TRON Mainnet'))
})

test('responsive production theme retains mobile breakpoints and TRӾ panel styling', async () => {
  const css = await read('../src/styles.css')
  const traxCss = await read('../src/trax-mainnet.css')
  assert.ok(css.includes('--bg:'))
  assert.ok(css.includes('@media'))
  assert.ok(css.includes('.trax-admin-shell'))
  assert.ok(css.includes('.trax-mobile-nav'))
  assert.ok(css.includes('.trax-sidebar.collapsed'))
  assert.ok(traxCss.includes('.trax-workspace'))
  assert.ok(traxCss.includes('.trax-token-mark'))
  assert.ok(traxCss.includes('@media(max-width:560px)'))
})

test('frontend does not expose sponsor payout workflow inside the TRӾ manager', async () => {
  const app = await read('../src/App.jsx')
  assert.ok(app.includes('TRXMainnetPanel'))
  assert.ok(!app.includes('<SponsorDirectPayouts'))
})
