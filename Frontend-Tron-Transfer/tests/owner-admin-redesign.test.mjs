import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = path => readFile(new URL(path, import.meta.url), 'utf8')

test('owner admin navigation groups related operations into clear workspace sections', async () => {
  const [app, sidebar, mobile, theme] = await Promise.all([
    read('../src/App.jsx'),
    read('../src/TRAXSidebar.jsx'),
    read('../src/MobileNavBar.jsx'),
    read('../src/owner-admin-redesign.css'),
  ])
  for (const group of ['Overview', 'Assets', 'Token operations', 'Transfers', 'Security', 'Sponsor', 'Provisioning', 'Audit']) {
    assert.ok(app.includes("group: '" + group + "'"), 'missing navigation group: ' + group)
  }
  assert.ok(sidebar.includes('trax-sidebar-group-toggle'))
  assert.ok(sidebar.includes('expandedGroups'))
  assert.ok(sidebar.includes("item.group || 'Workspace'"))
  assert.ok(sidebar.includes('/trax-token-mark.svg'))
  assert.ok(mobile.includes("const OWNER_PRIMARY = ['home', 'deploy', 'monitor', 'portfolio', 'profile']"))
  assert.ok(mobile.includes('secondaryGroups.map'))
  assert.ok(theme.includes('--owner-primary: #4e8dff'))
  assert.ok(theme.includes('--owner-bg: #07111f'))
  assert.ok(theme.includes('@media (max-width: 720px)'))
  assert.ok(theme.includes('prefers-reduced-motion: reduce'))
})

test('owner redesign retains Mainnet-only transaction safety and existing route identifiers', async () => {
  const app = await read('../src/App.jsx')
  for (const id of ['home','portfolio','deploy','issuance','credits','batch','pause','minting','transfers','withdraw','ownership','history','balance']) {
    assert.ok(app.includes("id: '" + id + "'"), 'route was removed: ' + id)
  }
  assert.ok(app.includes('TRON MAINNET'))
  assert.ok(app.includes('OwnerWalletAccess'))
  assert.ok(app.includes('OwnerAccountSecurity'))
  assert.ok(app.includes('SponsorWalletManager'))
})


test('Owner and Sponsor render boundaries never guess whether a Mainnet transaction was submitted', async () => {
  const app = await read('../src/App.jsx')
  assert.ok(app.includes('class OwnerWorkspaceErrorBoundary extends React.Component'))
  assert.ok(app.includes('<OwnerWorkspaceErrorBoundary activePage={activePage} onNavigate={setActivePage}>'))
  assert.match(app, /Check the durable Owner operation ledger and solidified Mainnet receipt before retrying/)
  assert.match(app, /Check the durable Sponsor ledger and solidified Mainnet receipt before retrying/)
  assert.doesNotMatch(app, /No transaction was submitted/)
})
