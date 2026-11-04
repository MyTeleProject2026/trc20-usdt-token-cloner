import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const panel = await readFile(new URL('../src/SponsorOrganizationReviewPanel.tsx', import.meta.url), 'utf8')
const wallet = await readFile(new URL('../src/WalletVault.tsx', import.meta.url), 'utf8')
const backend = await readFile(new URL('../server/routes/sponsor-organization-onboarding.mjs', import.meta.url), 'utf8')

test('owner application review requires a locally unlocked Mainnet wallet identity signature', () => {
  assert.match(panel, /new TronWeb\(\{ fullHost: MAINNET_RPC, privateKey: wallet\.privateKey \}/)
  assert.match(panel, /web\.trx\.signMessageV2\(challenge\.message\)/)
  assert.match(panel, /api\/auth\/tron\/challenge/)
  assert.match(panel, /api\/auth\/tron\/verify/)
  assert.match(panel, /network !== 'mainnet'/)
  assert.match(panel, /owner-wallet-not-authorized/)
  assert.match(panel, /wallet: \{ address: string; privateKey: string \} \| null/)
  assert.match(wallet, /<SponsorOrganizationReviewPanel/)
  assert.match(wallet, /privateKey: unlocked\.privateKey/)
  assert.match(panel, /if \(!active \|\| !wallet \|\| wallet\.address !== session\.address \|\| network !== 'mainnet'\)/)
  assert.match(panel, /active\]\)/)
  assert.match(wallet, /active=\{activePanel === 'treasury'\}/)
})

test('owner review screen uses only due-diligence transitions and bounded reference', () => {
  assert.match(panel, /'in-review' \| 'accepted-for-due-diligence' \| 'declined'/)
  assert.match(panel, /Continue due diligence/)
  assert.match(panel, /Mark in review/)
  assert.match(panel, /Decline/)
  assert.match(panel, /8–160 letters/)
  assert.match(backend, /transitionAllowed\(row\.status, status\)/)
  assert.match(backend, /sponsorAgreementAuthorized: false/)
  assert.match(backend, /payoutAuthorized: false/)
  assert.match(backend, /submissionEnabled: false/)
})

test('owner review panel has no payout or transaction-signing action', () => {
  assert.doesNotMatch(panel, /sendRawTransaction|triggerConstantContract|transactionBuilder|signTransaction|broadcast/)
  assert.match(panel, /No approval here authorizes a sponsor/)
})
