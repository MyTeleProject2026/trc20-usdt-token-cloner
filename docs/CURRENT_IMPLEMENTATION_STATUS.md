# Current implementation status

**Repository:** `MyTeleProject2026/trc20-usdt-token-cloner`  
**Implementation branch:** `docs/platform-owned-treasury-architecture`  
**Latest implementation revision verified by CI:** `9b41e4cc5e132d984b66d7314687defa1f574321`  
**Status:** initial self-custody source integration present; live wallet acceptance and production release remain outstanding

This report describes the feature-branch source. It is not evidence of a deployed service, a funded treasury, a real testnet/Mainnet transfer, or exchange deposit credit.

## Existing implementation preserved

- Wallet identity challenge/session routes remain in `server/routes/tron-wallet-auth.mjs`.
- Wallet login remains a signed message challenge. It proves control of the configured owner identity address; it is not a transaction signature.
- The identity wallet and configured treasury wallet can be different addresses. The identity wallet may have zero funds.
- Existing Fireblocks and sponsor integrations, their tests, and the original Fireblocks execution safety gate remain in place as optional/legacy paths.

## New self-custody code added on this branch

- `server/routes/platform-treasury-withdrawals.mjs` adds Mainnet-only routes under `/api/treasury/self-custody/*`.
- `src/PlatformTreasuryPanel.tsx` adds a separate TronLink connection panel in the Wallet Vault Treasury view, including an in-panel owner identity sign-in action and incomplete-configuration display.
- `src/WalletVault.tsx` mounts the new panel and passes the existing owner-identity session token to it.
- `server/index.mjs` mounts the new router.
- `.env.example` documents the new platform treasury settings.
- `tests/platform-treasury-withdrawals.test.mjs` covers amount parsing, numeric limit comparison, incomplete configuration, separate wallet roles, signature-weight thresholds, signed-intent matching, feature-off behavior, private-key-field rejection, authenticated readiness when treasury settings are incomplete, and malformed/missing idempotency request-key rejection.

The new path is separate from Fireblocks. It does not require an external sponsor organization or Fireblocks vault. The platform must still control and fund the configured treasury address.

## Implemented route behavior in source

| Route | Source behavior |
|---|---|
| `GET /api/treasury/self-custody/readiness` | Authenticates the owner identity session. When treasury settings are incomplete, returns the missing settings without attempting a chain read; otherwise reads official Mainnet USDT/TRX balances, outstanding reservations, and readiness blockers. |
| `POST /api/treasury/self-custody/prepare` | Requires complete configuration and the explicit feature flag; validates the recipient and amount, estimates the TRC-20 fee, constructs an unsigned official-USDT transfer, and reserves principal/fee atomically in PostgreSQL. |
| `POST /api/treasury/self-custody/submit` | Accepts only a signed copy matching the stored unsigned transaction and intent, checks TRON permission-signature weight, claims the intent once, and broadcasts the signed transaction. |
| `GET /api/treasury/self-custody/withdrawals` | Returns the latest owner-scoped PostgreSQL withdrawal records, flags any outstanding request (including beyond the page limit), expires stale unsigned intents, and includes the original unsigned transaction only for prepared, unexpired requests so the UI can recover after refresh. |
| `GET /api/treasury/self-custody/withdrawals/:intentId` | Looks up the request and verifies the solidified transaction, successful receipt, exact official USDT contract, and matching Transfer event. |

The browser connects to TronLink through `window.tron` / TIP-6963 discovery, requests account access, checks Mainnet, and invokes the wallet's transaction-signing prompt. The browser does not send a private key to the backend. Owner-scoped history is reloaded from PostgreSQL after sign-in, browser refresh, or backend-router restart. An unexpired prepared request can be restored with its original unsigned transaction; broadcast states can only be reconciled against the original transaction ID. The API now enforces one outstanding withdrawal per owner/treasury under the same PostgreSQL advisory lock used for reservations; direct API callers cannot bypass the browser gate by creating a second request. History returns the newest records plus all outstanding intents, even when an older outstanding intent falls outside the display window. New preparation stays disabled while any owner withdrawal remains outstanding, and it fails closed if history cannot be loaded.

The backend checks the transaction's exact raw data and transaction ID, applies a strict signed-payload field allowlist, checks TRON signature weight against the permission threshold, and only then attempts broadcast. The frontend rechecks Mainnet and the transaction intent immediately before and after the wallet-signing prompt. Pending and ambiguous status responses remain visible instead of being treated as transport errors. Expired unsigned intents are excluded from active principal/fee reservations and rolling daily totals. A broadcast acceptance is not final confirmation; only the later solidified-chain verifier can mark the transfer confirmed. Exchange deposit credit remains unverified unless the exchange itself confirms it.

