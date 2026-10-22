# External Sponsor Only: Operating Contract

## Selected funding decision

The project owner requires sponsored operations to use **external sponsor funds only**. The platform must not charge the user, purchase a paid provider service using the user's funds, or silently fall back to a sender-funded transfer when a sponsored request cannot be fulfilled.

This is a policy decision, not evidence that a sponsor has agreed to pay. At the time of this document, no external sponsor agreement, funded sponsor account, or approved provider adapter has been verified. Therefore sponsorship remains disabled.

## Two separately funded capabilities

1. **Network-fee sponsorship** — an authorized sponsor pays eligible network/resource costs for a transaction, but only if the provider/network mechanism supports the exact operation.
2. **Sponsor-funded asset transfer** — the sponsor separately authorizes and funds the actual TRX, official TRON USDT, or project VTRC principal delivered to a receiver.

Fee funding does not provide the transfer principal. An accounting entry, sponsor budget, pending grant, or UI credit is not an on-chain balance.

## No-charge and fail-closed requirements

- Never debit the end user's wallet or charge the user for a sponsored operation.
- Never silently downgrade to an ordinary sender-funded transfer.
- If the sponsor is unavailable, paused, depleted, unauthorized, or cannot cover the whole authorized amount and fee, reject the request before broadcast.
- Never treat testnet assets as mainnet value.
- Treat VTRC as an independent project token with a separately verified, network-specific contract allowlist; never label it as official USDT.
- Require network-specific token-contract allowlists; VTRC must be labeled as an independent project token, not official USDT.
- Use atomic PostgreSQL reservations and idempotency to prevent duplicate or over-budget sponsor operations.
- Keep sponsor credentials server-side in an approved secret store. Never place keys, seed phrases, or private keys in Git, UI payloads, logs, or chat.
- Verify the final transaction and reconcile principal and fee/resource charges separately using solidified on-chain/provider evidence.
- A chain confirmation is not proof that an exchange credited a deposit.
- Normal wallet transfers cannot enforce spending restrictions after the recipient receives assets; do not promise restrictions without a reviewed escrow/vesting design.

## Activation gates

All gates are mandatory; none may be inferred from an environment variable alone.

1. A real external sponsor has agreed in writing to fund the specific network, assets, fees, limits, and operational period.
2. The sponsor account/funding or delegated resources are independently verified; a named provider's existence alone is not enough.
3. Provider terms, pricing, transaction support, network coverage, failure/refund behavior, idempotency, rate limits, and signing authority are reviewed.
4. Sponsor consent, receiver policy, server-side authorization, per-transfer limits, emergency pause, and abuse controls are enforced.
5. Budget reservation, audit events, idempotency, failure release, confirmed-spend settlement, and reconciliation are covered by integration tests.
6. End-to-end testnet tests pass for the chosen provider, then an independent security review is completed.
7. Mainnet is enabled only after explicit operator approval and a verified, funded budget. Fee coverage and asset-principal funding must be activated independently.

## Current application state

The sponsorship status is intentionally `enabled: false`, `mainnetEnabled: false`, and `canSubmitSponsoredTransfer: false`. The external-sponsor-only policy is exposed to clients, with `externalSponsorConfirmed: false`, `sponsorFundingVerified: false`, `paidProviderPurchasesAllowed: false`, and `unpaidFallbackToUserFunds: false`.

The next external dependency is a real sponsor that voluntarily funds the service. The code cannot create sponsor money, enroll a third party without authorization, or guarantee free transactions in the absence of such funding. Until the gates above are met, no sponsored transaction may be broadcast.


## VTRC implementation boundary

The pure sponsor-intent validator and sponsor ledger schema accept VTRC as a distinct asset only when a network-specific token contract is explicitly allowlisted. This is policy/schema groundwork, not a transfer adapter: no VTRC sponsor transfer is authorized, signed, broadcast, or available in production. The actual VTRC contract must be independently verified for each network before any allowlist entry is configured. No placeholder contract or token symbol is evidence of a deployed token.


## Network-scoped contract configuration

The reservation layer requires exact contract addresses before it can reserve a token grant:

- Mainnet official USDT uses the fixed contract `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`.
- Non-mainnet USDT uses `SPONSOR_USDT_SHASTA_CONTRACTS` or `SPONSOR_USDT_NILE_CONTRACTS` only after the exact token contract is verified for that network.
- VTRC uses `SPONSOR_VTRC_SHASTA_CONTRACTS`, `SPONSOR_VTRC_NILE_CONTRACTS`, or `SPONSOR_VTRC_MAINNET_CONTRACTS` only after the corresponding VTRC deployment is independently verified. Values are comma-separated exact addresses; no placeholder or symbol-only value is acceptable.
- The existing VTRC transfer UI is Shasta-only. A Mainnet allowlist entry alone does not deploy VTRC or enable a Mainnet transfer.

These variables authorize contract identity for ledger reservation only. They do not prove the sponsor owns sufficient tokens, do not enable transaction signing/broadcast, and do not override the global disabled sponsorship status.


## Separate fee and principal budgets

Sponsor budgets are keyed by sponsor, network, purpose, asset, and token contract. A `network-fee` reservation must match a separately configured `network-fee` budget; it cannot consume an `asset-grant` budget, even when both are denominated in TRX. Existing budget rows migrate as `asset-grant` by default. An external sponsor must separately approve and fund the fee/resource allocation and each asset-principal allocation.
