# Sponsor operator runbook — official Tether Mainnet only

## Scope

The only supported token principal for the production payout product is official Tether USDT (TRC-20) on TRON Mainnet:

- Contract: `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`
- Decimals: `6`
- Network: `mainnet`

No VTRC, independent project token, testnet USDT-like token, or arbitrary TRC-20 contract is supported as payout principal.

Native TRX is a separate network-fee/resource asset. The legacy Nile/Shasta sponsor operator console is a testnet diagnostic and TRX fee/resource workflow only; it does not submit official Tether USDT transfers.

## Production request review

The wallet's **Organization payouts** page can create an owner-signed request for independent organization review. The relevant backend endpoints are:

- `POST /api/treasury/payout-requests`
- `GET /api/treasury/payout-requests/:idempotencyKey`
- `GET /api/treasury/payout-requests?limit=50`

The request must be bound to:
- the authenticated configured Mainnet treasury owner;
- the exact deployed frontend origin;
- an external TRON Mainnet recipient;
- a positive decimal USDT amount with at most six decimal places;
- the official contract pinned by the backend;
- a unique idempotency key and fresh request-only owner signature.

The reviewer queue is protected by the separate server-side `TREASURY_PAYOUT_REVIEW_API_TOKEN`. This is a read-only credential and is distinct from `SPONSOR_ADMIN_API_TOKEN` and all Fireblocks credentials. It cannot approve, reserve, sign, or broadcast a transfer.

A stored request is `pending-organization-review`. It is not a sponsor commitment, approval, transaction, or exchange deposit.

## Fireblocks/custody prerequisites

Only the authorized adult representative, treasurer and security administrator of the actual treasury-owning organization may complete its Fireblocks onboarding and production setup.

The organization must independently:
1. Approve the application and its exact intended payout use in writing.
2. Complete Fireblocks organization eligibility/onboarding and provision a production workspace.
3. Create its dedicated TRON vault, activate official USDT and native TRX, and verify the asset IDs and common vault address.
4. Create and approve a least-privilege API user, retain its RSA-4096 private key securely, and configure a strict transaction policy and human approval quorum.
5. Fund the vault with genuine Tether Mainnet USDT and sufficient native TRX.
6. Verify the balances with both Fireblocks and the public TRON chain.

The private key and Fireblocks API key must never be sent through ChatGPT, committed to GitHub, or placed in frontend variables. Install the private key on Render only as a backend Secret File.

## Limits, reservations and fee handling

- The sponsor asset-principal budget must be official Mainnet USDT at the exact Tether contract.
- TRX fee/resource budgets must be separate from USDT principal.
- Any future submit path must atomically reserve the approved principal and fee budgets before calling Fireblocks.
- Enforce per-transfer and daily limits, recipient policy, expiry, replay protection, idempotency, emergency pause, audit logging, and post-broadcast reconciliation.
- Do not allow testnet USDT-like tokens or independent project tokens in the Mainnet Tether product.

The currently available testnet reservation endpoint is limited to Nile/Shasta TRX network-fee reservations. It rejects testnet token-principal grants.

## Production release status

The backend constant `REAL_VALUE_PAYOUT_EXECUTION_DISABLED = true` remains active. Both `TREASURY_WITHDRAWALS_ENABLED` and `TREASURY_TRX_WITHDRAWALS_ENABLED` must remain false.

This runbook does not authorize a payout. A separate security review, controlled end-to-end test, written release approval and verified production custody/funding evidence are required before any genuine Mainnet USDT submission can be considered.

## Verification and exchange credit

A future real transfer must be confirmed using its actual solidified Mainnet receipt and exact official Tether Transfer event (sender, recipient, contract, amount). An exchange deposit is credited only when the receiving exchange's own authorized deposit record confirms it. A transaction hash, request record, provider acknowledgement or screenshot is not exchange-credit evidence.
