# Organizational Sponsor Authorization — Stage 6

## Scope

This stage adds a pure, fail-closed evidence contract and isolated tests. It is not a payout integration and does not enable spending.

## Required independent evidence

The evaluator requires all of the following before it can return a non-production preflight pass:

- Application and mandate are bound to the same application ID and sponsor wallet.
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
- It is not mounted into `server/index.mjs` or connected to the active sponsor-direct route.
- The organization onboarding router remains unmounted and its UI remains unconnected, as documented in the prior audit.
- No production database migration or write is part of this stage.

## Verification

The tests exercise missing/false evidence, cross-application and wallet substitution, invalid limits, expired/future mandates, standing-provider mode, and the invariant that preflight never authorizes execution. CI is the verification source; local execution is not claimed unless separately recorded.
