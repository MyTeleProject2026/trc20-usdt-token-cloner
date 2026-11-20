import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = path => readFile(new URL(path, import.meta.url), 'utf8')

test('desktop sidebar and mobile bottom navigation expose all TRӾ admin pages', async () => {
  const app = await read('../src/App.jsx')
  const sidebar = await read('../src/TRAXSidebar.jsx')
  const mobile = await read('../src/MobileNavBar.jsx')
  const ids = ['home','portfolio','deploy','issuance','credits','batch','pause','minting','transfers','ownership','history','balance']
  for (const id of ids) assert.ok(app.includes("id: '" + id + "'"), 'missing page route: ' + id)
  assert.ok(sidebar.includes('Desktop workspace navigation'))
  assert.ok(sidebar.includes('collapsed'))
  assert.ok(sidebar.includes('Expand sidebar'))
  assert.ok(sidebar.includes('Collapse sidebar'))
  assert.ok(mobile.includes("const primaryIds = ['home', 'issuance', 'credits', 'transfers']"))
  assert.ok(mobile.includes('More workspace'))
  assert.ok(mobile.includes('role="dialog"'))
})

test('each TRӾ admin page is wired to the existing on-chain operation', async () => {
  const panel = await read('../src/TRXMainnetPanel.jsx')
  const app = await read('../src/App.jsx')
  const mesh = await read('../src/AetheriaMcpMesh.jsx')
  assert.ok(app.includes("activePage === 'home' ? <AetheriaMcpMesh"), 'Home must render AETHERIA Global MCP Mesh')
  assert.ok(mesh.includes("/health") && mesh.includes("/v1/resources/"), 'mesh must poll real API routes')
  assert.ok(mesh.includes("/api/tron/tenergy/promo"), 'mesh must poll TEnergy status')
  assert.ok(mesh.includes('MCP EXECUTION ROUTER') && mesh.includes('FUNCTION RETURN BUS'), 'mesh must expose function and callback flows')
  assert.ok(panel.includes('onClick={claimTenergyPromo}'), 'deployment page must expose explicit TEnergy claim action')
  assert.ok(panel.includes('Check &amp; claim TEnergy Energy'), 'TEnergy claim action must be visible')
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


test('Owner and Sponsor wallet workspaces have separate navigation contexts', async () => {
  const app = await read('../src/App.jsx')
  const mobile = await read('../src/MobileNavBar.jsx')
  assert.ok(app.includes("const sponsorWorkspace = activePage === 'sponsor'"))
  assert.ok(app.includes("NAV_ITEMS.filter(item => item.id === 'sponsor')"))
  assert.ok(app.includes('Owner workspace') && app.includes('Sponsor workspace'))
  assert.ok(app.includes('workspace={sponsorWorkspace ? "sponsor" : "owner"}'))
  assert.ok(mobile.includes('trax-mobile-nav-sponsor'))
  assert.ok(mobile.includes("onNavigate('home')"))
})

test('workspace layout has responsive desktop, tablet and mobile breakpoints', async () => {
  const css = await read('../src/styles.css')
  assert.ok(css.includes('.trax-workspace-switch'))
  assert.ok(css.includes('@media(max-width:1100px)'))
  assert.ok(css.includes('@media(max-width:900px) and (min-width:721px)'))
  assert.ok(css.includes('@media(max-width:720px)'))
  assert.ok(css.includes('trax-mobile-nav-sponsor'))
})
