import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const workflow = await readFile(new URL('../src/WorkflowApp.tsx', import.meta.url), 'utf8')
const authRoute = await readFile(new URL('../server/routes/tron-wallet-auth.mjs', import.meta.url), 'utf8')

test('wallet sign-in is reachable from the top bar and still uses a signed ownership challenge', () => {
  assert.match(workflow, /className="studio-button studio-button--secondary studio-topbar-auth"/)
  assert.match(workflow, /onClick=\{\(\) => void connectTronLink\(\)\}/)
  assert.match(workflow, /const signInWithWallet = async/)
  assert.match(workflow, /tronWeb\.trx\.signMessageV2\(challenge\.message\)/)
  assert.match(workflow, /\/api\/auth\/tron\/challenge/)
  assert.match(workflow, /\/api\/auth\/tron\/verify/)
  assert.match(authRoute, /scope: 'wallet-identity-only'/)
  assert.match(authRoute, /canSubmitSponsoredTransfer: false/)
})

test('token contract entry is stored per testnet and backend allowlisting remains authoritative', () => {
  assert.match(workflow, /TOKEN_CONTRACTS_STORAGE_KEY/)
  assert.match(workflow, /function loadSavedTokenContract\(network: NetworkId\)/)
  assert.match(workflow, /function saveTokenContractForNetwork\(network: NetworkId, contract: string\)/)
  assert.match(workflow, /setTokenContract\(loadSavedTokenContract\(network\)\)/)
  assert.match(workflow, /saveTokenContractForNetwork\(network, value\)/)
  assert.match(workflow, /Sponsored transfer use still requires the backend allowlist for this network/)
})

test('wallet login never requests or transmits a private key', () => {
  assert.doesNotMatch(workflow, /privateKeyInput|private-key-input|seedPhraseInput|recoveryPhraseInput/i)
  assert.doesNotMatch(authRoute, /req\.body\.privateKey|body\.privateKey|privateKey:/i)
})
