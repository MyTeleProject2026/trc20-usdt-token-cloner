import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const portal = await readFile(new URL('../src/SponsorOrganizationPortal.tsx', import.meta.url), 'utf8')
const entry = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8')
const backend = await readFile(new URL('../server/routes/sponsor-organization-onboarding.mjs', import.meta.url), 'utf8')
const styles = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')

test('public sponsor portal uses the existing Mainnet wallet challenge and signs identity only', () => {
  assert.match(entry, /route === '#\/sponsor-onboarding'/)
  assert.match(entry, /<SponsorOrganizationPortal \/>/)
  assert.match(portal, /eth_requestAccounts/)
  assert.match(portal, /tron_requestAccounts/)
  assert.match(portal, /api\/auth\/tron\/challenge/)
  assert.match(portal, /api\/auth\/tron\/verify/)
  assert.match(portal, /signMessageV2\(challenge\.message\)/)
  assert.match(portal, /checkMainnet\(tronWeb\)/)
  assert.match(portal, /sessionStorage\.setItem\(SESSION_KEY/)
  assert.match(portal, /accountsChanged/)
  assert.match(portal, /chainChanged/)
  assert.doesNotMatch(portal, /privateKey|seedPhrase|recoveryPhrase|sendRawTransaction|sign\(transaction/i)
})

test('sponsor application signs the exact declaration fields before submission', () => {
  assert.match(portal, /ATTESTATION_VERSION = 'sponsor-organization-onboarding-2026-11-04-v1'/)
  assert.match(portal, /buildSponsorApplicationMessage\(/)
  assert.match(portal, /signMessageV2\(applicationMessage\)/)
  assert.match(portal, /applicationSignature,/)
  assert.match(portal, /applicationSignatureStoredAsHashOnly/)
  assert.match(backend, /Trx\.verifyMessageV2\(message, signature\)/)
  assert.match(backend, /applicationSignatureHash = digest\(applicationSignature\)/)
  assert.match(backend, /applicationSignatureHash/)
  assert.match(backend, /applicationSignatureStoredAsHashOnly: true/)
  assert.match(portal, /This is not a transaction or permission to spend funds/)
  assert.doesNotMatch(portal, /sendRawTransaction|transactionBuilder|signTransaction/i)
})

test('sponsor application submits only the allowlisted organization fields', () => {
  assert.match(portal, /apiJson\('\/api\/tron\/sponsorship\/organizations'/)
  assert.match(portal, /authorityToRepresentOrganization: authority/)
  assert.match(portal, /controlsSponsorWallet: walletControl/)
  assert.match(portal, /lawfulSourceOfFunds: lawfulFunds/)
  assert.match(portal, /acceptsSponsorTerms: terms/)
  assert.match(portal, /privacyConsent: privacy/)
  assert.match(portal, /sponsorReference/)
  assert.match(portal, /application\.status/)
  assert.match(backend, /const allowed = new Set\(\[/)
  assert.match(backend, /Object\.keys\(body\)\.some/)
  assert.match(backend, /sponsorWalletAddress: auth\.address/)
  assert.match(backend, /payoutAuthorized: false/)
  assert.match(backend, /submissionEnabled: false/)
})

test('responsive portal stylesheet and existing owner dashboard share route without disabling owner gate', () => {
  assert.match(portal, /EXTERNAL SPONSOR PORTAL/)
  assert.match(portal, /application is not funding/)
  assert.match(styles, /\.sponsor-onboarding-screen/)
  assert.match(styles, /@media \(max-width: 640px\)/)
  assert.match(entry, /<AuthGate>\{page\}<\/AuthGate>/)
})
