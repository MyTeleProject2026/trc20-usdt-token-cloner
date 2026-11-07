# Stage 7C — Mainnet signing and authorization audit

## Scope and evidence

This is a source-code audit of the feature branch `safe/sandbox-mainnet-org-auth-guards`. It is not a live Render audit, provider approval, wallet-control proof, funding proof, or on-chain transaction test.

## Broadcast paths and current build gates

### Sponsor-direct Mainnet route

- Runtime route: `POST /api/tron/sponsor-direct/requests/:id/broadcast`.
- The source includes a real Tatum Mainnet broadcast call at the end of the handler.
- This feature branch sets `REAL_SPONSOR_DIRECT_BROADCAST_DISABLED = true` and returns HTTP 503 before wallet-session, database, signing or provider operations.
- The sponsor-direct capability response reports `payoutExecution: disabled-in-this-build` and `broadcastDisabledInBuild: true`.
- The prepare route can still create/persist an **unsigned** transaction and run Mainnet read/simulation preflight. Preparation is not authorization to sign or broadcast.

If the hard gate were removed in a separately approved future release, the source's pre-broadcast checks include the assigned sponsor wallet session, active sponsor profile, per-payout/daily limits, prepared state and expiry, live Mainnet USDT balance after reservations, current transfer simulation, Energy/Bandwidth/TRX fee coverage, exact signed transaction matching and Tatum's independently recovered approved signer address. These code checks do not prove that a sponsor is legally authorized or that the assets belong to the sponsor organization.

### Treasury / Fireblocks Mainnet route

- Runtime route: `POST /api/treasury/withdrawals` and native TRX equivalent `POST /api/treasury/trx-withdrawals`.
- `REAL_VALUE_PAYOUT_EXECUTION_DISABLED = true` is a hard-coded build constant, not a Render environment variable.
- Both submission handlers return HTTP 503 before owner authorization, provider transaction creation, signing or submission.
- Readiness now reports `withdrawalsEnabled` from `executionEnabled`, not merely preflight status. It may report a passed preflight while still clearly reporting execution disabled.

The source has configuration checks for a Fireblocks signer/vault and asset identifiers, but configuration-shaped environment values are not proof of an approved provider account, funded vault, signer policy, or successful Mainnet transaction.

### Owner-direct Mainnet route

- `server/routes/tron-owner-withdrawals.mjs` contains a Tatum-backed owner-direct prepare and broadcast router.
- The current server entrypoint `server/index.mjs` does **not** import or mount `createTronOwnerWithdrawalsRouter`, so this route is not exposed by the current server entrypoint.
- A hard build-time constant `REAL_OWNER_DIRECT_MAINNET_BROADCAST_DISABLED = true` was added as defense in depth. If the router is mounted in a future build, `POST /:id/broadcast` returns HTTP 503 before owner session verification, database access or Tatum broadcast.
- The preparation code can build an unsigned official-USDT transaction after its Mainnet simulation/resource checks. Preparation is not a transfer.

### Sponsored native transfer route

- The separate `server/routes/native-tron.mjs` submission handler is restricted to stored transfer networks `shasta` or `nile`.
- It requires `SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED=true`, a prepared persisted transaction, an active approved testnet budget, independently checked fee-resource delegation, exact sponsor signature validation and a broadcast claim.
- It is therefore a testnet-only pathway, not a Mainnet payout route. Do not set the testnet broadcast variable for a Mainnet network; the server-side network check must continue to reject Mainnet.

## Organizational authorization boundary

- Organizational applications, evidence custody, reviewer approvals and mandate status are governance records.
- Two-person reviewer quorum does not create provider authority, legal approval, signer authority, available funds or payout permission.
- The organization evidence API remains disconnected from the sponsor-direct payout matcher and from the Fireblocks treasury execution path.
- Reviewer wallets and security-officer wallets must be separately provisioned in pinned public-key/address registries. No reviewer or signer identities were created by this audit.
- A signed vault receipt proves that a configured trusted vault gateway signed custody claims. It does not independently prove legal identity or source of funds. The gateway itself must query the provider's actual object version, KMS encryption and Object Lock retention before signing.

## Funding and fee-reserve evidence required for a future Mainnet release

For each proposed payout, an independently authorized sponsor/treasury owner must establish:

1. Sponsor legal identity and authority to use the named treasury.
2. A signed mandate binding that organization, the specific treasury wallet/provider account, official TRC20 USDT asset, TRON Mainnet network, scope, recipient rules, amount limits, fees, validity and revocation conditions.
3. Independently observed confirmed/solidified official USDT balance and the exact unreserved spendable amount.
4. Sufficient native TRX and/or approved Energy/Bandwidth delegation for the exact transaction and configured fee limit, including outstanding reservations.
5. Authorized signer identity, actual wallet/provider permissions and threshold policy, independently checked with the account owner/provider.
6. A one-time approval bound to the exact immutable transaction intent (network, contract, sender, recipient, amount, fee limit, expiry and idempotency key).
7. Duplicate/replay protection and atomic reservations; ambiguous broadcast outcomes must be reconciled by fixed txid rather than replaced.
8. Independently verified solidified Mainnet transaction and exact official USDT Transfer event.
9. Any separate receiving-exchange credit confirmation remains controlled by that exchange.

Sandbox balances, UI dashboard totals, mocked provider responses, config flags and internal mandate statuses do not satisfy these funding or authorization requirements.

## Regression checks

The branch adds/updates tests proving:
- sponsor-direct Mainnet broadcast returns 503 before session or provider access;
- owner-direct Mainnet broadcast returns 503 before session or provider access;
- treasury readiness never reports withdrawals enabled while its hard execution gate is closed;
- the sponsored native route only accepts Shasta/Nile for signed submission;
- governance responses never claim payout authorization or broadcast.

## Current conclusion

**Mainnet payout execution is disabled in this feature branch.** No real sponsor funds, legal authorization, provider approval, Fireblocks signer, vault gateway or production key registry has been independently established. No Render configuration, production database, external account, transaction signature, broadcast or fund transfer was changed or performed.

The route-level gates are code protections. They do not establish that a future production deployment has identical code or that a provider will authorize transactions. Any future removal of these hard blocks must be a separate reviewed release with live but read-only funding/permission evidence first.
