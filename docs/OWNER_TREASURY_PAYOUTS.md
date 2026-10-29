# Owner-only treasury payout setup

This guide describes the single-owner authorization gate and points to the current managed signing integration. It is not a way to create or mint USDT.

## Owner identity

The private console uses the existing single-owner wallet-auth challenge/session. Configure `OWNER_WALLET_ADDRESS` and `TREASURY_OWNER_ADDRESS` to the same owner-controlled Mainnet address, and configure the password hash as described in the owner-auth documentation. A wallet identity session alone does not authorize a payout: each payout request must also include a fresh owner signature tied to the exact recipient, amount, treasury, app origin and idempotency reference.

Never share passwords, API credentials, secret files, private keys or recovery phrases in chat, source control, APK resources, or logs.

## Managed signer

The USDT payout route on this feature branch uses the Fireblocks production REST API. Fireblocks holds the vault transaction signing authority; Tron Token Studio sends a bounded transaction request using server-only API credentials. The Fireblocks API authentication RSA key is mounted as a backend secret file; it is not a blockchain private key, and it is never sent to the frontend.

See [TREASURY_WITHDRAWALS.md](TREASURY_WITHDRAWALS.md) for exact endpoints, environment variables, provider policy requirements, and reconciliation rules.

Required safeguards include:
- The provider's configured vault account and asset ID must identify the actual official TRON USDT contract.
- The provider must return exactly one configured TRON address matching `TREASURY_ADDRESS`.
- Provider-available balance and public on-chain balance must both cover the requested amount after reservations.
- The real TRX balance must cover the configured fee cap; this branch does not presume automatic fee sponsorship.
- Provider transaction policy must enforce approved source, asset, recipient rules, and required approvals. The app does not bypass provider review.
- Each request is owner-signed, idempotent, database-reserved and subject to per-payout and daily limits.
- Provider-pending and ambiguous requests remain reserved. A new transfer must not be submitted just because the first request has not yet returned a chain hash.
- A request is only labelled confirmed after independent verification of the solidified TRON transaction, exact sender/recipient/amount, official USDT contract, successful receipt and matching Transfer event.

## Important setup limitations

`TREASURY_WITHDRAWALS_ENABLED` and `TREASURY_TRX_WITHDRAWALS_ENABLED` must remain `false` until the provider account, API credential file, vault, asset mappings, policy, database and limits have been configured and reviewed. Both USDT and native TRX payout routes use the managed Fireblocks vault signer; neither route should load a blockchain private key into the app. Native TRX additionally requires the exact `FIREBLOCKS_TRX_ASSET_ID` to resolve to verified native-TRX metadata and the provider's TRX address to match the configured on-chain treasury address.

The code integration does not create a Fireblocks workspace, generate provider credentials, upload Render secret files, fund the treasury, or prove a real Mainnet payout. No live provider call was performed while implementing this branch. Start with mock-based tests, then complete a small controlled payout and independently verify it on TRON before handling meaningful value. A confirmed chain transfer does not guarantee a recipient exchange credits the deposit; exchange credit must be confirmed by the exchange's own authorized records.
