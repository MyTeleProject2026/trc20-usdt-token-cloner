# Sandbox and Mainnet funding boundary

## Purpose

This document defines a strict accounting and authorization boundary between simulated provider balances and real TRON network assets. It does not enable transaction submission.

## Non-negotiable rules

- A sandbox balance, simulated deposit, test fixture, mocked provider response, or webhook event marked as sandbox/test/simulated is never spendable funding.
- Sandbox balances must never be copied into Mainnet treasury balances, sponsor budgets, reservations, available-liquidity figures, or payout eligibility evidence.
- A provider account can be considered a live funding source only when the trusted server-side provider integration independently confirms the live account/environment, account identity, asset, network, available balance, and any approved credit facility.
- On-chain funding evidence must be independently read from the exact intended network and verified against the approved token contract. A testnet token is not Mainnet USDT.
- `livemode`, `sandbox`, `simulated`, environment and network claims supplied by a browser request are untrusted input. They must be obtained from authenticated provider responses or independent chain reads.
- A successful sandbox webhook or sandbox payout status is not a chain transaction and cannot confirm an exchange deposit.
- Mainnet submission remains disabled unless separately approved production signing, funding, security, operator and settlement gates have been completed.

## Preflight evaluator contract

`server/sponsor-integration-policy.mjs` now requires both the principal-funding snapshot and fee-funding snapshot to include:

- the exact requested `network` and matching `environment`;
- `sandbox: false` and `simulated: false`;
- `sourceVerified: true`;
- either `sourceKind: "onchain"` with `chainVerified: true`, or `sourceKind: "provider-live-account"` with `liveMode: true`.

The evaluator fails closed if any provenance field is absent, mismatched, or indicates simulation. A large displayed balance does not override a failed provenance check.

For `sponsor-organization` mode, the evaluator additionally requires independently verified organization identity, spending mandate, signer authority, provider account and provider signing policy.

## Important integration limitation

This is a pure preflight policy evaluator. It is not a signer, provider adapter, transaction submitter, chain verifier, or database-backed evidence loader. The current active sponsor-direct payout router does not consume this evaluator, and the organization router is not mounted in the runtime. Therefore these new checks are unit-tested safeguards, not proof that a live payout path has adopted them.

The readiness endpoint must continue to report submission disabled and must report the missing end-to-end sandbox/Mainnet isolation and organization-signer integration blockers until a separately reviewed integration connects trusted evidence to every execution gate.

## Verification

Run:

```sh
npm test
```

The policy tests must prove that sandbox principal balances and sandbox fee balances are rejected even when the numeric balance exceeds the requested amount, and that organization mode is rejected unless signer authority, provider account and signing policy are all verified.

No sandbox-to-Mainnet conversion, simulated credit, webhook replay, database mutation, production configuration change, or Mainnet transfer is permitted by this design.