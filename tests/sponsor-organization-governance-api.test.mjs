import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const api = await readFile(new URL('server/routes/sponsor-organization-governance.mjs', root), 'utf8')
const index = await readFile(new URL('server/index.mjs', root), 'utf8')
const migration = await readFile(new URL('server/migrations/20261107_sponsor_organization_governance_stage7.sql', root), 'utf8')
const portal = await readFile(new URL('Frontend-Tron-Transfer/src/SponsorPortal.jsx', root), 'utf8')
const panel = await readFile(new URL('Frontend-Tron-Transfer/src/SponsorOrganizationGovernance.jsx', root), 'utf8')

test('governance router is mounted before the legacy onboarding router', () => {
  const governanceMount = index.indexOf("app.use('/api/tron', createSponsorOrganizationGovernanceRouter())")
  const onboardingMount = index.indexOf("app.use('/api/tron', createSponsorOrganizationRouter())")
  assert.ok(governanceMount >= 0)
  assert.ok(onboardingMount > governanceMount)
})

test('evidence metadata API is sponsor-bound and does not upload or fetch documents', () => {
  assert.match(api, /router\.post\('\/organizations\/mandates\/:id\/evidence'/)
  assert.match(api, /row\.sponsor_wallet_address !== auth\.address/)
  assert.match(api, /rawDocumentStoredHere: false/)
  assert.match(api, /vaultObjectFetched: false/)
  assert.match(api, /pending-independent-review/)
  assert.doesNotMatch(api, /req\.files|multer\(|fetch\(.*objectKey/)
})

test('review decisions require trusted server roles and signatures bound to the evidence digest', () => {
  assert.match(api, /SPONSOR_ORG_REVIEWER_REGISTRY/)
  assert.match(api, /verifyMessage\(message, body\.signature\)/)
  assert.match(api, /reviewer-signature-address-mismatch/)
  assert.match(api, /evidence\.digest/)
  assert.match(api, /roles\.has\('compliance-reviewer'\)/)
  assert.match(api, /roles\.has\('security-reviewer'\)/)
  assert.match(api, /distinct\.size >= 2/)
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
})

test('governance audit tables have immutable update and delete triggers', () => {
  for (const name of ['sponsor_organization_evidence_artifacts','sponsor_organization_reviewer_decisions','sponsor_organization_revocation_events']) {
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
  assert.match(panel, /Record evidence metadata/)
  assert.match(panel, /Sign and submit independent approval/)
  assert.match(panel, /Sign and revoke mandate/)
  assert.match(panel, /pending independent review/)
  assert.doesNotMatch(panel, /sendRawTransaction|signTransaction|broadcastTransaction/)
})
