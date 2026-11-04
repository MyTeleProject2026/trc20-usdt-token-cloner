# TRON Token Studio — sponsor organization handoff

## Purpose

This runbook separates two independent funding paths in the owner workspace:

- **Personal wallet transfer:** funds come only from the exact locally unlocked wallet. The wallet must hold the real asset and any required native TRX for network fees.
- **Sponsor-funded payout:** principal and the approved fee source belong to the external sponsor organization and its Fireblocks vault. The owner's wallet provides a one-request authorization signature; it does not supply the USDT principal.

The paths must never silently fall back to one another. A personal-wallet balance is not sponsor funding, and a sponsor budget is not a spendable wallet balance.

## Roles and approval ownership

| Role | Owns the decision or action |
| --- | --- |
| Sponsor organization representative / treasurer | Approves the program, exact Mainnet USDT use, total principal commitment, limits, recipient policy and the agreement reference. |
| Sponsor Fireblocks administrator / security operator | Creates the production workspace/vault and API users, sets asset access and transaction policy, controls quorum, and funds the vault. |
| Sponsor-controlled signer | Reviews and signs the exact time-limited sponsor release and any required recipient approvals using its own secure wallet/tool. |
| Tron Token Studio owner | Authenticates to the owner console and signs each exact withdrawal request. This signature is not sponsor approval or custody authority. |
| Application/backend | Reads provider and chain state, enforces policy and reservations, records the ledger, submits only when all authorized release gates permit it, and independently verifies receipts. |

A login, wallet signature, copied reference, provider API key, or positive balance is not proof of another party's approval.

## Ordered organization handoff

### 1. Confirm the sponsor mandate

The sponsor organization's authorized representative must approve the intended use, supported network and asset, source vault/address, recipients or recipient policy, per-transfer and daily limits, total principal commitment, fee responsibility, expiry, and revocation procedure.

Record the real organization and agreement references only after the organization has approved them. The application cannot create or certify the agreement.

### 2. Establish the Fireblocks production workspace

The organization creates its own production workspace, dedicated TRON vault, and appropriate transaction policy. Enable the official TRON USDT asset and native TRX. Confirm that both asset mappings refer to the same intended TRON source address.

### 3. Issue separate provider identities

Use a dedicated least-privilege read-only Fireblocks identity for discovery and history reconciliation. Keep it separate from the transaction-submission identity. Fireblocks issues the API key and RSA authentication material; the application cannot generate valid provider credentials on the organization's behalf.

Keep private RSA material in the organization's controlled process and mount it as a backend secret file. Do not put secrets in frontend variables, browser storage, GitHub source, SQL records, logs, screenshots or chat.

### 4. Discover, then independently select the vault

The backend can read vault accounts, asset metadata and provider addresses after valid read-only credentials exist. It can propose an unambiguous candidate, but it does not select or activate a source automatically. The sponsor administrator must independently verify the vault ID, official USDT asset ID, native TRX asset ID, network, address and Fireblocks transaction policy.

### 5. Complete backend configuration

The current code reads provider credentials, selected vault/asset identifiers, sponsor agreement references, caps, recipient policy and release switches from backend configuration. Do not place any of these in frontend `VITE_*` settings.

The current PostgreSQL ledger is used for withdrawal reservations, fee reservations, sponsor commitment accounting, reconciliation snapshots and audit history. It is not presently a general-purpose secret/configuration vault, and this branch does not automatically move all backend configuration from environment settings into database records. Provider credentials must remain backend-only secrets.

The UI can display and refresh values already provided by the backend and can discover provider metadata. It must not manufacture missing organization references, limits, API keys, secret files, vaults, approval signatures or balances.

### 6. Fund and reconcile the vault

The sponsor's treasury team funds the approved TRON vault with genuine official Tether USDT and sufficient native TRX for the agreed fee reserve. Independently compare Fireblocks available balances with public TRON on-chain balances. Complete a fresh full outbound-history reconciliation and resolve unmatched outflows and fees before treating the remaining sponsor budget as reliable.

A fee sponsor or a positive fee balance does not supply the USDT principal.

### 7. Approve scope and release

The sponsor-controlled signer reviews the canonical, time-limited release message. It must bind the exact organization/agreement references, source vault, source address, network, official USDT contract, TRX fee asset, commitment and limits, recipient-policy hash and expiry. Sponsor signatures must come from the independently configured sponsor signer set, not the owner address.

