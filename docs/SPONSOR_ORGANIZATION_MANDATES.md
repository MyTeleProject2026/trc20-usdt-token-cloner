# Sponsor organization onboarding and mandate controls

## Current source status

**The Stage 7B governance and onboarding routes are mounted on the safe feature branch only. The branch is not merged or deployed. This is not evidence that organizational sponsorship is available in production.**

- `server/routes/sponsor-organization-onboarding.mjs` contains the existing organization application and mandate handlers.
- `server/routes/sponsor-organization-governance.mjs` adds metadata-only evidence records, signed independent reviewer decisions, a two-role quorum and signed append-only revocations.
- `server/index.mjs` mounts the governance router before the onboarding router under `/api/tron`. This order ensures the new signed revocation handler intercepts the legacy unsigned mandate-revoke route.
- `Frontend-Tron-Transfer/src/SponsorOrganizationGovernance.jsx` is mounted in the isolated sponsor portal. It supports metadata submission, reviewer approval and signed mandate revocation.
- The active `/api/tron/sponsor-direct` flow remains a separate individual self-custody model. It does not join organization applications or mandate records during sponsor matching.
- Stage 7B governance quorum is not connected to any signer, provider payout adapter, transaction preparation or broadcast path.

Do not treat an application state, mandate state, internal review quorum, metadata record or wallet signature as proof of legal-entity identity, KYB, source-of-funds, provider approval, funded liquidity or payout authorization.

## Intended organization workflow

1. A proposed sponsor organization submits its legal identity and authorized-representative information through authenticated onboarding.
2. Wallet or provider account ownership is independently verified. A wallet challenge proves control of that wallet at that time; it does not prove incorporation, beneficial ownership or corporate authority.
3. Qualified reviewers inspect the underlying identity, authority, jurisdiction and source-of-funds evidence.
4. The organization supplies a signed mandate. The original agreement must be retained in an appropriate document-management system; a digest/reference is an audit binding, not proof that the agreement is legally valid.
5. The organization and provider independently establish which representatives, provider accounts, vaults, assets, networks, destinations, limits and approval quorum are authorized.
6. A separate signer authorization record binds the organization, provider account, signer/policy reference, scope, validity and revocation state.
7. Any future payout service must revalidate the mandate, organization status, provider account, signer authority, policy, funding evidence, recipient and amount at the time of each proposed operation.
8. Any transaction approval must apply to the exact immutable transaction intent. Provider-side approval is distinct from broadcast and on-chain settlement.
9. Settlement is confirmed only through independently verified solidified chain evidence. Exchange account credit remains a separate exchange-controlled state.

## Stage 7B governance semantics and limitations

- Evidence API requests store metadata only: application/mandate binding, evidence type, private vault object key, SHA-256 digest, MIME type, bounded size, encryption declaration, uploader wallet and retention-policy reference.
- The API does not upload, download, fetch, encrypt or malware-scan the referenced object. It reports metadata as pending independent review. Reviewers must inspect the source object in the approved private vault before signing their decision.
- The reviewer registry is server-side configuration. Each reviewer signs a message bound to the application, mandate, exact evidence-set digest, decision, reviewer address/role, independence/conflict attestations, evidence reference and timestamp.
- Quorum requires two distinct reviewers: one active `compliance-reviewer` and one active `security-reviewer`. The sponsor cannot review its own evidence. A rejection or needs-more-evidence decision blocks the current digest's quorum.
- Each reviewer can submit only one decision per mandate and digest. A new evidence digest requires new approvals.
- Sponsor revocation and trusted security-officer emergency revocation are signed, append-only and replay-protected. The API atomically appends the event and marks the related mandate/application revoked or closed.
- Internal review quorum is not a provider KYB decision, legal approval, signing authority or payout authorization.

## Relationship to the active individual sponsor-direct flow

The active sponsor-direct route is a separate individual self-custody model. It has its own wallet application, owner approval, per-payout/daily limits, live chain balance and resource checks, exact transaction preparation, sponsor wallet signature validation, broadcast checks and settlement reconciliation.

The organization mandate module is not a replacement for the sponsor's signature, and its records are not consumed by the sponsor-direct matcher. No organization mandate can make an individual wallet eligible for sponsor-direct payouts.

## Relationship to institutional custody providers

Fireblocks and other institutional signers are separate provider integrations. An organization must complete the provider's own eligibility, identity, legal-entity, contractual, account, vault, asset, signer and transaction-policy requirements.

A provider API credential is not a blockchain signing key and does not override provider transaction policy. The application must use least-privilege provider access and must not store wallet seed phrases or provider signing private keys in application records.

The currently inspected Fireblocks treasury route is a separate module, is not mounted in the runtime, and has a hard-disabled real-value execution constant. It is not a functioning organization signer for this onboarding module.

## Production prerequisites

Before any organizational payout path can be considered:

- The organization and its legal authority must be independently verified.
- The provider account and vault must be confirmed to belong to that organization.
- The signing policy and authorized approver threshold must be independently read from the provider.
- The mandate must explicitly cover the intended asset, network, principal, fees, destinations, limits, purpose, expiry and revocation conditions.
- Genuine, unreserved asset principal and separately sufficient fee resources must be independently verified.
- The exact payout intent must be approved under the provider's real policy.
- Duplicate/replay prevention, atomic reservations, emergency pause, ambiguous-outcome reconciliation and solidified settlement verification must pass review.
- A successful non-production end-to-end run and independent security review must be recorded.
- Production release must be a separate, explicit authorization decision.

No application setting, owner status, sandbox balance, API key, wallet label or fabricated evidence can substitute for these prerequisites.

## Route declarations

The following onboarding and governance routes are mounted on the safe feature branch only:

- `GET /api/tron/organizations/config`
- `POST /api/tron/organizations/applications`
- `GET /api/tron/organizations/me`
- `GET /api/tron/organizations/applications` (owner queue)
- `POST /api/tron/organizations/applications/:id/review` (owner review state)
- `POST /api/tron/organizations/applications/:id/mandates` (sponsor wallet)
- `GET /api/tron/organizations/mandates` (owner queue)
- `POST /api/tron/organizations/mandates/:id/review` (legacy owner review state)
- `POST /api/tron/organizations/mandates/:id/evidence` (sponsor metadata submission)
- `GET /api/tron/organizations/mandates/:id/governance` (authorized sponsor/reviewer/owner read)
- `GET /api/tron/organizations/governance/config` (wallet role lookup)
- `POST /api/tron/organizations/mandates/:id/reviews` (signed independent reviewer decision)
- `POST /api/tron/organizations/mandates/:id/revoke` (signed sponsor/security revocation)
- `POST /api/tron/organizations/applications/:id/revoke` (signed application-wide revocation)

## Deployment and verification boundary

The PR is open and the branch is not merged. No Render deployment, production environment-variable changes, production database migration, vault connection or reviewer provisioning is included. Runtime table creation occurs only when a persistence endpoint is used and the existing organization application/mandate tables are present. The reference migration is not applied by this change.

Regression/source tests can validate handler logic and integration boundaries. They do not establish external KYB, legal authority, provider approval, funded balances, a working institutional signer or exchange deposit credit. A test fixture must never be presented as a real sponsor or a real payout.
