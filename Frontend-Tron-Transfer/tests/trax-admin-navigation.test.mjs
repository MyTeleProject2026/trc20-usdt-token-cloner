import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = path => readFile(new URL(path, import.meta.url), 'utf8')

test('desktop sidebar and mobile bottom navigation expose all TRӾ admin pages', async () => {
  const app = await read('../src/App.jsx')
  const sidebar = await read('../src/TRAXSidebar.jsx')
  const mobile = await read('../src/MobileNavBar.jsx')
  const ids = ['overview','portfolio','deploy','issuance','credits','batch','pause','minting','transfers','ownership','history','balance']
  for (const id of ids) assert.ok(app.includes("id: '" + id + "'"), 'missing page route: ' + id)
  assert.ok(sidebar.includes('Desktop workspace navigation'))
  assert.ok(sidebar.includes('collapsed'))
  assert.ok(sidebar.includes('Expand sidebar'))
  assert.ok(sidebar.includes('Collapse sidebar'))
  assert.ok(mobile.includes("const primaryIds = ['overview', 'issuance', 'credits', 'transfers']"))
  assert.ok(mobile.includes('More workspace'))
  assert.ok(mobile.includes('role="dialog"'))
})

test('each TRӾ admin page is wired to the existing on-chain operation', async () => {
  const panel = await read('../src/TRXMainnetPanel.jsx')
  const app = await read('../src/App.jsx')
  const monitor = await read('../src/PlatformMonitor.jsx')
  assert.ok(app.includes("activePage === 'overview' ? <PlatformMonitor"), 'Home must render the live platform monitor')
  assert.ok(monitor.includes("/health") && monitor.includes("/v1/resources/"), 'monitor must poll real API routes')
  assert.ok(monitor.includes("/api/tron/tenergy/promo"), 'monitor must poll TEnergy status')
  for (const page of ['portfolio','deploy','issuance','credits','batch','pause','minting','transfers','ownership','history','balance']) {
    assert.ok(panel.includes("show('" + page + "')"), 'missing page rendering: ' + page)
  }
  for (const action of ['issueOwnerSupply','issueCredit','batchCredit','pause','unpauseTransfers','enableMinting','disableMinting','transfer']) {
    assert.ok(panel.includes('onClick={' + action + '}') || panel.includes('onClick={() => ' + action + '}') || panel.includes('onClick={'+action+'}'), 'missing action binding: ' + action)
  }
  assert.ok(panel.includes('<TRAXOwnershipControls'))
  assert.ok(panel.includes('<TRAXCreditHistory'))
  assert.ok(panel.includes('busy={busy}'))
})

test('TRӾ admin theme includes the bank-style responsive shell and reduced-motion support', async () => {
  const css = await read('../src/styles.css')
  assert.ok(css.includes('.trax-admin-shell'))
  assert.ok(css.includes('.trax-sidebar'))
  assert.ok(css.includes('.trax-mobile-nav'))
  assert.ok(css.includes('.trax-mobile-sheet'))
  assert.ok(css.includes('@media(prefers-reduced-motion:reduce)'))
})

test('TRӾ metadata checks and price labels match the requested token identity', async () => {
  const panel = await read('../src/TRXMainnetPanel.jsx')
  const helper = await read('../src/trax-mainnet.mjs')
  const contract = await read('../../contracts/Restricted1TRAX.sol')
  const pricing = await read('../src/trax-pricing.mjs')
  assert.ok(contract.includes('string public constant symbol = unicode"TRӾ";'))
  assert.ok(helper.includes("String(symbol) !== 'TRӾ'"))
  assert.ok(panel.includes("symbol === 'TRӾ'"))
  assert.match(panel, /Market price .+formatUsd/)
  assert.match(panel, /No verified TRӾ market quote/)
  assert.ok(pricing.includes('traxReferenceUsd: null'))
  assert.ok(pricing.includes('no verified TRӾ market quote'))
})