Recipient changes require the sponsor-controlled approval path. A static allowlist or signed recipient approval is policy evidence; it is not a transfer instruction.

### 8. Per-request owner authorization and settlement

For each request, the owner signs a unique message bound to the exact recipient, amount, source treasury, app origin, expiry and idempotency key. The backend reserves principal and fee capacity atomically, asks the managed signer to submit only within the approved Fireblocks policy, and reconciles ambiguous outcomes without creating duplicate transfers.

Show the following states separately:

- provider accepted / pending;
- successful solidified TRON receipt, with exact sender, recipient, official contract, amount and Transfer event verified;
- exchange deposit credit unverified;
- exchange credited only after an authoritative record from the receiving exchange confirms it.

A transaction ID alone is not proof of an exchange deposit credit or of withdrawal/trading availability at the exchange.

## Configuration source map

| Information | Source and refresh behavior |
| --- | --- |
| Fireblocks vaults, assets and addresses | Read-only provider discovery after sponsor-issued backend credentials are available. |
| TRON address/token balances | Independent Mainnet chain reads. |
| Pending and completed withdrawals, fee/principal reservations and reconciliation | Persistent application PostgreSQL ledger, when the configured database is reachable. |
| Sponsor organization/agreement references, caps and recipient policy | Backend configuration in the current implementation; these values are not invented or automatically inferred from a balance. |
| Fireblocks API keys and RSA authentication files | Sponsor-issued backend secrets, never frontend or ordinary database configuration. |
| Sponsor approval and release signature | Independent sponsor-controlled signer; not created by a platform owner login. |

The owner console periodically refreshes backend readiness and the read-only Fireblocks snapshots. A refreshed display is an observation, not a spending authorization.

## Third-party source consent and incoming deposit verification

The owner console includes **ThirdPartyFundingPanel** under the Fireblocks sponsor-funding screen. Use it only after a real organization has executed the relevant funding/disbursement agreement and the production Fireblocks vault has been independently selected.

1. Have the sponsor prepare the consent manifest using the CLI scripts `funding:agreement:hash` and `funding:authorization:message`. Hash the exact executed agreement document locally; do not upload the confidential agreement to the application.
2. The sponsor-controlled source wallet reviews and signs the canonical consent message. The manifest binds the sponsor address, exact TRON Mainnet vault address, official USDT contract, authorized USDT/TRX funding limits, agreement reference, document SHA-256 and expiry.
3. In **Wallet Vault → Sponsor payouts → Third-party source authorization**, review the agreement and explicit withdrawal-disbursement acknowledgement, then register the signed manifest. The owner console uses its existing signed Mainnet owner session; it never asks for the sponsor's private key.
4. The sponsor sends a genuine incoming USDT transfer (and, separately, native TRX for fees) from the authorized source wallet to the exact Fireblocks TRON vault address. Enter the transaction ID into the panel. The backend checks the confirmed transaction, successful solidified receipt, sender, destination, exact official token/contract and exact base-unit amount.
5. Reconcile the recorded incoming deposit against a fresh verified Fireblocks inventory snapshot for the same vault/address. The provider-available asset and chain balance must cover the deposit. Only then is the deposit counted as **verified third-party principal**.
6. Review the authorization and deposit ledger. Revoke an authorization if it must no longer accept/use funds. Expiry blocks new deposits; it does not erase a deposit that was confirmed before expiry. Explicit revocation removes that authorization's principal from eligible funding.

**Important:** A signed source consent authorizes only the bounded incoming deposit described in the manifest. It is not the later sponsor release signature, is not an owner withdrawal signature, and does not authorize a payout. The outgoing path separately requires the approved sponsor mandate/scope, sponsor-signed release, recipient approval, owner per-request signature, funding/fee checks, reservation accounting and successful receipt verification.

The payout readiness API now reports verified third-party USDT principal, reviewed authorization/deposit counts, committed withdrawals and remaining sponsor principal. The capacity calculation is capped by that remaining verified deposit principal. If the source consent, incoming receipt, Fireblocks match or outbound-history reconciliation is absent, third-party principal is unavailable and payout readiness remains blocked.

## Requested 100,000 USDT target — funding and balance semantics

