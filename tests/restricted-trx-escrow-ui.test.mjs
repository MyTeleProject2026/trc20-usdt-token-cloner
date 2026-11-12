import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const component = await readFile(new URL('../Frontend-Tron-Transfer/src/RestrictedTRXEscrow.jsx', import.meta.url), 'utf8')
const app = await readFile(new URL('../Frontend-Tron-Transfer/src/App.jsx', import.meta.url), 'utf8')

test('restricted escrow viewer uses the owner session storage key used by this frontend', () => {
  assert.match(app, /OWNER_SESSION_KEY\s*=\s*'tron-transfer:owner-session:v1'/)
  assert.match(component, /sessionStorage\.getItem\('tron-transfer:owner-session:v1'\)/)
  assert.doesNotMatch(component, /tron-token-studio:owner-session:v1/)
})

test('Bitpie normal balance is labelled spendable and separate from contract escrow', () => {
  assert.match(component, /Ordinary on-chain wallet balance \(not restricted\)/)
  assert.match(component, /is spendable by the wallet owner; it is not an escrow credit/)
  assert.match(component, /This is not a Bitpie wallet deposit or spendable Bitpie balance/)
})

test('escrow viewer only marks a position verified after owner-authenticated server response', () => {
  assert.match(component, /Authorization:\s*'Bearer '\s*\+\s*token/)
  assert.match(component, /payload\.verified !== true/)
  assert.match(component, /payload\.result\?\.verified !== true/)
  assert.match(component, /No restricted balance is recognized/)
})
