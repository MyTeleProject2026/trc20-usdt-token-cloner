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
const custody = await readFile(new URL('server/sponsor-document-custody-v2.mjs', root), 'utf8')
const receiptVerifier = await readFile(new URL('server/sponsor-vault-receipt-v2.mjs', root), 'utf8')
const custodyRoute = await readFile(new URL('server/routes/sponsor-organization-governance.mjs', root), 'utf8')
const trustRegistry = await readFile(new URL('server/sponsor-vault-trust-registry.mjs', root), 'utf8')
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

test('evidence upload requires an independently signed scan attestation and Ed25519 V2 vault receipt', () => {
  assert.match(api, /express\.raw/)
  assert.match(api, /custodyUpload = scanAndStoreEvidenceV2/)
  assert.match(api, /getDocumentCustodyV2Config/)
  assert.match(api, /vault_receipt_json/)
  assert.match(api, /attestation_json/)
  assert.match(api, /vaultReceiptV2Verified/)
  assert.match(api, /verifyMalwareScanAttestation/)
  assert.match(api, /persistedScanMatches/)
  assert.match(api, /denormalizedReceiptMatches/)
  assert.match(api, /attestation_key_id/)
  assert.match(api, /new Date\(stored.scanResult.scannedAt\)/)
  assert.match(api, /scanner_service TEXT NOT NULL CHECK \(scanner_service='independent-signed-attestation'\)/)
  assert.match(custody, /\/v1\/scans/)
  assert.match(custody, /X-Scan-Attestation/)
  assert.match(custody, /verifyMalwareScanAttestation/)
  assert.match(custody, /verifyPrivateVaultReceiptV2/)
  assert.match(receiptVerifier, /Ed25519/)
  assert.match(receiptVerifier, /SSE-KMS/)
  assert.match(receiptVerifier, /minimumRetentionMs/)
  assert.match(trustRegistry, /SPONSOR_ORG_VAULT_RECEIPT_KEYS_SHA256/)
  assert.match(trustRegistry, /SPONSOR_ORG_SCANNER_ATTESTATION_KEYS_SHA256/)
  assert.match(custodyRoute, /evidence-custody-and-malware-scan-required/)
  assert.match(api, /document-custody-v2-not-configured/)
})

test('trusted governance registries require pinned digests, versions and disjoint reviewer/security wallets', () => {
  assert.match(registry, /SPONSOR_ORG_REVIEWER_REGISTRY_SHA256/)
  assert.match(registry, /SPONSOR_ORG_SECURITY_OFFICERS_SHA256/)
  assert.match(registry, /security-officer-must-be-independent-of-reviewers/)
  assert.match(api, /getSponsorReviewerRegistry/)
  assert.match(api, /getSponsorSecurityOfficerRegistry/)
})

test('Nile verification is GET-only and refuses Mainnet endpoints', () => {
  assert.match(testnet, /nile\.trongrid\.io/)
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
  assert.match(registry, /SPONSOR_ORG_REVIEWER_REGISTRY/)
  assert.match(api, /verifyMessage\(message, body\.signature\)/)
  assert.match(api, /reviewer-signature-address-mismatch/)
  assert.match(api, /evidence\.digest/)
  assert.match(api, /roles\.has\('compliance-reviewer'\)/)
  assert.match(api, /roles\.has\('security-reviewer'\)/)
  assert.match(api, /distinct\.size >= 2/)
  assert.match(api, /activeReviewerDecisions\(decisions\.rows, env\)/)
  assert.match(registry, /new Set\(entries\.map\(\(entry\) => entry\.walletAddress\)\)/)
  assert.match(api, /sponsor-cannot-review-own-evidence/)
  assert.match(api, /reviewer-already-decided-for-evidence-digest/)
})

test('revocation requires sponsor or trusted security officer signature and commits atomically', () => {
  assert.match(registry, /SPONSOR_ORG_SECURITY_OFFICERS/)
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


test('Mainnet signing and broadcast paths remain hard-disabled in this feature build', async () => {
  const sponsorDirect = await readFile(new URL('server/routes/sponsor-direct-payouts.mjs', root), 'utf8')
  const ownerDirect = await readFile(new URL('server/routes/tron-owner-withdrawals.mjs', root), 'utf8')
  const nativeTron = await readFile(new URL('server/routes/native-tron.mjs', root), 'utf8')
  const treasury = await readFile(new URL('server/routes/treasury-withdrawals.mjs', root), 'utf8')
  assert.match(sponsorDirect, /const REAL_SPONSOR_DIRECT_BROADCAST_DISABLED = true/)
  assert.match(sponsorDirect, /sponsor-direct-mainnet-broadcast-disabled-in-this-build/)
  assert.match(sponsorDirect, /wallet\/broadcasttransaction/)
  assert.match(sponsorDirect, /payoutExecution: REAL_SPONSOR_DIRECT_BROADCAST_DISABLED \? 'disabled-in-this-build'/)
  assert.match(ownerDirect, /const REAL_OWNER_DIRECT_MAINNET_BROADCAST_DISABLED = true/)
  assert.match(ownerDirect, /owner-direct-mainnet-broadcast-disabled-in-this-build/)
  assert.match(nativeTron, /SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED !== 'true'/)
  assert.match(nativeTron, /!\['shasta', 'nile'\]\.includes\(transfer\.network\)/)
  assert.match(treasury, /const REAL_VALUE_PAYOUT_EXECUTION_DISABLED = true/)
  assert.match(treasury, /error: 'real-value-payout-execution-disabled-in-this-build'/)
  assert.match(treasury, /withdrawalsEnabled: executionEnabled/)
  assert.match(api, /payoutAuthorized:false/)
  assert.doesNotMatch(api, /wallet\/broadcasttransaction|sendRawTransaction/)
})