The requested **100,000 USDT** is a sponsor-funding target only. It is not a balance that Tron Token Studio can mint, manufacture, credit to a Fireblocks vault, or make withdrawable through a database row or configuration value.

Keep these amounts separate in the backend and owner console:

- **Sponsor commitment:** the amount the authorized organization has contractually approved. A 100,000 USDT commitment is a ceiling/obligation, not proof that funds have arrived.
- **Verified on-chain balance:** genuine official Tether USDT held at the sponsor's exact approved TRON Mainnet vault address, read from the chain.
- **Fireblocks available balance:** the amount the sponsor's provider reports as available for the selected vault and official TRON USDT asset, after provider-side holds and pending activity.
- **Reserved / unsettled principal:** amounts already reserved by open requests or unresolved transfers; these must not be offered a second time.
- **Withdrawable amount:** the conservative amount remaining after comparing live provider availability with confirmed on-chain funds, subtracting outstanding reservations, and applying the sponsor's remaining commitment, per-request limit and daily limit.

The backend may automatically refresh the provider inventory and Mainnet chain observations after the sponsor has provisioned valid read-only credentials and the vault/asset mapping has been independently approved. It must record observation timestamps and source identifiers, and treat stale, mismatched, unavailable or incomplete evidence as **not ready**.

If the sponsor has not transferred funds, the verified balance and withdrawable amount are **0 USDT**, even when the agreement says 100,000 USDT. The app must never write the 100,000 target into an asset balance, fabricate a token transfer, or display a simulated/non-spendable token as genuine Tether USDT. The sponsor must actually fund the approved vault with genuine USDT on the official TRON Mainnet contract. The UI should display any difference as an **unfunded commitment gap**, not as available assets.

A positive USDT balance alone is also insufficient: native TRX fee reserves, sponsor release authorization, database reservations, recipient policy, Fireblocks transaction policy and receipt reconciliation must all pass before any production payout can be considered.

### Readiness API balance fields

The owner-only `GET /api/treasury/withdrawals/readiness` response now distinguishes:
- `treasuryUsdtBalanceBaseUnits`: the real official-USDT balance read from TRON Mainnet.
- `providerAvailableUsdtBaseUnits`: Fireblocks' available balance for the selected vault asset.
- `outstandingUsdtReservationBaseUnits`: unsettled requests still reserved in the PostgreSQL ledger.
- `availableUsdtAfterReservationsBaseUnits`: the lower verified provider/chain balance after those reservations.
- `sponsorPrincipalBudget.remainingBaseUnits`: the unused part of the sponsor commitment after application and external outflows.
- `dailyUsdtRemainingBaseUnits` and `maximumSinglePayoutBaseUnits`: remaining policy limits.
- `estimatedEligiblePayoutCapacityBaseUnits`: the minimum of the above funded and policy-adjusted amounts, before the independent release gate.
- `currentlyWithdrawableBaseUnits`: the amount the app is actually permitted to submit. This is zero while the immutable source-build release lock is closed.

The owner console refreshes read-only backend status on a 30-second visible-tab interval, on focus/visibility return, and through its manual **Refresh backend configuration now** action. A missing, stale or invalid amount is shown as unavailable, not silently treated as zero evidence or as a successful balance check. The displayed 100,000 USDT target is a planning target only; it is not injected into the Fireblocks balance, sponsor commitment or database ledger.

## Current source-build release status

The Mainnet real-value withdrawal route remains blocked by the source-level constant `REAL_VALUE_PAYOUT_EXECUTION_DISABLED = true`. Setting environment variables, inserting rows in PostgreSQL, discovering a vault, or obtaining a provider response cannot override this lock. It must remain closed until the sponsor mandate, real funded Mainnet vault, provider transaction controls, full accounting reconciliation and independent security review have been completed.

This build's personal-wallet transfer page is also a review-only flow: signing and broadcast are disabled. No testnet balance or simulated token is a Mainnet exchange deposit.

## Security and honesty rules

- Never represent a fake, simulated, restricted or non-spendable token as official Tether USDT.
- Never hide token restrictions from a receiving platform or account holder.
- Never infer sponsor consent, authority or available principal from a wallet login, a configuration field or a provider credential.
- Never bypass provider transaction policy, recipient approval, budget reservations, idempotency or receipt verification.
- Never request or paste passwords, API secrets, RSA private keys, wallet private keys or seed phrases into this UI or chat.
