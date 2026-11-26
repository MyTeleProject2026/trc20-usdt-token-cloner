import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = path => readFile(new URL(path, import.meta.url), 'utf8')

test('JustLend-inspired visual system is applied to actual Owner and Sponsor page interiors', async () => {
  const [app, theme, mainnet, sponsor] = await Promise.all([
    read('../src/App.jsx'),
    read('../src/owner-admin-redesign.css'),
    read('../src/trax-mainnet.css'),
    read('../src/sponsor-wallet.css'),
  ])
  assert.ok(app.includes("import './owner-admin-redesign.css'"))
  for (const selector of [
    '.trax-workspace', '.section-heading', '.trax-stats', '.trax-addresses',
    '.trax-actions', '.button-row', '.trax-history', '.transaction-list',
    '.sponsor-manager', '.sponsor-card', '.sponsor-metric-grid',
    '.sponsor-product-tabs', '.sponsor-release-checks',
  ]) assert.ok(theme.includes(selector), 'missing page-level style selector: ' + selector)
  assert.ok(mainnet.includes('.trax-workspace'))
  assert.ok(sponsor.includes('.sponsor-card'))
})

test('page redesign keeps all existing functional routes and Mainnet safety copy intact', async () => {
  const app = await read('../src/App.jsx')
  const panel = await read('../src/TRXMainnetPanel.jsx')
  const sponsor = await read('../src/SponsorWalletManager.jsx')
  for (const id of [
    'home','portfolio','deploy','issuance','credits','batch','pause','minting',
    'transfers','withdraw','ownership','history','balance',
    'sponsor','sponsor-resources','sponsor-automation','sponsor-activity',
  ]) assert.ok(app.includes("id: '" + id + "'"), 'route removed: ' + id)
  assert.ok(panel.includes('ZERO-TRX-BURN PROTECTION BLOCKED DEPLOYMENT'))
  assert.ok(panel.includes('No transaction was persisted, signed or broadcast'))
  assert.ok(sponsor.includes('SPONSOR_MAINNET_BROADCAST_ENABLED'))
  assert.ok(sponsor.includes('release'))
})
