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

test('Bitpie beneficiary balance and on-chain permission status are displayed separately from contract escrow', () => {
  assert.match(component, /Native TRX balance at beneficiary address/)
  assert.match(component, /The previously supplied address did not pass the Base58Check validation/)
  assert.match(component, /Not configured — confirm address in Bitpie first/)
  assert.match(component, /whether one key can spend it depends on the on-chain permission thresholds below/)
  assert.match(component, /On-chain multisignature restriction detected/)
  assert.match(component, /A single signer may be able to move funds/)
  assert.match(component, /single-key value authority:/)
  assert.match(component, /BITPIE MULTISIGNATURE ROUTE/)
  assert.match(component, /10142742328591-Bitpie-Multisignature-Usage-Tutorial/)
  assert.match(component, /Confirm native TRX support in your current Bitpie app first/)
  assert.match(component, /This is not a Bitpie wallet deposit or spendable Bitpie balance/)
})

test('escrow viewer only marks a position verified after owner-authenticated server response', () => {
  assert.match(component, /Authorization:\s*'Bearer '\s*\+\s*token/)
  assert.match(component, /payload\.verified !== true/)
  assert.match(component, /payload\.result\?\.verified !== true/)
  assert.match(component, /No restricted balance is recognized/)
})


test('native TRX readiness panel uses the owner-authenticated TRX-specific endpoint', () => {
  assert.match(component, /\/api\/tron-transfer\/native-trx-escrow-provider-readiness/)
  assert.match(component, /Authorization:\s*'Bearer '\s*\+\s*token/)
  assert.match(component, /providerApiConnected/)
  assert.match(component, /availablePrincipalSun/)
  assert.match(component, /Outstanding requirements:/)
  assert.match(component, /Live funding:/)
  assert.doesNotMatch(component, /\/api\/restricted-trx\/provider-readiness/)
})
