-- Stage 7B reference migration. NOT applied by this change.
-- The runtime governance API can create these tables when first used; production
-- rollout still requires a separately reviewed migration and trusted allowlists.
-- Original documents remain in an independently operated encrypted private vault.
-- PostgreSQL stores metadata, digests, reviewer signature hashes and audit events.

CREATE TABLE IF NOT EXISTS trc20_token_clone.sponsor_organization_evidence_artifacts (
  id UUID PRIMARY KEY,
  application_id UUID NOT NULL REFERENCES trc20_token_clone.sponsor_organization_applications(id),
  mandate_id UUID NOT NULL REFERENCES trc20_token_clone.sponsor_organization_mandates(id),
  evidence_type TEXT NOT NULL CHECK (evidence_type IN (
    'legal-entity-registration','beneficial-ownership','authorized-representative',
    'sponsor-wallet-control','provider-account-ownership','provider-signer-policy',
    'signed-agreement','source-of-funds','funding-balance','other'
  )),
  storage_provider TEXT NOT NULL CHECK (storage_provider = 'approved-private-document-vault'),
  object_key TEXT NOT NULL CHECK (length(object_key) BETWEEN 1 AND 512 AND object_key !~ '(^/|[.][.]|^https?://)'),
  content_sha256 CHAR(64) NOT NULL CHECK (content_sha256 ~ '^[a-fA-F0-9]{64}$'),
  media_type TEXT NOT NULL CHECK (media_type IN ('application/pdf','image/jpeg','image/png')),
  byte_size BIGINT NOT NULL CHECK (byte_size BETWEEN 1 AND 20971520),
  encrypted_at_rest BOOLEAN NOT NULL CHECK (encrypted_at_rest = TRUE),
  malware_scan_status TEXT NOT NULL DEFAULT 'pending' CHECK (malware_scan_status IN ('pending','clean')),
  vault_version_id TEXT,
  malware_scanner_version TEXT,
  uploaded_by_wallet TEXT NOT NULL CHECK (uploaded_by_wallet ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$'),
  retention_policy_reference TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE trc20_token_clone.sponsor_organization_evidence_artifacts
  ADD COLUMN IF NOT EXISTS vault_version_id TEXT;
ALTER TABLE trc20_token_clone.sponsor_organization_evidence_artifacts
  ADD COLUMN IF NOT EXISTS malware_scanner_version TEXT;
ALTER TABLE trc20_token_clone.sponsor_organization_evidence_artifacts
  DROP CONSTRAINT IF EXISTS sponsor_organization_evidence_artifacts_malware_scan_status_check;
ALTER TABLE trc20_token_clone.sponsor_organization_evidence_artifacts
  ADD CONSTRAINT sponsor_org_evidence_scan_status_check CHECK (malware_scan_status IN ('pending','clean'));

CREATE TABLE IF NOT EXISTS trc20_token_clone.sponsor_organization_malware_scan_attestations (
  id UUID PRIMARY KEY,
  evidence_id UUID NOT NULL UNIQUE REFERENCES trc20_token_clone.sponsor_organization_evidence_artifacts(id),
  content_sha256 CHAR(64) NOT NULL CHECK (content_sha256 ~ '^[a-fA-F0-9]{64}$'),
  scanner_service TEXT NOT NULL CHECK (scanner_service='clamav-instream'),
  scanner_version TEXT NOT NULL,
  scan_status TEXT NOT NULL CHECK (scan_status='clean'),
  scanned_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sponsor_org_evidence_mandate_idx
  ON trc20_token_clone.sponsor_organization_evidence_artifacts(mandate_id, created_at DESC);

CREATE TABLE IF NOT EXISTS trc20_token_clone.sponsor_organization_reviewer_decisions (
  id UUID PRIMARY KEY,
  application_id UUID NOT NULL REFERENCES trc20_token_clone.sponsor_organization_applications(id),
  mandate_id UUID NOT NULL REFERENCES trc20_token_clone.sponsor_organization_mandates(id),
  reviewer_wallet_address TEXT NOT NULL CHECK (reviewer_wallet_address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$'),
  reviewer_role TEXT NOT NULL CHECK (reviewer_role IN ('compliance-reviewer','security-reviewer')),
  evidence_set_digest CHAR(64) NOT NULL CHECK (evidence_set_digest ~ '^[a-fA-F0-9]{64}$'),
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected','needs-more-evidence')),
  independence_attested BOOLEAN NOT NULL CHECK (independence_attested = TRUE),
  conflict_check_passed BOOLEAN NOT NULL CHECK (conflict_check_passed = TRUE),
  reviewer_signature_hash CHAR(64) NOT NULL CHECK (reviewer_signature_hash ~ '^[a-fA-F0-9]{64}$'),
  decision_evidence_reference TEXT NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sponsor_org_reviewer_once_per_digest_idx
  ON trc20_token_clone.sponsor_organization_reviewer_decisions(mandate_id, reviewer_wallet_address, evidence_set_digest);
CREATE INDEX IF NOT EXISTS sponsor_org_reviewer_decisions_subject_idx
  ON trc20_token_clone.sponsor_organization_reviewer_decisions(application_id, mandate_id, decided_at DESC);

CREATE TABLE IF NOT EXISTS trc20_token_clone.sponsor_organization_revocation_events (
  id UUID PRIMARY KEY,
  application_id UUID NOT NULL REFERENCES trc20_token_clone.sponsor_organization_applications(id),
  mandate_id UUID NULL REFERENCES trc20_token_clone.sponsor_organization_mandates(id),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('application','mandate')),
  scope_id UUID NOT NULL,
  actor_wallet_address TEXT NOT NULL CHECK (actor_wallet_address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$'),
  actor_role TEXT NOT NULL CHECK (actor_role IN ('sponsor-representative','security-officer')),
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'sponsor-request','suspected-compromise','authority-withdrawn','provider-account-changed',
    'evidence-invalidated','policy-breach','legal-or-compliance-hold','other'
  )),
  emergency BOOLEAN NOT NULL DEFAULT FALSE,
  actor_signature_hash CHAR(64) NOT NULL CHECK (actor_signature_hash ~ '^[a-fA-F0-9]{64}$'),
  event_reference TEXT NOT NULL,
  effective_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((scope_type='application' AND scope_id=application_id AND mandate_id IS NULL)
      OR (scope_type='mandate' AND mandate_id IS NOT NULL AND scope_id=mandate_id))
);
CREATE INDEX IF NOT EXISTS sponsor_org_revocations_scope_idx
  ON trc20_token_clone.sponsor_organization_revocation_events(scope_type, scope_id, effective_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS sponsor_org_revocation_signature_once_idx
  ON trc20_token_clone.sponsor_organization_revocation_events(actor_signature_hash);
CREATE UNIQUE INDEX IF NOT EXISTS sponsor_org_revocation_reference_once_idx
  ON trc20_token_clone.sponsor_organization_revocation_events(scope_type, scope_id, actor_wallet_address, event_reference);

-- Audit rows are append-only. A correction requires a new row, never UPDATE/DELETE.
CREATE OR REPLACE FUNCTION trc20_token_clone.reject_sponsor_org_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'sponsor organization governance records are append-only';
END;
$$;

DROP TRIGGER IF EXISTS sponsor_org_evidence_immutable
  ON trc20_token_clone.sponsor_organization_evidence_artifacts;
CREATE TRIGGER sponsor_org_evidence_immutable
  BEFORE UPDATE OR DELETE ON trc20_token_clone.sponsor_organization_evidence_artifacts
  FOR EACH ROW EXECUTE FUNCTION trc20_token_clone.reject_sponsor_org_audit_mutation();

DROP TRIGGER IF EXISTS sponsor_org_review_decisions_immutable
  ON trc20_token_clone.sponsor_organization_reviewer_decisions;
CREATE TRIGGER sponsor_org_review_decisions_immutable
  BEFORE UPDATE OR DELETE ON trc20_token_clone.sponsor_organization_reviewer_decisions
  FOR EACH ROW EXECUTE FUNCTION trc20_token_clone.reject_sponsor_org_audit_mutation();

DROP TRIGGER IF EXISTS sponsor_org_revocations_immutable
  ON trc20_token_clone.sponsor_organization_revocation_events;
CREATE TRIGGER sponsor_org_revocations_immutable
  BEFORE UPDATE OR DELETE ON trc20_token_clone.sponsor_organization_revocation_events
  FOR EACH ROW EXECUTE FUNCTION trc20_token_clone.reject_sponsor_org_audit_mutation();
