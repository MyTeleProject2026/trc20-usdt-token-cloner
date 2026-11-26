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
  assert.ok(sidebar.includes('trax-desktop-workspace-nav'))
  assert.ok(sidebar.includes('Owner workspace pages') && sidebar.includes('Sponsor workspace pages'))
  assert.ok(sidebar.includes('collapsed'))
  assert.ok(sidebar.includes('Expand sidebar'))
  assert.ok(sidebar.includes('Collapse sidebar'))
  assert.ok(mobile.includes("const primaryIds = ['home', 'portfolio', 'issuance', 'transfers']"))
  assert.ok(mobile.includes('More workspace'))
  assert.ok(mobile.includes('role="dialog"'))
})

test('account security and pending-owner acceptance stay inside existing workflows without new navigation tabs', async () => {
  const app = await read('../src/App.jsx')
  const ownership = await read('../src/TRAXOwnershipControls.jsx')
  assert.ok(!app.includes("id: 'accept-ownership'"), 'pending-owner acceptance must not add a navigation page')
  assert.ok(!app.includes("id: 'account-security'"), 'account security must not add a navigation page')
  assert.ok(app.includes('ownerSecurityOpen') && app.includes('trax-topbar-security'), 'account security must open from existing Owner session controls')
  assert.ok(!app.includes('PendingOwnerAcceptance'), 'pending-owner acceptance must not be routed as a standalone page')
  assert.ok(ownership.includes("import PendingOwnerAcceptance from './PendingOwnerAcceptance.jsx'"))
  assert.ok(ownership.includes('<PendingOwnerAcceptance/>'), 'pending-owner acceptance must be embedded in Ownership transfer')
})

