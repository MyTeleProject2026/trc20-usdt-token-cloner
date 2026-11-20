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
  assert.match(source, /\)\[activePage\]/)
})
