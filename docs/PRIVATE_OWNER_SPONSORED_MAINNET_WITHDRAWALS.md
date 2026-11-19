# Private owner-only sponsored Mainnet withdrawals

## Architecture

This feature is a direct, self-custody wallet sponsorship flow for one private platform owner. It does not use Fincra, Fireblocks, provider-owned liquidity, or a credit line.

- **Requester:** only the wallet whose address exactly matches `OWNER_WALLET_ADDRESS` may create a withdrawal request. The owner wallet is used for identity; it does not need to hold the payout USDT or TRX.
- **Sponsor:** a separate person who voluntarily applies with a self-custody TRON Mainnet wallet. The sponsor wallet is the actual sender and must already hold the full official USDT TRC20 amount plus sufficient network resources.
- **Platform owner:** reviews each sponsor application, sets the per-payout and daily limits, and can decline participation. Review is not KYC, KYB, sanctions screening, beneficial-ownership verification, or proof of source of funds.
- **Tatum:** supplies TRON Mainnet RPC, transaction broadcast, and chain verification. Tatum does not supply USDT principal or pay the sponsor's network fee.

## User-facing routes

- Private owner console: `https://tron-transfer.onrender.com/`
- Separate sponsor wallet surface: `https://tron-transfer.onrender.com/#/sponsor`

The sponsor route does not render the owner console. It only exposes the wallet-authenticated sponsor application, live funding checks, assigned request queue, and sponsor signing workflow. Withdrawal request intake remains private to the configured owner wallet.

## Mainnet withdrawal flow

The private platform enforces a **1,000 USDT minimum per withdrawal request** (1,000,000,000 base units). This is an application policy, not a provider/network minimum and not evidence of available funds or credit.

1. The owner signs in to the private console and connects the TronLink account that exactly matches `OWNER_WALLET_ADDRESS`.
2. The owner signs a short-lived wallet-identity challenge. This is a message signature, not a token transfer or spending authorization.
3. The owner enters the external TRON Mainnet recipient address and exact USDT amount. The backend accepts only the configured owner wallet for `POST /api/tron/sponsor-direct/requests`.
4. The backend stores the request and attempts a bounded match against approved sponsor wallets. Matching checks current solidified USDT, active reservations, per-payout and daily caps, and TRON fee-resource coverage. If no sponsor is currently eligible, the request remains queued and no funds move.
5. A separate sponsor connects its own Mainnet TronLink wallet at `#/sponsor`, signs a wallet-identity challenge, and applies. Contact email is optional; the route sends no email. The owner reviews the application and sets conservative limits.
6. The sponsor's own wallet is re-read against solidified Mainnet state. The backend prepares one unsigned USDT transfer bound to the exact sponsor, official token contract, recipient, amount, fee limit, and expiry.
7. The sponsor reviews the details in TronLink and explicitly signs that exact transaction. The backend validates the signed transaction against the stored intent before asking Tatum to broadcast it.
8. A broadcast acceptance is only a submitted/pending state. The reconciliation worker checks the solidified Mainnet transaction, successful receipt, and exact official Tether USDT Transfer event before marking the transfer confirmed. A transaction hash alone is not confirmation.

## Historical payout archive and minimum policy

The active `sponsor_direct_payouts` table accepts only requests at or above the 1,000 USDT application minimum. A versioned, transactional schema migration moves only below-minimum records in terminal states (`confirmed`, `failed`, `broadcast-rejected`, `cancelled`, or `expired`) into the separate `sponsor_direct_payouts_archive` table. Original request IDs, idempotency keys, requester/sponsor/recipient addresses, amounts, statuses, transaction hashes, timestamps, confirmation evidence, and reconciliation metadata are retained.

The migration fails closed before changing payout rows if any below-minimum request is still `requested`, `prepared`, `broadcasting`, `submitted`, `outcome-unknown`, or `manual-review`. Such a row must be explicitly resolved and reconciled; expiry timestamps alone do not make an unresolved transaction safe to archive. The migration verifies copied rows and the global idempotency registry before deleting any source row. It then installs and validates an unconditional active-table minimum constraint and removes the legacy `minimum_policy_blocked` bypass column.

A global idempotency registry preserves duplicate detection across active and archived records. Reusing an archived key with the same request details returns the historical request as a duplicate; changing the requester, recipient, or amount returns a conflict. History and detail APIs include archived records with `archived: true`, `archivedAt`, and `readOnly: true`. Archived records are not returned in sponsor queues, cannot be prepared or broadcast, are excluded from reservations and reconciliation, and are protected against updates and deletes at the database layer. Owner overview totals distinguish active requests from archived historical records.

## Asset and fee rules

- The token is fixed to official TRON Mainnet Tether USDT: `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`.
- The sponsor's wallet supplies the USDT principal. The platform never manufactures a balance or treats a displayed balance as authorization.
- The sponsor pays the network cost from its own available Energy/Bandwidth/TRX resources. A configured `fee_limit` is only a maximum execution-fee cap, not a fee quote or a promise that a transfer will succeed.
- Every transfer needs a new sponsor signature. There is no blanket approval to spend from an arbitrary wallet, no imported private key, and no unattended third-party spending.
- The owner wallet can remain at zero USDT and zero TRX, but a zero-balance sponsor cannot send a payout.
- A successful on-chain transfer to an exchange deposit address does not prove that the exchange credited the account. Exchange credit must be checked separately with that exchange.


