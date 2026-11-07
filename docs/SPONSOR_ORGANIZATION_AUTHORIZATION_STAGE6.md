# Organizational Sponsor Authorization — Stage 6

## Scope

This stage adds a pure, fail-closed evidence contract and isolated tests. It is not a payout integration and does not enable spending.

## Required independent evidence

The evaluator requires all of the following before it can return a non-production preflight pass:

- Application and mandate are bound to the same application ID and sponsor wallet.
- Every evidence result is bound to that exact application ID, sponsor wallet, agreement digest, provider account ID, and provider signing-policy reference; evidence copied from another case is rejected.
- Application is in the due-diligence review state and the mandate is explicitly authorized.
- Agreement digest and the sponsor's signature over the exact mandate intent are independently verified.
- Legal-entity identity, beneficial ownership and wallet control are independently verified.
- Review evidence is traceable and the reviewer is independent.
- Mandate purpose, positive base-unit limits and validity window are consistent.
- Provider account identity, provider signer policy, sponsor principal/fee funding, and sandbox/Mainnet separation are independently verified.

A reference string or owner-entered review status is not evidence by itself. The evaluator expects trusted server-side verification results; it must never consume client-supplied booleans as proof.

## Deliberate limitations

- Only `per-transfer` mandate mode is accepted by this non-production evaluator. Standing provider authorization is blocked pending a separately reviewed provider adapter and authorization model.
- The evaluator returns `payoutAuthorized: false` even when every check passes.
- It does not sign, call a provider, create a transaction, broadcast, or verify exchange credit.
- The evaluator is not imported or mounted by `server/index.mjs` and is not connected to the active sponsor-direct route.
- The organization onboarding router is mounted at `/api/tron` in `server/index.mjs`; the Stage 7B governance router is mounted immediately before it so its signed revocation and review routes take precedence where paths overlap.
- The sponsor portal is routed at `#/sponsor` and renders the `SponsorOrganizationGovernance` panel. That panel provides mandate evidence, reviewer decision and revocation controls. The current sponsor portal does not render an organization-application submission form or call the onboarding `/organizations/applications` endpoints; backend onboarding routes and frontend onboarding UI must therefore be treated as separate implementation surfaces.
- The organization onboarding API now advertises and accepts only `per-transfer` mandates. The legacy `fincra-automatic` database value is retained solely for backward-compatible reads of historical rows; those rows cannot be verified or authorized through the legacy review route and may only be declined or revoked. The obsolete `FINCRA_AUTO_PAYOUTS_ENABLED` status indicator and Fincra business-ID authorization branch have been removed. This change does not activate payout execution.
- No production database migration or write is part of this stage.

## Verification

The tests exercise missing/false evidence, cross-application and wallet substitution, cross-case evidence replay, provider-account/policy substitution, invalid limits, expired/future mandates, standing-provider mode, and the invariant that preflight never authorizes execution. CI is the verification source; local execution is not claimed unless separately recorded.
