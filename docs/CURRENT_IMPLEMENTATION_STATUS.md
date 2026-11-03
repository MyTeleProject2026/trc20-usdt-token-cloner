# Current implementation status

**Repository:** `MyTeleProject2026/trc20-usdt-token-cloner`  
**Branch inspected:** `main`  
**Inspected commit:** `924a09b6df1088a787fcfe26ace867baed53358b`  
**Inspection date:** 2026-11-03

This is a source inspection summary, not a live Render, Fireblocks, wallet, or Mainnet execution test.

## Implemented code observed

- Wallet authentication routes exist in `server/routes/tron-wallet-auth.mjs`, with challenge, signature verification, session, and logout behavior. Related tests include `tests/tron-wallet-auth.test.mjs`, `tests/wallet-auth-gate.test.mjs`, and `tests/wallet-login-contract-ui.test.mjs`.
- Authentication is message-signature based. The login process does not need to receive a wallet private key. A login signature is not a transaction authorization.
- PostgreSQL-backed session and treasury request persistence exist in `server/database.mjs` and the treasury route.
- The treasury route contains request-ledger schema, idempotency, owner-signature validation helpers, balance/fee reservation calculations, Fireblocks asset checks, and chain-receipt verification helpers.
- A Fireblocks client exists in `server/fireblocks-client.mjs`; the treasury route imports it for provider metadata, balance, fee-estimate, and transaction operations.
- Readiness/status routes and UI elements exist for treasury observation and previously saved request lookup.
- A broad sponsor ledger, budgets, policy, resource-observation, reconciliation, and test suite exist. The external sponsor operating document explicitly records sponsor submission as disabled and no verified external sponsor agreement/funding.
- The project pins the official TRON USDT contract in treasury verification code.

## Critical current limitations

1. In `server/routes/treasury-withdrawals.mjs`, the constant `REAL_VALUE_PAYOUT_EXECUTION_DISABLED` is hard-coded to `true`. It is not a Render environment-variable switch.
2. The existing Fireblocks POST payout route returns a blocked response in this build before owner-session or Fireblocks submission work. A configured environment variable cannot override the hard gate.
3. The current UI describes the treasury pane as read-only and says new payout entry, signing, and broadcast are unavailable in this build. The ordinary wallet transfer review also states signing/broadcast are disabled.
4. The repository does not currently implement the selected owner-wallet-provider treasury signer flow. In particular, the split identity-wallet/treasury-wallet connection and server-validated signed-transaction submission contract remain target work.
5. No repository source or configuration can create or fund the platform's treasury. A real payout requires actual official USDT principal and adequate TRX or independently verified transaction-resource coverage.
6. No source inspection proves that Fireblocks, Tatum, TronGrid, GasFree, Render, an exchange, or any sponsor account is currently authorized, funded, healthy, or operational.
7. No test suite, build, live provider request, testnet transfer, Mainnet transfer, or exchange deposit was executed during this documentation update.

## Selected target

See [Platform-owned self-custody treasury architecture](PLATFORM_OWNED_TREASURY_ARCHITECTURE.md).

The target removes any *requirement* for an external sponsor organization or Fireblocks vault by using a platform-owned, funded treasury wallet and explicit owner signing through a wallet provider. The empty identity wallet can authenticate, but it cannot supply the withdrawal principal. The treasury wallet must hold genuine USDT and the network fees/resources.

## Source map to preserve

| Area | Repository paths |
|---|---|
| Wallet identity | `server/routes/tron-wallet-auth.mjs`, `src/treasury-withdrawal-auth.mjs`, `docs/WALLET_AUTH_IMPLEMENTATION.md` |
| Treasury ledger/provider route | `server/routes/treasury-withdrawals.mjs` |
| Existing managed provider client | `server/fireblocks-client.mjs` |
| Sponsor policy and funding observations | `server/sponsor-funding.mjs`, `server/sponsor-policy.mjs`, `server/sponsor-resources.mjs`, `server/sponsor-reconciliation.mjs` |
| On-chain submission and verification | `server/sponsor-tron-submission.mjs`, `scripts/reconcile-treasury-withdrawals.mjs`, relevant treasury/sponsor tests |
| Wallet UI | `src/WorkflowApp.tsx`, `src/AuthGate.tsx`, `src/WalletVault.tsx` (confirm exact current casing/path in the repository tree before code edits) |

Do not delete these source files merely to remove old documentation. The current implementation should be refactored behind a signer abstraction and migrated in controlled steps.

## What must be implemented next

- [ ] Add explicit identity-wallet vs treasury-wallet state and account/network-change handling.
- [ ] Add a non-custodial owner-wallet provider signer adapter; do not request private keys.
- [ ] Add server-issued, single-use transfer intents bound to treasury, network, official USDT contract, recipient, amount, expiry, and idempotency key.
- [ ] Validate the signed transaction's sender, recipient, contract, amount, permission, and intent before broadcast.
- [ ] Reuse atomic reservations and persist transaction lifecycle states, including ambiguous outcomes.
- [ ] Add owner-wallet signer tests and testnet E2E verification.
- [ ] Perform independent security review and a controlled, owner-authorized Mainnet acceptance transfer.
- [ ] Only then consider removing the hard execution gate in a reviewed release.

Documentation-only changes do not make any withdrawal function live or enabled.
