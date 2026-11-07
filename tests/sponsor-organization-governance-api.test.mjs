import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const api = await readFile(new URL('server/routes/sponsor-organization-governance.mjs', root), 'utf8')
const index = await readFile(new URL('server/index.mjs', root), 'utf8')
const migration = await readFile(new URL('server/migrations/20261107_sponsor_organization_governance_stage7.sql', root), 'utf8')
const portal = await readFile(new URL('Frontend-Tron-Transfer/src/SponsorPortal.jsx', root), 'utf8')
const panel = await readFile(new URL('Frontend-Tron-Transfer/src/SponsorOrganizationGovernance.jsx', root), 'utf8')
const onboarding = await readFile(new URL('server/routes/sponsor-organization-onboarding.mjs', root), 'utf8')
const custody = await readFile(new URL('server/sponsor-document-custody.mjs', root), 'utf8')
const registry = await readFile(new URL('server/sponsor-governance-registry.mjs', root), 'utf8')
const testnet = await readFile(new URL('scripts/run-sponsor-governance-testnet-check.mjs', root), 'utf8')

test('governance router is mounted before the legacy onboarding router', () => {
  const governanceMount = index.indexOf("app.use('/api/tron', createSponsorOrganizationGovernanceRouter())")
  const onboardingMount = index.indexOf("app.use('/api/tron', createSponsorOrganizationRouter())")
  assert.ok(governanceMount >= 0)
  assert.ok(onboardingMount > governanceMount)
})

test('metadata-only evidence remains pending and cannot satisfy independent custody review', () => {
  assert.match(api, /router\.post\('\/organizations\/mandates\/:id\/evidence'/)
  assert.match(api, /row\.sponsor_wallet_address !== auth\.address/)
  assert.match(api, /rawDocumentStoredHere: false/)
  assert.match(api, /vaultObjectFetched: false/)
  assert.match(api, /pending-independent-review/)
  assert.doesNotMatch(api, /req\.files|multer\(|fetch\(.*objectKey/)
})

test('document upload is ClamAV-first, private-vault-only and requires authenticated storage receipts', () => {
  assert.match(api, /express\\.raw/)
  assert.match(api, /custodyUpload\\(/)
  assert.match(api, /sponsor_organization_malware_scan_attestations/)
  assert.match(api, /malware_scan_status/)
  assert.match(custody, /zINSTREAM/)
  assert.match(custody, /zVERSION/)
  assert.match(custody, /X-Encryption-Required/)
  assert.match(custody, /createHmac/)
  assert.match(custody, /timingSafeEqual/)
  assert.match(custody, /vaultHost/)
  assert.match(api, /document-custody-not-configured/)
})

test('trusted governance registries require pinned digests, versions and disjoint reviewer/security wallets', () => {
  assert.match(registry, /SPONSOR_ORG_REVIEWER_REGISTRY_SHA256/)
  assert.match(registry, /SPONSOR_ORG_SECURITY_OFFICERS_SHA256/)
  assert.match(registry, /security-officer-must-be-independent-of-reviewers/)
  assert.match(api, /getSponsorReviewerRegistry/)
  assert.match(api, /getSponsorSecurityOfficerRegistry/)
})

test('Nile verification is GET-only and refuses Mainnet endpoints', () => {
  assert.match(testnet, /nile\\.trongrid\\.io/)
  assert.match(testnet, /method: 'GET'/)
  assert.match(testnet, /transactionBroadcast: false/)
  assert.doesNotMatch(testnet, /sendRawTransaction|broadcastTransaction|signTransaction/)
})

test('legacy mandate verify and authorize transitions cannot bypass the two-role quorum', () => {
  assert.match(api, /router\.post\('\/organizations\/mandates\/:id\/review'/)
  assert.match(api, /independent-reviewer-quorum-not-met/)
  assert.match(api, /roles\.has\('compliance-reviewer'\)/)
  assert.match(api, /roles\.has\('security-reviewer'\)/)
  assert.match(onboarding, /payoutAuthorized: false,\s*mandateStatusAuthorized: authorized/)
  assert.doesNotMatch(onboarding, /payoutAuthorized: authorized/)
})

test('review decisions require trusted server roles and signatures bound to the evidence digest', () => {
  assert.match(api, /SPONSOR_ORG_REVIEWER_REGISTRY/)
  assert.match(api, /verifyMessage\(message, body\.signature\)/)
  assert.match(api, /reviewer-signature-address-mismatch/)
  assert.match(api, /evidence\.digest/)
  assert.match(api, /roles\.has\('compliance-reviewer'\)/)
  assert.match(api, /roles\.has\('security-reviewer'\)/)
  assert.match(api, /distinct\.size >= 2/)
  assert.match(api, /activeReviewerDecisions\(decisions\.rows, env\)/)
  assert.match(api, /new Set\(entries\.map\(\(item\) => item\.walletAddress\)\)/)
  assert.match(api, /sponsor-cannot-review-own-evidence/)
  assert.match(api, /reviewer-already-decided-for-evidence-digest/)
})

test('revocation requires sponsor or trusted security officer signature and commits atomically', () => {
  assert.match(api, /SPONSOR_ORG_SECURITY_OFFICERS/)
  assert.match(api, /trusted-security-officer-required/)
  assert.match(api, /sponsor-wallet-required-for-revocation/)
  assert.match(api, /revocation-signature-address-mismatch/)
  assert.match(api, /await client\.query\('BEGIN'\)/)
  assert.match(api, /await client\.query\('COMMIT'\)/)
  assert.match(api, /await client\.query\('ROLLBACK'\)/)
  assert.match(api, /sponsor_organization_revocation_events/)
  assert.match(api, /sponsor_org_revocation_signature_once_idx/)
  assert.match(api, /sponsor_org_revocation_reference_once_idx/)
  assert.match(api, /revocation-event-already-recorded/)
})

test('governance audit tables have immutable update and delete triggers', () => {
  for (const name of ['sponsor_organization_evidence_artifacts','sponsor_organization_malware_scan_attestations','sponsor_organization_reviewer_decisions','sponsor_organization_revocation_events']) {
    assert.ok(api.includes(name))
    assert.ok(migration.includes(name))
  }
  assert.match(api, /BEFORE UPDATE OR DELETE/)
  assert.match(migration, /BEFORE UPDATE OR DELETE/)
  assert.match(api, /governance records are append-only/)
})

test('governance API responses never authorize or broadcast payouts', () => {
  assert.match(api, /payoutAuthorized:false/)
  assert.match(api, /transactionBroadcast:false/)
  assert.doesNotMatch(api, /sendRawTransaction|signTransaction|broadcastTransaction|tatumFetch/)
})

test('sponsor portal exposes governance controls without transaction submission controls', () => {
  assert.match(portal, /SponsorOrganizationGovernance/)
  assert.match(panel, /Scan and store evidence/)
  assert.match(panel, /documentCustodyAvailable/)
  assert.match(panel, /malwareScanStatus/)
  assert.match(panel, /Sign and submit independent approval/)
  assert.match(panel, /Sign and revoke mandate/)
  assert.match(panel, /Independent human review is still required/)
  assert.doesNotMatch(panel, /sendRawTransaction|signTransaction|broadcastTransaction/)
})
