import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const entry = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8')
const gate = await readFile(new URL('../src/AuthGate.tsx', import.meta.url), 'utf8')
const workflow = await readFile(new URL('../src/WorkflowApp.tsx', import.meta.url), 'utf8')
const signerConsole = await readFile(new URL('../src/SponsorSignerConsole.tsx', import.meta.url), 'utf8')

test('both the main workflow and sponsor operator route are guarded by the same verified login', () => {
  assert.match(entry, /import AuthGate from '\.\/AuthGate\.tsx'/)
  assert.match(entry, /<AuthGate>[\s\S]*isSponsorOperator \? <SponsorSignerConsole \/> : <App \/>[\s\S]*<\/AuthGate>/)
  assert.match(gate, /\/api\/auth\/tron\/challenge/)
  assert.match(gate, /\/api\/auth\/tron\/verify/)
  assert.match(gate, /\/api\/auth\/tron\/session/)
  assert.match(gate, /tronWeb\.trx\.signMessageV2\(challenge\.message\)/)
  assert.match(gate, /window\.sessionStorage\.setItem\(SESSION_KEY, verified\.sessionToken\)/)
  assert.ok(gate.includes("replace(/\\\\/+$/, '')"), 'API base URL trimming regex must be valid')
})

test('operator signer account changes remain separate from the signed-in app identity', () => {
  assert.match(signerConsole, /onAccountsChanged/)
  assert.match(signerConsole, /setWalletNeedsReconnect\(!assetRoleActive\)/)
  assert.match(signerConsole, /setFeeWalletNeedsReconnect\(!feeRoleActive\)/)
  assert.match(gate, /operatorRoute &&/)
  assert.match(gate, /studio-auth-session-strip/)
  assert.match(workflow, /tron-token-studio:logout/)
  assert.match(gate, /tron-token-studio:logout/)
  assert.match(workflow, /tron-token-studio:network-change/)
  assert.match(gate, /tron-token-studio:network-change/)
  assert.match(gate, /setNetwork\(requested\)/)
})

test('the authentication gate never collects or accepts a private key', () => {
  assert.match(gate, /No private keys or recovery phrases/)
  assert.doesNotMatch(gate, /privateKeyInput|private-key-input|seedPhraseInput|recoveryPhraseInput/i)
  assert.doesNotMatch(gate, /req\.body\.privateKey|body\.privateKey|privateKey:/i)
})
