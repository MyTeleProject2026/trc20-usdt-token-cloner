# Current treasury withdrawal route reference

**This document describes the code currently in the repository. It is not the selected target architecture and it does not indicate that real withdrawals are enabled.**

For the intended no-third-party-custody design, read [Platform-owned self-custody treasury architecture](PLATFORM_OWNED_TREASURY_ARCHITECTURE.md). For an audited source snapshot and remaining work, read [Current implementation status](CURRENT_IMPLEMENTATION_STATUS.md).

## Current code path

The current implementation in `server/routes/treasury-withdrawals.mjs` is coupled to `server/fireblocks-client.mjs`. It includes Fireblocks asset metadata/balance checks, provider fee-estimate handling, request idempotency, PostgreSQL reservations, owner-signature validation helpers, and independent TRON receipt/event verification.

**The current build has a hard-coded blocker:**

```js
const REAL_VALUE_PAYOUT_EXECUTION_DISABLED = true
```

This gate is enforced in backend code and is not controlled by Render environment variables. The current main-branch source and UI describe payout submission, signing, and broadcast as unavailable/read-only. A successful preflight, true configuration flag, API key, dashboard balance, or saved request lookup does not override this gate or prove that a transfer can be made.

The ordinary Wallet Vault transfer review in this build also states that signing and broadcast are disabled. Do not remove either restriction as a documentation-only change.

## Existing routes

The current route set includes:

- `GET /api/treasury/withdrawals/readiness` — owner-authenticated read-only configuration/provider/asset/balance/fee preflight.
- `POST /api/treasury/withdrawals` — current Fireblocks submission route; blocked by the hard execution gate in this build.
- `GET /api/treasury/withdrawals/:idempotencyKey` — look up a previously recorded request.
- `POST /api/treasury/withdrawals/:idempotencyKey/verify` — refresh and independently verify an available chain transaction.
- Native TRX counterparts under `/api/treasury/trx-withdrawals/*`.

Readiness data describes observations only. It does not authorize spending, and a provider's accepted/pending status is not a confirmed chain transfer. Confirmed status requires the solidified TRON transaction, exact sender and recipient, official USDT contract, exact amount, successful receipt, and matching Transfer event.

## Existing Fireblocks configuration

The current Fireblocks route uses backend-only variables documented in `.env.example`:

- `TREASURY_SIGNER_MODE`
- `TREASURY_ADDRESS`
- `TREASURY_MAX_PAYOUT_USDT`
- `TREASURY_DAILY_LIMIT_USDT`
- `TREASURY_FEE_LIMIT_SUN`
- `FIREBLOCKS_API_BASE`
- `FIREBLOCKS_API_KEY`
- `FIREBLOCKS_SECRET_KEY_PATH`
- `FIREBLOCKS_VAULT_ACCOUNT_ID`
- `FIREBLOCKS_USDT_ASSET_ID`
- `FIREBLOCKS_TRX_ASSET_ID`
- `TREASURY_WITHDRAWALS_ENABLED`
- `TREASURY_TRX_WITHDRAWALS_ENABLED`

These variables configure the existing provider-oriented integration and readiness checks. They do not create a Fireblocks workspace, vault, approval policy, API credentials, funding, or a functioning withdrawal path. Never put the Fireblocks API-authentication private key or a blockchain private key into Git, frontend variables, logs, or chat.

The detailed optional provider runbook remains at [Fireblocks organization and vault setup](FIREBLOCKS_ORGANIZATION_VAULT_SETUP.md). Fireblocks is **not mandatory** in the selected platform-owned self-custody target.

## Funding, fees, and destination rules

- The platform treasury must actually hold the official TRON USDT principal. The official TRON Tether contract is `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`.
- The treasury must also have adequate TRX or separately verified resource coverage for transaction costs.
- A fee sponsor does not provide USDT principal.
- Never display an application-only amount as a chain balance.
- A confirmed TRON transfer does not prove an exchange credited the deposit. Exchange credit requires the exchange's own authenticated record.
- No private key is required for wallet login. A login signature is identity proof only; transaction signing must be a separate explicit action by the authorized treasury wallet.

## Migration direction

The intended target removes the mandatory Fireblocks dependency by introducing a wallet-provider signer for a separately connected platform-owned treasury wallet. The target requires a backend-issued short-lived payout intent, a transaction signed by the approved treasury wallet, strict signed-transaction validation before broadcast, persistent idempotency/reservations, and solidified-chain verification.

That signer and its complete acceptance tests are not currently implemented. Until they are implemented, reviewed, and accepted with a controlled transaction, the hard execution gate must remain in place.