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

The UI can display and refresh values already provided by the backend and can discover provider metadata. The owner handoff page now provides direct jump links to provider discovery, inventory evidence, history reconciliation, sponsor release authorization and the payout request. These controls only navigate to existing sections; they do not create or approve external resources. It must not manufacture missing organization references, limits, API keys, secret files, vaults, approval signatures or balances.

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

## Current source-build release status

The Mainnet real-value withdrawal route remains blocked by the source-level constant `REAL_VALUE_PAYOUT_EXECUTION_DISABLED = true`. Setting environment variables, inserting rows in PostgreSQL, discovering a vault, or obtaining a provider response cannot override this lock. It must remain closed until the sponsor mandate, real funded Mainnet vault, provider transaction controls, full accounting reconciliation and independent security review have been completed.

This build's personal-wallet transfer page is also a review-only flow: signing and broadcast are disabled. No testnet balance or simulated token is a Mainnet exchange deposit.

## Security and honesty rules

- Never represent a fake, simulated, restricted or non-spendable token as official Tether USDT.
- Never hide token restrictions from a receiving platform or account holder.
- Never infer sponsor consent, authority or available principal from a wallet login, a configuration field or a provider credential.
- Never bypass provider transaction policy, recipient approval, budget reservations, idempotency or receipt verification.
- Never request or paste passwords, API secrets, RSA private keys, wallet private keys or seed phrases into this UI or chat.


## Owner-console navigation update

The owner dashboard presents two separate routes:

- **Personal wallet transfer:** review-only; the source is the currently unlocked local wallet and no sponsor funds are used.
- **Sponsor-funded payout:** a separate organization-owned vault and approval path; the personal wallet can sign a request but cannot supply the sponsor principal.

On the Organization payouts page, the handoff list is ordered and the jump controls take the operator to provider discovery, saved inventory, outbound-history reconciliation, sponsor release and the payout request. The interface refreshes backend/provider evidence automatically, but a UI status is not an independent sponsor mandate or permission to spend.

The website does not accept Fireblocks API secrets or RSA private keys. Provider bootstrap remains a sponsor-admin task through a secured backend secret-management process. The current implementation does not support moving all provider secrets and sponsor policy configuration into PostgreSQL, and the UI must not claim that it does.