test('each TRӾ admin page is wired to the existing on-chain operation', async () => {
  const panel = await read('../src/TRXMainnetPanel.jsx')
  const app = await read('../src/App.jsx')
  const mesh = await read('../src/AetheriaMcpMesh.jsx')
  assert.ok(app.includes("activePage === 'home' ? <AetheriaMcpMesh"), 'Home must render AETHERIA Global MCP Mesh')
  assert.ok(mesh.includes("/health") && mesh.includes("/v1/resources/"), 'mesh must poll real API routes')
  assert.doesNotMatch(mesh, /tenergy|promo/i, 'Home monitoring must not expose external resource-claim integrations')
  assert.ok(mesh.includes('/api/mainnet/provider-health'), 'Home must independently verify Mainnet RPC providers')
  assert.ok(mesh.includes('/api/mainnet/explorer-health'), 'Home must independently verify TronScan explorer availability')
  assert.match(mesh, /Tatum Mainnet · primary RPC/)
  assert.match(mesh, /TronGrid Mainnet · fallback RPC/)
  assert.match(mesh, /TronScan Mainnet · explorer\/indexer/)
  assert.ok(mesh.includes('MCP EXECUTION ROUTER') && mesh.includes('FUNCTION RETURN BUS'), 'mesh must expose function and callback flows')
  assert.doesNotMatch(panel, /claimTenergyPromo|TEnergy|free energy promotion/i, 'Owner deployment must not expose external resource claims')
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
  assert.ok(app.includes("const sponsorWorkspace = activePage.startsWith('sponsor')"))
  assert.ok(app.includes("NAV_ITEMS.filter(item => item.id.startsWith('sponsor'))"))
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


test('Sponsor workspace exposes independent Overview, Resources, Automation and Activity sections', async () => {
  const app = await read('../src/App.jsx')
  const sponsor = await read('../src/SponsorWalletManager.jsx')
  const mobile = await read('../src/MobileNavBar.jsx')
  const css = await read('../src/sponsor-wallet.css')
  for (const id of ['sponsor','sponsor-resources','sponsor-automation','sponsor-activity']) {
    assert.ok(app.includes("id: '" + id + "'"), 'missing Sponsor workspace route: ' + id)
  }
  assert.ok(app.includes("activePage.startsWith('sponsor')"))
  assert.ok(app.includes('<SponsorWalletManager activePage={activePage}'))
  for (const id of ['sponsor-overview','sponsor-resources','sponsor-automation','sponsor-activity']) assert.ok(sponsor.includes('id="' + id + '"'))
  assert.ok(sponsor.includes('Sponsor platform sections'))
  assert.ok(mobile.includes('Sponsor workspace navigation') && mobile.includes('items.map'))
  assert.ok(css.includes('.sponsor-product-tabs') && css.includes('@media(max-width:720px)'))
})

test('Sponsor pages mount only the active section and expose actionable render diagnostics', async () => {
  const sponsor = await read('../src/SponsorWalletManager.jsx')
  const app = await read('../src/App.jsx')
  for (const [id, route] of [['sponsor-overview','sponsor'],['sponsor-resources','sponsor-resources'],['sponsor-automation','sponsor-automation'],['sponsor-activity','sponsor-activity']]) {
    assert.ok(sponsor.includes(`activePage === "${route}" && <section id="${id}"`), id + ' must mount only when active')
    assert.ok(!new RegExp(`<section id="${id}"[^>]*hidden=`).test(sponsor), id + ' must not stay mounted while hidden')
  }
  assert.ok(app.includes('this.state.message') && app.includes('Diagnostic:'), 'error boundary must expose a useful render diagnostic')
  assert.ok(app.includes("this.props.onNavigate('sponsor')"), 'error boundary must offer recovery navigation')
})
test('premium workspace layer preserves reduced motion and mobile Sponsor tabs', async () => {
  const css = await read('../src/styles.css')
  assert.ok(css.includes('TRON TRANSFER Signature Edition'))
  assert.ok(css.includes('@media(max-width:720px)'))
  assert.ok(css.includes('@media(prefers-reduced-motion:reduce)'))
  assert.ok(css.includes('.sponsor-product-tabs button.active'))
})


test('workspace routes are deep-linkable and browser history restores the selected page', async () => {
  const app = await read('../src/App.jsx')
  assert.ok(app.includes('function pageFromLocation()'))
  assert.ok(app.includes('const candidate = window.location.hash.replace('))
  assert.ok(app.includes("window.addEventListener('popstate', syncFromLocation)"))
  assert.ok(app.includes("window.addEventListener('hashchange', syncFromLocation)"))
  assert.ok(app.includes("window.history.pushState({ tronTransferPage: activePage }, '', nextHash)"))
  assert.ok(app.includes('id="trax-workspace-main"'))
})

test('desktop sidebar clearly identifies the active workspace context', async () => {
  const sidebar = await read('../src/TRAXSidebar.jsx')
  assert.ok(sidebar.includes('SPONSOR TREASURY · MAINNET'))
  assert.ok(sidebar.includes('OWNER CONTROL · MAINNET'))
  assert.ok(sidebar.includes('Sponsor workspace pages'))
  assert.ok(sidebar.includes('Owner workspace pages'))
})


test('Sponsor Activity reads authenticated durable ledger records separately from local browser history', async () => {
  const sponsor = await read('../src/SponsorWalletManager.jsx')
  const api = await read('../resource-api/sponsor-api.mjs')
  assert.ok(sponsor.includes("'/api/sponsor/operations?limit=50'"))
  assert.ok(sponsor.includes("createManagedWalletAuthClient({ role: 'sponsor'"))
  assert.ok(sponsor.includes('Sponsor Workspace Login'))
  assert.ok(sponsor.includes('credentials: \'include\''))
  assert.ok(sponsor.includes("body: { intentId: intent.intentId, confirmPhrase: intent.confirmationPhrase }"))
  assert.ok(sponsor.includes('wallet?.privateKey ? createSponsorTronWeb(wallet.privateKey) : null'), 'the imported local Sponsor key must initialize only the local TronWeb signer')
  assert.ok(sponsor.includes('The private key is not sent to the Resource API.'))
  const operationStart = sponsor.indexOf('async function submitResourceTransaction')
  const operationEnd = sponsor.indexOf('async function runResourceAutomation', operationStart)
  const operationSource = sponsor.slice(operationStart, operationEnd)
  assert.ok(!operationSource.includes('wallet.privateKey'), 'the local private key must not be included in Sponsor API request bodies')
  assert.ok(!operationSource.includes('privateKey:'), 'the Sponsor API request body must not contain a privateKey field')
  assert.ok(sponsor.includes('durableOperations'))
  assert.ok(sponsor.includes('Refresh durable ledger'))
  assert.ok(sponsor.includes('Local browser history is shown separately'))
  assert.ok(sponsor.includes("setDurableOperations([])") && sponsor.includes("setDurableLedgerState('idle')"), 'clear previous wallet ledger records on lock or account change')
  assert.ok(api.includes("req.method === 'GET' && path === '/api/sponsor/operations'"))
  assert.ok(api.includes('WHERE sponsor_address=$1 ORDER BY created_at DESC LIMIT $2'))
})
