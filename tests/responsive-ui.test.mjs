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
  assert.match(styles, /@media \\(max-width: 640px\\)/)
  assert.match(styles, /@media \\(max-width: 900px\\)/)
  assert.match(styles, /@media \\(min-width: 1024px\\)/)
  assert.match(styles, /prefers-reduced-motion: reduce/)
  assert.match(styles, /\\.app-workflow-nav button\\[aria-pressed="true"\\]/)
  assert.match(styles, /overflow-x: auto/)
})

test('receiver history uses responsive cards and wraps long chain identifiers', () => {
  assert.match(history, /records\\.map\\(/)
  assert.match(history, /<article[^>]*rounded-lg border/)
  assert.match(history, /break-all text-xs font-mono/)
})
