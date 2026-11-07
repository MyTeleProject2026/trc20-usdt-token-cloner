# Sponsor organization onboarding and mandate controls

## Status in the audited runtime

**This document describes the organization-onboarding design and the current source module. It is not a claim that organizational sponsorship is available in the deployed application.**

At the audited `main` baseline and the safe hardening branch:

- `server/routes/sponsor-organization-onboarding.mjs` contains organization application and mandate handlers.
- `server/index.mjs` does not import or mount `createSponsorOrganizationRouter`; these route handlers are therefore not reachable through the deployed Express API.
- `Frontend-Tron-Transfer/src/SponsorOrganizationOnboarding.jsx` exists, but `Frontend-Tron-Transfer/src/App.jsx` does not import or render it.
- The active `/api/tron/sponsor-direct` flow uses individual wallet sponsor application and payout records. It does not join organization applications or mandate records during sponsor matching.
- The organization mandate module does not provide an institutional signing adapter and does not authorize Fireblocks or another provider to sign a transaction.

Do not use the presence of this module, database schema, UI component, documentation, or unit tests as evidence that an organization is approved, funded, or able to submit payouts.

## Intended organization workflow (design only)

The following is the target workflow for a later, separately reviewed integration:

1. A proposed sponsor organization submits its real legal identity and authorized-representative information through an authenticated onboarding process.
2. A wallet or provider account is bound to the organization using an independently verified ownership/authority process. A wallet challenge proves control of that wallet at that time; it does not prove incorporation, beneficial ownership, or authority to bind the organization.
3. A qualified reviewer records the result of independent identity, authority, jurisdiction, and source-of-funds checks. An application state such as `accepted-for-due-diligence` is an internal workflow state, not external KYB approval.
4. The organization supplies a signed mandate. The original agreement must be retained in an appropriate document-management system; a digest/reference is an audit binding, not proof that the agreement is legally valid.
5. The organization and provider independently establish which representatives, provider accounts, vaults, assets, networks, destinations, limits, and approval quorum are authorized.
6. A separate signer authorization record binds the organization, provider account, signer/policy reference, scope, validity, and revocation state.
7. The payout service must revalidate the mandate, organization status, provider account, signer authority, policy, funding evidence, recipient and amount at the time of each proposed operation.
8. Any transaction approval must apply to the exact immutable transaction intent. A provider-side approval is distinct from broadcast and from on-chain settlement.
9. Settlement is confirmed only through independently verified solidified chain evidence. Exchange account credit remains a separate exchange-controlled state.

## Current source module semantics and limitations

The existing organization module contains application and mandate state handlers, including internal review states such as `in-review`, `accepted-for-due-diligence`, `signed-awaiting-review`, `verified`, `authorized`, and revocation.

Those states must be interpreted narrowly:

- A signature over an application message proves wallet control, not legal-entity identity.
- An application or owner review status is not a provider's KYB decision.
- A mandate digest and evidence reference do not independently verify the signed original, the signer's corporate authority, beneficial ownership, or source of funds.
- A reviewer-entered `verified` or `authorized` status is an application record. It must not be treated as proof unless the underlying evidence was actually checked by an appropriately authorized reviewer.
- The route module does not implement a provider-managed signing policy or prove that a custody provider will accept a transaction.
- No current organization-to-institutional-signer connection has been demonstrated.

## Relationship to the active individual sponsor-direct flow

The active sponsor-direct route is a separate individual self-custody model. It has its own wallet application, owner approval, per-payout/daily limits, live chain balance and resource checks, exact transaction preparation, sponsor wallet signature validation, broadcast checks and settlement reconciliation.

The active route currently requires the assigned sponsor wallet to sign its own prepared transaction. The organization mandate module is not a replacement for that signature, and its records are not currently consumed by the sponsor-direct matcher.

Until a separately reviewed integration exists, an organization mandate must not be used to make an individual wallet sponsor eligible or to infer institutional signer authority.

## Relationship to institutional custody providers

Fireblocks and other institutional signers are separate provider integrations. An organization must complete the provider's own eligibility, identity, legal-entity, contractual, account, vault, asset, signer, and transaction-policy requirements.

A provider API credential is not a blockchain signing key and does not override the provider's transaction policy. The application must use least-privilege provider access and must not store wallet seed phrases or provider signing private keys in application records.

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
- A successful testnet end-to-end run and independent security review must be recorded.
- Production release must be a separate, explicit authorization decision.

No application setting, owner status, sandbox balance, API key, wallet label, or fabricated evidence can substitute for these prerequisites.

## Route declarations in the source module

The organization route module defines the following intended paths, but they are **not mounted in the currently audited backend runtime**:

- `GET /api/tron/organizations/config`
- `POST /api/tron/organizations/applications`
- `GET /api/tron/organizations/me`
- `GET /api/tron/organizations/applications` (owner)
- `POST /api/tron/organizations/applications/:id/review` (owner)
- `POST /api/tron/organizations/applications/:id/mandates` (sponsor wallet)
- `GET /api/tron/organizations/mandates` (owner)
- `POST /api/tron/organizations/mandates/:id/review` (owner)
- `POST /api/tron/organizations/mandates/:id/revoke` (sponsor wallet)

These are route declarations, not evidence of deployed availability.

## Test interpretation

Unit and source tests can validate handler logic, status transitions, and integration boundaries. They do not establish external KYB, legal authority, provider approval, funded balances, a working institutional signer, or exchange deposit credit. A test fixture must never be presented as a real sponsor or a real payout.
