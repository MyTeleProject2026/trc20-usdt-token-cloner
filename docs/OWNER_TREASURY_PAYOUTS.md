# Owner-only treasury payout setup

This guide describes the single-owner authorization gate and points to the current managed signing integration. It is not a way to create or mint USDT.

## Owner identity

The private console uses the existing single-owner wallet-auth challenge/session. Configure `OWNER_WALLET_ADDRESS` and `TREASURY_OWNER_ADDRESS` to the same owner-controlled Mainnet address, and configure the password hash as described in the owner-auth documentation. A wallet identity session alone does not authorize a payout: each payout request must also include a fresh owner signature tied to the exact recipient, amount, treasury, app origin and idempotency reference.

Never share passwords, API credentials, secret files, private keys or recovery phrases in chat, source control, APK resources, or logs.

## Automatic backend refresh and funding capacity

After an authenticated owner session is restored, the console reloads the owner funding snapshot, Mainnet payout readiness, Fireblocks inventory/discovery and outbound-history status. It refreshes every 30 seconds while the tab is visible, when the app regains focus or becomes visible, and through **Refresh backend configuration now**. These are read-only requests; they do not modify Render settings or create sponsor credentials.

Live Fireblocks vault balances, asset metadata and address checks use the separate `FIREBLOCKS_READONLY_API_KEY` and `FIREBLOCKS_READONLY_SECRET_KEY_PATH` Viewer identity. Monitoring can therefore work before a transaction-capable payout API identity is issued. The payout identity remains a separate credential pair and is used only by the guarded transaction path/provider transaction handling; it is never substituted by the Viewer key.

The sponsor panel distinguishes the requested **100,000 USDT planning target** from the real on-chain balance, Fireblocks-available balance, pending reservations, remaining sponsor commitment, daily allowance, estimated eligible capacity and currently withdrawable amount. The target never populates any asset balance. The backend computes available-after-reservations from the lower provider/chain observation and subtracts open payout reservations. It then caps estimated capacity by the remaining sponsor commitment, daily allowance and per-payout maximum.

The backend returns **0 currently withdrawable** while the immutable source-build real-value execution lock is closed, even when read-only funding evidence shows a positive balance. A positive balance or a sponsor agreement does not independently authorize a transfer. Missing or stale provider, chain, database, budget or reconciliation evidence keeps the capacity unavailable.


## Third-party sponsor funding ledger

Before the owner console can report sponsor principal as eligible, the sponsor must register a signed source-wallet consent and a SHA-256 fingerprint of the executed agreement. The consent binds the source address, exact Fireblocks Mainnet vault address, official TRON USDT contract, authorized amount caps and expiry. The owner console records that the written agreement and disbursement scope were reviewed; this acknowledgement is an application record, not a substitute for the sponsor's legal authority.

The sponsor then sends the genuine incoming token transfer. The backend verifies the sender, destination, official token contract, exact transfer calldata, matching Transfer event, solidified successful receipt and amount cap. A later inventory snapshot must show the same token in the same configured Fireblocks vault and must post-date the chain confirmation.

The verified third-party pool is reduced by all application withdrawal reservations/committed withdrawals and reconciled external Fireblocks USDT outflows. Both the read-only readiness endpoint and the future POST reservation logic cap the request amount by this remaining principal. The source consent does not authorize an outgoing payout; outgoing requests still require the separately signed sponsor release and owner/recipient policies.

Authorization expiry blocks new deposits, but a deposit already confirmed before expiry remains in the verified pool until the authorization is explicitly revoked or its evidence is invalidated. Revocation takes the same database advisory lock as payout reservations, preventing it from racing a new reservation. Never edit ledger rows directly to manufacture sponsor principal.

## Managed signer

The USDT payout route on this feature branch uses the Fireblocks production REST API. Fireblocks holds the vault transaction signing authority; Tron Token Studio sends a bounded transaction request using server-only API credentials. The Fireblocks API authentication RSA key is mounted as a backend secret file; it is not a blockchain private key, and it is never sent to the frontend.

See [FIREBLOCKS_ORGANIZATION_VAULT_SETUP.md](FIREBLOCKS_ORGANIZATION_VAULT_SETUP.md) for the organization onboarding, dedicated TRON vault, USDT/TRX asset validation, RSA-4096 API-user, Render secret-file, and read-only readiness sequence.

See [TREASURY_WITHDRAWALS.md](TREASURY_WITHDRAWALS.md) for the exact API endpoints, environment variables, provider policy requirements, and reconciliation rules.

Required safeguards include:
- The provider's configured vault account and asset ID must identify the actual official TRON USDT contract.
- The provider must return exactly one configured TRON address matching `TREASURY_ADDRESS`.
- Provider-available balance and public on-chain balance must both cover the requested amount after reservations.
- The public chain and provider-available TRX balances must cover one maximum fee cap for each unresolved USDT/TRX payout plus the new request; no automatic fee sponsorship is presumed.
- Provider transaction policy must enforce approved source, asset, recipient rules, and required approvals. The app does not bypass provider review.
- Each request is owner-signed, idempotent, database-reserved and subject to per-payout and daily limits.
- Provider-pending and ambiguous requests remain reserved. A new transfer must not be submitted just because the first request has not yet returned a chain hash.
- A request is only labelled confirmed after independent verification of the solidified TRON transaction, exact sender/recipient/amount, official USDT contract, successful receipt and matching Transfer event.

## Important setup limitations

`TREASURY_WITHDRAWALS_ENABLED` and `TREASURY_TRX_WITHDRAWALS_ENABLED` must remain `false` until the provider account, API credential file, vault, asset mappings, policy, database and limits have been configured and reviewed. Both USDT and native TRX payout routes use the managed Fireblocks vault signer; neither route should load a blockchain private key into the app. `FIREBLOCKS_TRX_ASSET_ID` is required for both routes so provider-available TRX can be independently verified; its metadata must identify native TRX, and its provider address must match the configured on-chain treasury address. USDT readiness and submission reserve fee capacity across unresolved USDT and TRX payouts.

The code integration does not create a Fireblocks workspace, generate provider credentials, upload Render secret files, fund the treasury, or prove a real Mainnet payout. No live provider call was performed while implementing this branch. Start with mock-based tests, then complete a small controlled payout and independently verify it on TRON before handling meaningful value. A confirmed chain transfer does not guarantee a recipient exchange credits the deposit; exchange credit must be confirmed by the exchange's own authorized records.
