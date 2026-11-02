# Owner-only treasury payout setup

This guide describes the single-owner authorization gate and points to the current managed signing integration. It is not a way to create or mint USDT.

## Owner identity

The private console uses the existing single-owner wallet-auth challenge/session. Configure `OWNER_WALLET_ADDRESS` and `TREASURY_OWNER_ADDRESS` to the same owner-controlled Mainnet address, and configure the password hash as described in the owner-auth documentation. A wallet identity session alone does not authorize a payout: each payout request must also include a fresh owner signature tied to the exact recipient, amount, treasury, app origin and idempotency reference.

Never share passwords, API credentials, secret files, private keys or recovery phrases in chat, source control, APK resources, or logs.

## Automatic backend configuration loading

The owner console reads non-secret values from the backend; the browser is not the source of truth for Fireblocks configuration. After the authenticated owner session is restored, the frontend automatically reloads the latest owner funding snapshot, Fireblocks inventory snapshot, and live USDT payout-readiness response every 60 seconds. The **Organization payouts → Fireblocks treasury setup → Refresh backend configuration now** action requests the same server-owned status immediately.

The UI shows the actual values already returned by the backend, including the public treasury address, Fireblocks vault/asset identifiers from a verified inventory snapshot, provider/chain balances, agreement-scope status, sponsor budget status, and missing-configuration reason codes. It does not ask the owner to type environment variables, and it does not write to Render.

This does not generate or provision credentials or legal/financial facts. The following must come from the sponsor organization and Fireblocks:
- Fireblocks workspace approval, API-user ID and RSA-4096 API private-key file.
- The sponsor-owned production vault and enabled TRON USDT/native-TRX assets.
- The real sponsor organization/agreement references, executed commitment, per-payout and daily limits, fee reserve and independent sponsor signer addresses.
- Fireblocks policy and approval quorum, and actual funded USDT/TRX balances.

If these items are absent, the frontend reports the backend's missing prerequisites and keeps payout submission disabled. It must not invent defaults, choose among multiple sponsor vaults, generate fake agreements, or turn a feature flag on. Never enter a Fireblocks API key or RSA private key into the frontend.

## Using the frontend for a sponsor-funded withdrawal

The production UI flow is **Wallet Vault → Organization payouts**. It is only usable after the current backend build is deployed and all sponsor/Fireblocks prerequisites have passed.

1. Sign in to the private owner workspace and unlock the exact owner wallet whose address matches the configured owner identity. Open **Organization payouts**. The owner wallet is used to prove identity and sign the one-request authorization message; its USDT balance does not fund the payout.
2. In **Owner treasury funding check**, press **Sign owner check & read treasury**. This establishes the owner session and obtains a fresh public-chain funding snapshot. The same owner session loads backend readiness and the saved Fireblocks inventory status automatically. Use **Refresh backend configuration now** to request an immediate reload; otherwise the owner console refreshes automatically while the session is active.
3. Confirm that the backend reports the official TRON Mainnet USDT contract, matching Fireblocks/chain treasury address, provider-available USDT, on-chain USDT, provider/chain TRX fee capacity, database readiness, sponsor agreement scope, commitment cap and available principal budget.
4. Under **Mainnet USDT execution release authorization**, press **Prepare sponsor release message**. The sponsor organization's authorized signer must inspect the complete message and sign it in the sponsor-controlled TRON wallet. Paste only that public message signature and press **Verify & store sponsor release**. The backend recovers the signer and checks it against the configured sponsor signer list. Never paste a seed phrase, private key, Fireblocks RSA key or API secret.
5. Add an external recipient under **Sponsor-approved external destination** unless that address is already on the sponsor's configured static recipient allowlist. Create the request with the exact TRON address and reason; copy the canonical sponsor approval message; the sponsor signs it; submit the public signature. A destination approval is not a transfer instruction.
6. In the **Submit a sponsor-funded Mainnet USDT withdrawal** form, enter the exchange's TRON (TRC-20) USDT deposit address or the destination wallet address, then enter the amount. Check the exchange's deposit network and minimum-deposit instructions before using an exchange address. Type `SEND USDT`, then press **Sign & submit sponsor-funded USDT payout**. The unlocked owner wallet signs a short-lived message bound to the exact amount, destination, treasury and idempotency key. Fireblocks remains responsible for vault signing and its own policy approvals.
7. After submission, use **Verify receipt & look up saved status**. Do not submit a second request while the first is pending or ambiguous. The request is only confirmed after the backend verifies the solidified TRON receipt and matching official USDT Transfer event. For an exchange deposit, separately check the receiving exchange's deposit history; a successful TRON transfer does not prove the exchange has credited the account.

If the form is disabled, read the exact blocker list in the same panel. Do not bypass a blocker or send from the ordinary local-wallet **Send** panel as a workaround. The application must not substitute the owner's empty wallet or fabricate sponsor funds.

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
