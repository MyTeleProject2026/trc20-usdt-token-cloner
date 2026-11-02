# Owner-only treasury payout setup

This guide describes the single-owner authorization gate and points to the current managed signing integration. It is not a way to create or mint USDT.

## Owner identity

The private console uses the existing single-owner wallet-auth challenge/session. Configure `OWNER_WALLET_ADDRESS` and `TREASURY_OWNER_ADDRESS` to the same owner-controlled Mainnet address, and configure the password hash as described in the owner-auth documentation. A wallet identity session alone does not authorize a payout: each payout request must also include a fresh owner signature tied to the exact recipient, amount, treasury, app origin and idempotency reference.

Never share passwords, API credentials, secret files, private keys or recovery phrases in chat, source control, APK resources, or logs.

## Automatic backend configuration loading

The owner console reads non-secret configuration values from the backend; the browser is not the source of truth for Fireblocks settings. When the owner session is restored, the frontend automatically reloads the latest owner funding snapshot, Fireblocks inventory snapshot and live USDT payout-readiness response every 30 seconds, when the tab becomes visible, and when the app regains focus. In **Organization payouts → Fireblocks treasury setup**, the **Refresh backend configuration now** action requests an immediate reload.

The UI displays only values already present in the backend, including public treasury address, Fireblocks vault/asset identifiers from inventory evidence, provider/chain balances, agreement-scope status, sponsor-budget status and missing-configuration reason codes. It does not ask the owner to type environment variables and it does not write to Render.

This does not generate or provision credentials or legal/financial facts. The following must come from the sponsor organization and Fireblocks:
- Fireblocks workspace approval, API-user ID and RSA-4096 API private-key file.
- The sponsor-owned production vault and enabled TRON USDT/native-TRX assets.
- Real sponsor organization/agreement references, executed commitment, payout/daily limits, fee reserve and independent sponsor signer addresses.
- Fireblocks transaction policies/approval quorum and actual funded USDT/TRX balances.

If any item is absent, the frontend reports backend-reported missing prerequisites and keeps payout submission disabled. It must not invent defaults, choose between multiple sponsor vaults, generate fake agreements, or enable a release switch. Never enter a Fireblocks API key or RSA private key in the frontend.

## Using the frontend for a sponsor-funded withdrawal

The production UI path is **Wallet Vault → Organization payouts**. It is only usable after the latest implementation is merged and deployed and every sponsor/Fireblocks prerequisite has passed.

1. Sign in to the private owner workspace and unlock the exact owner wallet whose address matches the configured owner identity. Open **Organization payouts**. The owner wallet proves identity and signs the one-request authorization message; it does not fund the USDT principal.
2. Under **Owner treasury funding check**, press **Sign owner check & read treasury**. This signs a short identity challenge locally, verifies the owner against the backend and reads the real Mainnet treasury balances. The latest backend readiness and inventory state load automatically; use **Refresh backend configuration now** for an immediate reload.
3. Check that the backend confirms the official TRON Mainnet USDT contract, matching Fireblocks/chain treasury address, available Fireblocks USDT, on-chain USDT, available TRX fee reserve, database readiness, sponsor agreement scope, principal commitment and remaining budget.
4. Under **Mainnet USDT execution release authorization**, press **Prepare sponsor release message**. An authorized sponsor signer must inspect the complete message and sign it in the sponsor-controlled wallet. Paste only the public message signature and press **Verify & store sponsor release**. The backend recovers the signer and checks it against the sponsor's independent signer allowlist.
5. Under **Sponsor-approved external destination**, create a request using the exact recipient TRON address and a reason, unless that address is already on the sponsor's static allowlist. Copy the canonical approval message; the sponsor signs it; paste only the public signature and submit it. This authorizes the recipient policy only, not a transfer.
6. In **Submit a sponsor-funded Mainnet USDT withdrawal**, enter the exchange's TRON (TRC-20) USDT deposit address or the destination wallet address and the amount. Check the receiving exchange's network, address and minimum-deposit instructions first. Type `SEND USDT`, then press **Sign & submit sponsor-funded USDT payout**. The unlocked owner wallet signs a short-lived message bound to this exact amount, destination, treasury and idempotency key. Fireblocks remains responsible for custody signing and its own transaction policy approvals.
7. Use **Verify receipt & look up saved status** to reconcile the request. Never submit a second request while the first is pending or ambiguous. Confirmation requires the successful solidified TRON receipt and matching official USDT Transfer event. A successful chain transfer does not prove that the receiving exchange credited the deposit; check the exchange's own deposit history separately.

If the payout form is disabled, read the exact backend-reported blockers in the same panel. Do not use the ordinary local-wallet **Send** panel as a workaround and do not create a replacement request for an ambiguous transaction. The owner's wallet does not pay the sponsor's USDT principal or treasury TRX fee.

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

The Mainnet USDT route requires `TREASURY_WITHDRAWALS_ENABLED=true` and `TREASURY_REAL_VALUE_EXECUTION_ENABLED=true` as two necessary backend switches, plus a valid, unexpired sponsor release signature over the exact current configuration and every live readiness check. These are not instructions to enable the switches before the actual sponsor organization approves the release. Native TRX payout submission remains hard-disabled; keep `TREASURY_TRX_WITHDRAWALS_ENABLED=false`. Both routes use the managed Fireblocks vault signer; neither route should load a blockchain private key into the app. `FIREBLOCKS_TRX_ASSET_ID` is required for USDT fee-reserve verification; its metadata must identify native TRX, and its provider address must match the configured on-chain treasury address. USDT readiness and submission reserve fee capacity across unresolved USDT/TRX payouts.

The code integration does not create a Fireblocks workspace, generate provider credentials, upload Render secret files, fund the treasury, or prove a real Mainnet payout. No live provider call was performed while implementing this branch. Start with mock-based tests, then complete a small controlled payout and independently verify it on TRON before handling meaningful value. A confirmed chain transfer does not guarantee a recipient exchange credits the deposit; exchange credit must be confirmed by the exchange's own authorized records.
