import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/SponsorWalletManager.jsx', import.meta.url), 'utf8')

test('Sponsor wallet manager defines its TRON address validator before session checks', () => {
  const declaration = source.indexOf("const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/")
  assert.notEqual(declaration, -1, 'ADDRESS_PATTERN must be declared in this module')
  const firstUse = source.indexOf('ADDRESS_PATTERN.test(')
  assert.notEqual(firstUse, -1, 'Owner and Sponsor identity checks must use the validator')
  assert.ok(declaration < firstUse, 'validator declaration must precede every runtime use')
})
