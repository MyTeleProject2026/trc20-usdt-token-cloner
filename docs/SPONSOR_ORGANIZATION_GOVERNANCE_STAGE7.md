# Stage 7B — organizational evidence, independent review and revocation

## Implemented in the feature branch

- A governance router is mounted before the existing organization-onboarding router at the same `/api/tron` prefix. This makes the signed Stage 7B revocation endpoint handle mandate revocation instead of the earlier unsigned status-only endpoint.
- Evidence metadata can be recorded against an existing sponsor mandate. PostgreSQL stores only a vault object key, file digest, MIME type, bounded size, encryption declaration, uploader wallet and retention-policy reference. It does not accept document bytes or fetch the referenced object.
- Reviewer decisions are signed with TRON message signatures. The server recovers the signing wallet and checks that the wallet and role are in a trusted server-side reviewer registry.
- A current evidence-set digest is recomputed from sorted artifact IDs and SHA-256 values. Each reviewer signature binds the application, mandate, exact digest, decision, reviewer wallet and role, independence/conflict attestations, reference and timestamp.
- Two distinct reviewers are required, including both the compliance-reviewer and security-reviewer roles. The sponsor wallet is excluded. A reviewer can submit only one decision per mandate and evidence digest. Revocation signature hashes are unique, preventing replay of the same signed revocation.
- Sponsor revocation and trusted security-officer emergency revocation are signed and appended to an immutable event table. The append and associated mandate/application status changes are performed in one database transaction.
- The sponsor portal now contains a governance panel for metadata submission, reviewer approval and signed mandate revocation. It does not expose any transaction signing or payout action.

## API routes

- `POST /api/tron/organizations/mandates/:id/evidence`
- `GET /api/tron/organizations/mandates/:id/governance`
- `GET /api/tron/organizations/governance/config`
- `POST /api/tron/organizations/mandates/:id/reviews`
- `POST /api/tron/organizations/mandates/:id/revoke`
- `POST /api/tron/organizations/applications/:id/revoke`

All routes require a valid TRON Mainnet wallet-auth session and an allowlisted HTTPS origin. Review and revocation mutations additionally require a cryptographically verified wallet signature over the exact server-defined message.

## Trusted server configuration still required

The API fails closed when these allowlists are absent or malformed:

- `SPONSOR_ORG_REVIEWER_REGISTRY`: JSON array of active `{ "walletAddress": "...", "role": "compliance-reviewer" | "security-reviewer", "active": true }` entries.
- `SPONSOR_ORG_SECURITY_OFFICERS`: JSON array of active `{ "walletAddress": "...", "active": true }` entries.

These values must be provisioned by the organization through an approved, controlled secrets/configuration process. Do not put reviewer keys, seed phrases or private keys in these variables. Only public TRON addresses and roles belong here. No reviewer identities are provisioned by this commit.

## Evidence-custody limitation

This is a metadata API, **not a document-vault integration**. The service does not upload, download, inspect, encrypt or malware-scan the referenced object, and cannot prove the object exists. The API labels the submitted metadata as pending independent review. Reviewers must inspect the source object in the approved vault and attest to that inspection before signing. A hash proves file identity, not truth, legal validity, KYB completion or lawful source of funds.

## Persistence and migration

The governance router creates the metadata, reviewer-decision and revocation tables and append-only triggers on the first persistence API request, provided the existing organization application and mandate tables are already present. The read-only governance-config endpoint does not create database tables. The SQL migration at `server/migrations/20261107_sponsor_organization_governance_stage7.sql` mirrors that schema for separately managed migration workflows. The migration has **not** been applied to Render or any live database by this work.

Evidence metadata, reviewer decisions and revocation events reject UPDATE and DELETE. Corrections require new records. A new evidence digest invalidates approvals against an older digest.

## Payout and deployment boundary

- Every Stage 7B response explicitly reports `payoutAuthorized: false`.
- The governance quorum is not a payout authorization and is not connected to any signer, provider payout adapter, transaction preparation, broadcast or exchange-credit path.
- This work does not enable real-value payout execution, change provider configuration, apply a production database migration, deploy Render services, or transfer funds.
- The existing separate sponsor-direct payout capability remains governed by its own authorization and execution controls; Stage 7B does not silently change that system.

## Verification status

Regression tests were added for route mounting/order, signature binding, trusted reviewer roles, quorum requirements, append-only storage, atomic revocation and frontend safety assertions. GitHub Actions results must be checked on the latest branch head before describing the implementation as verified. No live database, vault or reviewer-registry verification is claimed.
