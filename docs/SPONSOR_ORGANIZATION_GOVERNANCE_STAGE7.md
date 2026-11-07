# Stage 7 — evidence custody, independent review and emergency revocation

## Scope and status

Stage 7 adds a governance contract, regression tests and a reference PostgreSQL migration. The migration is **not applied**, the new module is **not mounted**, no evidence object is uploaded, and no reviewer allowlist is configured by this change. This is not a production approval workflow.

Real payouts remain disabled. Every evaluator returns `payoutAuthorized: false`; no signer, provider, transaction preparation, broadcast or exchange-credit path is called.

## Evidence custody model

- Keep original identity, ownership, authority, agreement and funding documents in an approved private document vault with encryption at rest and access logging.
- Store only metadata in PostgreSQL: application/mandate binding, evidence type, private object key, SHA-256 digest, MIME type, bounded size, malware scan state, uploader wallet and retention-policy reference.
- Never store public document URLs, raw identity documents in ordinary application rows, seed phrases, private keys, API credentials, session tokens or provider signing material.
- Verify document integrity against the digest and independently inspect the underlying source. A digest proves file identity, not truth, legal validity or KYB completion.
- Evidence metadata, reviewer decisions and revocation events are append-only in the reference migration. Corrections are new events, not edits to history.

## Independent reviewer approval

- Reviewer identities and roles must come from a trusted server-side allowlist, not request fields.
- The evaluator requires at least two distinct active reviewers (compliance and/or security roles), neither the sponsor nor the application submitter.
- Each approval is bound to the exact application, optional mandate, evidence-set digest and a verified reviewer signature.
- Reviewers must attest independence and pass a conflict check. An evidence reference alone is not proof of review.
- Reviewer decisions are not provider KYB approval and do not create signing authority.

## Emergency revocation

- A sponsor representative can request revocation; an independent reviewer or security officer can record an emergency hold where compromise, authority withdrawal, invalid evidence, provider-account change or a compliance hold is suspected.
- Events are signed, timestamped, append-only and scoped either to one mandate or the entire organization application.
- An application-scoped revocation invalidates every mandate under that application. A mandate-scoped revocation invalidates only that mandate.
- Revocation is monotonic for this stage: no event can be deleted or silently reversed. Reinstatement, if ever designed, must be a new reviewed workflow and must not erase the revocation history.
- Any future payout consumer must check current application status, mandate status, all applicable revocation events and emergency holds immediately before any approval/signing step. Cache-only checks are not sufficient.

## Reference database migration

`server/migrations/20261107_sponsor_organization_governance_stage7.sql` defines metadata-only evidence, reviewer-decision and revocation-event tables with append-only triggers. It is a reference migration only. It has not been run against Render or any database and must receive separate migration review before use.

## Explicit non-goals

- No evidence upload/download endpoint or document-vault connector.
- No production reviewer identity provisioning or cryptographic reviewer-signature adapter.
- No route mounting, frontend wiring, live database migration, provider integration or signer integration.
- No real payout authorization, transaction preparation, signing, provider request, broadcast or transfer.
- No KYC/KYB exemption and no claim that internal reviewer approval replaces provider or legal verification.

## Verification

The Stage 7 unit tests cover evidence metadata restrictions, private storage constraints, two-person independent review, reviewer exclusion, exact evidence binding, application/mandate revocation, and emergency holds. CI must pass on the new commit; no local or live database verification is claimed by this change.
