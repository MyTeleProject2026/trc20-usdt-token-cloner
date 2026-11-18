import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const component = await readFile(new URL('../Frontend-Tron-Transfer/src/ResourceSponsorCenter.jsx', import.meta.url), 'utf8')
const app = await readFile(new URL('../Frontend-Tron-Transfer/src/App.jsx', import.meta.url), 'utf8')

test('resource sponsor center reads the existing Mainnet-only readiness endpoint', () => {
  assert.match(component, /\/api\/tron\/resources\/claims\/readiness/)
  assert.match(component, /refresh', '1'/)
  assert.match(component, /credentials: 'omit'/)
})

test('sponsor request explicitly states that no grant or sponsor consent is assumed', () => {
  assert.match(component, /No sponsor consent or funding is assumed/)
  assert.match(component, /provider discovery response is not a grant/i)
  assert.match(component, /No TRX or other payment is authorized/)
})

test('sponsor center never requests private keys or signs sponsor transactions', () => {
  assert.match(component, /No private key, seed phrase, password/)
  assert.match(component, /never requests sponsor credentials, signs transactions/)
  assert.doesNotMatch(component, /privateKey|private_key|seedPhrase|seed_phrase/)
})

test('sponsor center is reachable from owner admin navigation', () => {
  assert.match(app, /id: 'sponsors'/)
  assert.match(app, /<ResourceSponsorCenter wallet={wallet}\/>/)
})
