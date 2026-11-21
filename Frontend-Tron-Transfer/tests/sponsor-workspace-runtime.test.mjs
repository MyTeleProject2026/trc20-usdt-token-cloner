import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/SponsorWalletManager.jsx', import.meta.url), 'utf8')

test('Sponsor resource-derived values are initialized before effects reference them', () => {
  const derived = source.indexOf('const energyTargetValid =')
  const effect = source.indexOf('if (!wallet || !snapshot || !energyTargetValid || !bandwidthTargetValid)')
  assert.notEqual(derived, -1)
  assert.notEqual(effect, -1)
  assert.ok(derived < effect, 'resource validation and deficit values must be initialized before the effect dependency array is evaluated')
  for (const name of ['bandwidthTargetValid', 'ownerEnergyDeficit', 'ownerBandwidthDeficit']) {
    assert.ok(source.indexOf(`const ${name} =`) < effect, `${name} must be initialized before the resource alert effect`)
  }
})

test('Sponsor workspace receives the active route from App', () => {
  assert.match(source, /function SponsorWalletManager\(\{\s*activePage\s*=\s*'sponsor'/)
  for (const id of ['sponsor', 'sponsor-resources', 'sponsor-automation', 'sponsor-activity']) assert.ok(source.includes(`activePage === "${id}" && <section`) || source.includes(`activePage === '${id}' &&`), `${id} must be conditionally mounted only on its own page`)
  assert.ok(!/id="sponsor-(?:overview|resources|automation|activity)"[^>]*hidden=/.test(source), 'inactive Sponsor page sections must not remain mounted with the hidden attribute')
  assert.ok(!source.includes('scrollIntoView'), 'page navigation must not depend on scrolling hidden sections')
})

test('Sponsor workspace pages are isolated and wallet-locked routes have a recovery path', () => {
  for (const id of ['sponsor-overview', 'sponsor-resources', 'sponsor-automation', 'sponsor-activity']) {
    assert.ok(source.includes(`id="${id}"`), `${id} page must exist`)
  }
  assert.match(source, /Sponsor Wallet is locked/)
  assert.match(source, /onNavigate\('sponsor'\)/)
})

test('Sponsor workspace render errors are contained by an application error boundary', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
  assert.match(app, /class SponsorWorkspaceErrorBoundary extends React\.Component/)
  assert.match(app, /<SponsorWorkspaceErrorBoundary activePage=\{activePage\}>/)
  assert.match(app, /Sponsor workspace page failed to render/)
})