## Zero-balance owner and no-sponsor operating state

The owner may submit a request with a zero-balance identity wallet. The individual sponsor application form does not require company-registration documents or a contact email. This application-level rule is not KYC/KYB, identity verification, source-of-funds verification, or a waiver of any legal/provider requirements.

When no approved sponsor profile exists, the request may be stored but cannot be funded or broadcast. When profiles do exist, they are only candidates: the backend checks each candidate's live solidified Mainnet USDT balance, reservations, limits, and network-resource coverage before matching. Every payout still requires that wallet owner's exact TronLink signature.

The owner-only endpoint `GET /api/tron/sponsor-direct/owner-overview` reports aggregate sponsor-profile and withdrawal states without exposing sponsor addresses. Its `liveSponsorFundingVerified` field is intentionally always false: profile counts are not a substitute for the per-request live balance/resource check. The endpoint distinguishes:
- `no-approved-sponsor-wallets`: there are no active individual sponsor profiles; a request can remain queued, but no payout is currently matchable.
- `live-funding-check-required`: active profiles exist, but no funds are presumed available until a request-specific Mainnet preflight succeeds.

## Why flash loans are not a withdrawal funding source

TRON's TRC-3156 flash-loan interface requires the borrowed asset plus any fee to be returned before the same transaction finishes. If the borrowed USDT is sent to an external exchange deposit address and is not returned during that transaction, the flash-loan call must revert. If it is returned, the external recipient has not received a lasting payout. Therefore this project does not treat a flash loan as free or lasting USDT principal for an ordinary external withdrawal.

Reference: [TRC-3156 Flash Loans specification discussion](https://github.com/tronprotocol/tips/issues/893). The standard interface does not itself create a lender, a funded liquidity pool, or uncollateralized credit.

## Runtime configuration

The backend requires the already-established private owner and database configuration plus a valid server-side Tatum Mainnet key:

- `OWNER_WALLET_ADDRESS`: the exact configured owner TRON Mainnet address.
- `DATABASE_URL`: durable storage for sponsor profiles, payout requests, reservations, and reconciliation.
- `TATUM_MAINNET_API_KEY` (preferred) or `TATUM_API_KEY`: server-only Tatum credential. Never put it in a `VITE_*` variable.
- CORS allowlist must include the exact deployed frontend origin, `https://tron-transfer.onrender.com`.

Optional controls:

- `SPONSOR_DIRECT_RECONCILIATION_WORKER_ENABLED=false` disables background reconciliation. When not disabled, the worker starts only if the database URL and Tatum Mainnet key are configured.
- `SPONSOR_DIRECT_RECONCILIATION_INTERVAL_MS` controls the bounded reconciliation interval.
- `SPONSOR_DIRECT_TRON_USDT_FEE_LIMIT_SUN` caps the transaction's fee limit in SUN; it is not an amount charged in advance.

Do not place API keys, passwords, wallet private keys, recovery phrases, or OTPs in GitHub files or chat. Keep them in the provider/Render secret manager.

## What deployment does not provide

Deployment does not create a sponsor, approve an application, add USDT, pay TRX, grant an organization mandate, or create a provider credit facility. The implementation can be reachable while the request queue remains empty. Real withdrawals require a willing sponsor wallet owner who has independently agreed to fund and sign the exact transfer, and the owner must make an informed review decision. Any applicable legal, regulatory, sanctions, and source-of-funds obligations remain in force; this wallet-participation workflow must not be used to evade them.

The current provider-readiness page remains a separate diagnostic: provider-managed payouts are not enabled. This sponsor-direct wallet route is the only active withdrawal submission design in this release.


## Stage 18 archive diagnostics and history lookup

The owner-authenticated `GET /api/tron/sponsor-direct/archive-migration-status` endpoint reports a read-only snapshot of the archive migration invariants: active/archive/history/registry object presence, validated active minimum constraint, active idempotency trigger, archive immutability triggers, unresolved below-minimum active rows, and registry consistency. It does not run or repair a migration. A `blocked` result means unresolved below-minimum records remain; an `incomplete` result means one or more required objects or invariants are absent.

Authenticated requester/sponsor sessions can retrieve a prior request by its globally reserved idempotency key through `GET /api/tron/sponsor-direct/requests/idempotency/:key`. The endpoint reads the active/archive history view, applies the same requester-or-sponsor access check as detail, and marks archived records read-only. It does not authorize, prepare, sign, or broadcast a payout.

The isolated PostgreSQL API regression coverage exercises archived requester history, archived detail, duplicate-key lookup, owner-only diagnostics, and denial of diagnostics to a non-owner. These endpoints are inspection surfaces only; they do not make historical records active again.
