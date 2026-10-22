import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
const styles = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')
const history = await readFile(new URL('../src/ReceiverHistory.tsx', import.meta.url), 'utf8')

test('primary navigation stays discoverable and marks the active workflow', () => {
  assert.match(app, /className="app-primary-nav[^"]*"[^>]*role="navigation"[^>]*aria-label="Primary workflow"/)
  for (const tab of ['choose', 'sponsors']) {
    assert.match(app, new RegExp(`setActiveTab\\('${tab}'\\)[\\s\\S]{0,100}aria-current={activeTab === '${tab}' \\? 'page' : undefined}`))
  }
})

test('all tool navigation controls expose their selected state', () => {
  for (const tab of ['deploy', 'interact', 'trx', 'simulation', 'verify', 'contract']) {
    assert.match(app, new RegExp(`setActiveTab\\('${tab}'\\)[\\s\\S]{0,100}aria-pressed={activeTab === '${tab}'}`))
    assert.match(app, new RegExp(`aria-current={activeTab === '${tab}' \\? 'page' : undefined}`))
  }
  assert.match(app, /aria-label="TRON network selection"/)
  assert.match(app, /aria-pressed={network === 'shasta'}/)
  assert.match(app, /aria-pressed={network === 'mainnet'}/)
})

test('console theme includes separate phone, tablet, desktop, and reduced-motion rules', () => {
  assert.match(styles, /@media \(max-width: 640px\)/)
  assert.match(styles, /@media \(max-width: 900px\)/)
  assert.match(styles, /@media \(min-width: 1024px\)/)
  assert.match(styles, /prefers-reduced-motion: reduce/)
  assert.match(styles, /\.app-workflow-nav button\[aria-pressed="true"\]/)
  assert.match(styles, /overflow-x: auto/)
})

test('receiver history uses responsive cards and wraps long chain identifiers', () => {
  assert.match(history, /records\.map\(/)
  assert.match(history, /<article[^>]*rounded-lg border/)
  assert.match(history, /break-all text-xs font-mono/)
})

test('Copy Code copies the same Solidity source that the viewer renders', () => {
  assert.ok(app.includes('const independentTokenSource = `// SPDX-License-Identifier: MIT'))
  assert.ok(app.includes('copyToClipboard(independentTokenSource, \'contract_source\')'))
  assert.ok(app.includes('{independentTokenSource}'))
  assert.ok(!app.includes('copyToClipboard(\'contract_source\', \'contract_source\')'))
})

test('copy actions report success only after clipboard writes and handle browser denial', () => {
  assert.ok(app.includes('await navigator.clipboard.writeText(text)'))
  assert.ok(app.includes('Clipboard access was blocked.'))
  assert.ok(app.includes('setCopyFeedback({ type: \'error\', text: \'Nothing to copy yet.\' })'))
  assert.ok(app.includes('onClick={() => setCopyFeedback(null)}'))
})

test('receiver history uses an accessible desktop table and mobile cards', () => {
  assert.ok(history.includes('<table aria-label="Incoming TRC-20 receiver history">'))
  assert.ok(history.includes('<th scope="col">Token / amount</th>'))
  assert.ok(history.includes('<th scope="col">Verification</th>'))
  assert.ok(history.includes('receiver-history-table-wrap'))
  assert.ok(history.includes('receiver-history-mobile-cards'))
})

test('receiver history distinguishes multiple transfer events in the same transaction', () => {
  assert.ok(history.includes('record.eventIndex ?? index'))
})
test('sponsor status refreshes after wallet connect and matches selected network', async () => {
  const sponsorship = await readFile(new URL('../src/SponsorshipStatus.tsx', import.meta.url), 'utf8')
  const sponsorPages = await readFile(new URL('../src/SponsorProviderPages.tsx', import.meta.url), 'utf8')
  assert.ok(app.includes('const [sponsorRefreshKey, setSponsorRefreshKey] = useState(0)'))
  assert.ok(app.includes('setSponsorRefreshKey((current) => current + 1)'))
  assert.ok(app.includes('<SponsorshipStatus network={network} refreshKey={sponsorRefreshKey} />'))
  assert.ok(app.includes('<SponsorProviderPage network={network} refreshKey={sponsorRefreshKey} />'))
  assert.ok(sponsorship.includes('}, [network, refreshKey])'))
  assert.ok(sponsorship.includes('status?.network === network'))
  assert.ok(sponsorship.includes("network !== 'mainnet' || status?.mainnetEnabled"))
  assert.ok(sponsorPages.includes('}, [network, refreshKey])'))
  assert.ok(sponsorPages.includes('status?.network === network'))
})
