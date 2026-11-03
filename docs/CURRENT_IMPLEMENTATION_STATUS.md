# Current implementation status

**Repository:** `MyTeleProject2026/trc20-usdt-token-cloner`  
**Implementation branch:** `docs/platform-owned-treasury-architecture`  
**Documentation baseline:** `924a09b6df1088a787fcfe26ace867baed53358b`  
**Status:** initial self-custody source integration added; validation and live acceptance still outstanding

This report describes source changes on the feature branch. It is not evidence of a deployed service, a successful testnet transfer, a funded treasury, a Mainnet payout, or exchange deposit credit.

## Existing implementation preserved

- Wallet identity challenge/session routes remain in `server/routes/tron-wallet-auth.mjs`.
- Wallet login remains a signed message challenge. It proves control of the configured owner identity address; it is not a transaction signature.
- The identity wallet and configured treasury wallet can be different addresses. The identity wallet may have zero funds.
- Existing Fireblocks and sponsor integrations, their tests, and the original safety gate remain in place as optional/legacy paths.

## New self-custody code added on this branch

- `server/routes/platform-treasury-withdrawals.mjs` adds Mainnet-only routes under `/api/treasury/self-custody/*`.
- `src/PlatformTreasuryPanel.tsx` adds a separate TronLink connection panel in the Wallet Vault Treasury view.
- `src/WalletVault.tsx` mounts the new panel and passes the existing owner-identity session token to it.
- `server/index.mjs` mounts the new router.
- `.env.example` documents the new platform treasury settings.
- `tests/platform-treasury-withdrawals.test.mjs` adds initial parser, configuration, signed-intent, permission-threshold, disabled-gate, and private-key-input-rejection tests.

The new path is separate from Fireblocks. It does not require an external sponsor organization or a Fireblocks vault. The platform must still control and fund the configured treasury address.

### Implemented route behavior in source

| Route | Source behavior |
|---|---|
| `GET /api/treasury/self-custody/readiness` | Authenticates the owner identity session and reads official Mainnet USDT and TRX balances, outstanding reservations, and configuration blockers. |
| `POST /api/treasury/self-custody/prepare` | Validates the recipient and amount, estimates the TRC-20 fee, constructs an unsigned official-USDT transfer, and reserves the principal/fee atomically in PostgreSQL. |
| `POST /api/treasury/self-custody/submit` | Accepts only a signed copy matching the stored unsigned transaction and intent, checks TRON permission-signature weight, claims the intent once, and broadcasts the signed transaction. |
| `GET /api/treasury/self-custody/withdrawals/:intentId` | Looks up the request and verifies the solidified transaction, successful receipt, exact official USDT contract, and matching Transfer event. |

The browser connects to TronLink with the modern `window.tron` provider / TIP-6963 discovery path, requests `eth_requestAccounts`, checks Mainnet, and invokes the wallet's transaction-signing prompt. The browser does not send a private key to the backend. Account or network changes clear the current connection and prepared local intent state.

The backend uses TRON's signature-weight inspection before broadcast. A broadcast acceptance is still not final confirmation; only the later solidified-chain verifier can mark the transfer confirmed. Exchange deposit credit remains unverified unless the exchange itself confirms it.

## Critical remaining limitations

1. **Execution is off by default.** `PLATFORM_TREASURY_SELF_CUSTODY_ENABLED=false` is the documented default. It must not be changed for production before code review, automated tests, signer acceptance, and operational approval.
2. **The new route is Mainnet-only.** A dedicated testnet end-to-end route and test-token fixture have not been added for this self-custody route.
3. **No environment values have been configured or checked.** No Render variables, treasury address, database settings, limits, or secret files were changed.
4. **No funds are created by code.** The configured platform treasury must already hold real official TRON USDT and sufficient TRX for network fees. An empty identity wallet cannot provide either.
5. **No live signer test was performed.** TronLink connect/sign behavior, backend permission-weight response, broadcast, solidification, and exchange deposit handling still require controlled validation.
6. **No build or test result is claimed here.** The new code and tests still need CI/build review after this commit.
7. **No independent security review or production acceptance has occurred.** The new route should not be considered production-ready merely because it is present in the branch.
8. The old Fireblocks route in `server/routes/treasury-withdrawals.mjs` remains hard-disabled by `REAL_VALUE_PAYOUT_EXECUTION_DISABLED = true`. The new self-custody routes do not change or remove that existing gate.

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
| New tests | `tests/platform-treasury-withdrawals.test.mjs` |
| Existing verification tests | `tests/treasury-withdrawals.test.mjs`, `tests/tron-verification.test.mjs`, `tests/trc20-verification.test.mjs` |

## Next acceptance work

- [ ] Run the complete Node test suite and Vite production build in CI.
- [ ] Review the new route for concurrency, expiration, reservation cleanup, authorization, and signature validation.
- [ ] Add a testnet version or isolated testnet harness for the exact wallet-provider signing lifecycle.
- [ ] Validate TronLink account/network events and transaction-signing behavior with a controlled test wallet.
- [ ] Test permission-weight verification, insufficient permissions, invalid signatures, altered transaction data, and multi-signature cases.
- [ ] Test duplicate prepare/submit requests, timeout/ambiguous broadcast, process restart, and concurrent reservations.
- [ ] Complete independent security review.
- [ ] Only after the above and a funded platform treasury, conduct a small, explicitly owner-authorized Mainnet acceptance transfer and independently verify it.

No deployment or payout gate was enabled by this implementation change.