Prepare requests now include a UUIDv4 request key. PostgreSQL stores it under a unique owner/request-key index; retrying the same request with the same destination and amount returns the original intent, while reusing the key with different details is rejected. The new isolated PostgreSQL integration test exercises simultaneous same-key prepare calls, one-row reservation, same-detail replay, changed-detail rejection, history recovery, and recovery through a fresh router instance. Its CI result must pass on the current head before the behavior is treated as verified.

## Automated validation observed

Historical baseline: implementation commit `9b41e4cc5e132d984b66d7314687defa1f574321`, CI run `41782279950`, passed 664 tests, the Vite production build/contract compile, and dependency audit `41782280030`.

Latest recovery/concurrency implementation: commit `4e7c28cc594538ea474ab4eb9a4d03c3ce147d25`.
- GitHub Actions CI run `41787367692`: passed 666 tests, 0 failures, including the new PostgreSQL-backed idempotency, concurrency, owner-isolation, and restart-recovery integration coverage.
- The same run compiled the contract and completed the Vite production build.
- Dependency security audit run `41787367703`: passed.

These are source/automated-test results only. They do not validate TronLink with a real wallet, a live testnet wallet session, a live Mainnet balance, a funded treasury, an actual transfer, or exchange deposit credit.

## Critical remaining limitations

1. **Execution is off by default.** `PLATFORM_TREASURY_SELF_CUSTODY_ENABLED=false` is the documented default. Do not enable it for production before the remaining code review, wallet-provider acceptance, security review, and operational approval.
2. **The new owner-treasury API is Mainnet-only.** The repository's existing WorkflowApp has a separate direct Nile/Shasta test-wallet transfer path, but it does not exercise the new PostgreSQL-backed owner-treasury reservation, recovery, and permission-check flow. A dedicated self-custody testnet acceptance exercise is still required.
3. **No environment values have been configured or checked.** No Render variables, treasury address, database settings, limits, or secret files were changed.
4. **No funds are created by code.** The configured platform treasury must already hold real official TRON USDT and sufficient TRX for network fees. An empty identity wallet cannot provide either.
5. **No live signer test was performed.** TronLink connection/signing, permission-weight response, real broadcast, solidification, and exchange deposit handling still require controlled validation.
6. **No independent security review or production acceptance has occurred.** The new route should not be considered production-ready merely because it is present and passes automated CI.
7. The old Fireblocks route in `server/routes/treasury-withdrawals.mjs` remains hard-disabled by `REAL_VALUE_PAYOUT_EXECUTION_DISABLED = true`. The new self-custody routes do not change or remove that existing gate.

## New backend configuration

See [Self-custody treasury runbook](PLATFORM_TREASURY_SELF_CUSTODY_RUNBOOK.md). The new settings are:

- `PLATFORM_TREASURY_SELF_CUSTODY_ENABLED`
- `PLATFORM_TREASURY_ADDRESS`
- `PLATFORM_TREASURY_MAX_PAYOUT_USDT`
- `PLATFORM_TREASURY_DAILY_LIMIT_USDT`
- `PLATFORM_TREASURY_MAX_FEE_SUN`

The existing `OWNER_WALLET_ADDRESS` and `TREASURY_OWNER_ADDRESS` still identify the authorized owner login and must match. `PLATFORM_TREASURY_ADDRESS` is the separate treasury wallet connected through TronLink.

## Files to preserve

| Area | Repository paths |
|---|---|
| Identity | `server/routes/tron-wallet-auth.mjs`, `server/database.mjs`, `src/AuthGate.tsx` |
| New self-custody route | `server/routes/platform-treasury-withdrawals.mjs` |
| Existing Fireblocks route | `server/routes/treasury-withdrawals.mjs`, `server/fireblocks-client.mjs` |
| Wallet UI | `src/WalletVault.tsx`, `src/PlatformTreasuryPanel.tsx`, `src/wallet-transfer.mjs` |
| New tests | `tests/platform-treasury-withdrawals.test.mjs`, `tests/platform-treasury-postgres-integration.test.mjs` |
| Existing verification tests | `tests/treasury-withdrawals.test.mjs`, `tests/tron-verification.test.mjs`, `tests/trc20-verification.test.mjs` |

## Next acceptance work

- [ ] Review the new route for concurrency, expiry, reservation cleanup/recovery, authorization, and signature validation.
- [ ] Add a testnet version or isolated testnet harness for the exact wallet-provider signing lifecycle.
- [ ] Validate TronLink account/network/signing behavior with a controlled wallet.
- [ ] Test permission-weight verification, insufficient permissions, invalid signatures, altered transaction data, and multi-signature cases.
- [ ] Verify the new PostgreSQL replay/concurrency/restart-recovery integration test passes on the current PR head.
- [ ] Test duplicate submit, timeout/ambiguous broadcast, process restart, and concurrent reservations.
- [ ] Complete independent security review.
- [ ] Only after the above and a funded platform treasury, conduct a small, explicitly owner-authorized Mainnet acceptance transfer and independently verify it.

No deployment or payout gate was enabled by this implementation change.
