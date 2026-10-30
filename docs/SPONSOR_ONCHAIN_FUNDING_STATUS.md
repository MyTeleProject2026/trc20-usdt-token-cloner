# Sponsor on-chain balance status — Tether Mainnet only

## Read-only funding endpoint

`GET /api/tron/sponsorship/funding-status?network=mainnet|shasta|nile`

The endpoint reads the configured sponsor address's native TRX balance from the selected network's solidified TRON state. It also reads an official Tether USDT balance only on Mainnet, pinned in backend code to:

- Network: TRON Mainnet
- Contract: `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`
- Decimals: `6`

On Nile and Shasta the funding endpoint reports native TRX only. It ignores token-contract allowlist variables on testnets. A testnet token is not official Tether USDT and cannot be used as payout principal.

Successful solidified snapshots cache for up to ten seconds. Failed token queries are marked unavailable and are never converted to a zero balance.

This endpoint is read-only. It never signs, submits, or broadcasts a transaction. It always reports `sponsorFundingVerified: false`, `canSubmitSponsoredTransfer: false`, and `submissionEnabled: false` until separate approval and transaction controls are completed. A balance snapshot is not consent or spending authority.

## Backend environment

Configure values only on the backend:

- `SPONSOR_MAINNET_ADDRESS`: authorized organization Mainnet Tether treasury or principal sponsor address to monitor.
- `SPONSOR_FEE_MAINNET_ADDRESS`: separate Mainnet fee/resource sponsor address where applicable.
- `SPONSOR_ASSET_MAINNET_ADDRESS`: Mainnet asset-principal sponsor address; this must be the organization-approved Tether treasury.
- `SPONSOR_SHASTA_ADDRESS`, `SPONSOR_NILE_ADDRESS` and corresponding fee/asset role addresses: test-only TRX resource diagnostics, not token payout principal.
- `TATUM_API_KEY`: backend-only read API credential.

Do not configure `SPONSOR_USDT_NILE_CONTRACTS`, `SPONSOR_USDT_SHASTA_CONTRACTS`, or VTRC token lists. The backend ignores testnet token allowlists. Mainnet official USDT is pinned in source code; a Render variable cannot redefine its contract.

The funding reader validates the address returned by the Solidity gateway against the requested sponsor address. The API key is sent only in a server-side header and is never returned in JSON.

## Readiness interpretation

- `sponsor-address-not-configured`: no monitoring address configured for that network.
- `provider-credentials-missing`: the read API credential is missing.
- `solidified-sponsor-balances-read`: native TRX was read; on Mainnet the exact official USDT contract is also checked.
- `solidified-balance-read-failed`: chain state could not be verified. Treat it as unknown, not zero.
- A missing or failed Mainnet USDT read is not evidence that the treasury has no USDT; it is an unavailable observation.

This view does not measure an approved budget or authorize a transfer. Operators must reconcile the Mainnet USDT principal separately from TRX fee/resource limits.

## Sponsor budget rules

Protected budget endpoints require `Authorization: Bearer <SPONSOR_ADMIN_API_TOKEN>`. That credential is server-only, belongs to the sponsoring organization, and must be held by its appointed administrator. Never expose it to the browser, a frontend environment variable, GitHub, or chat.

The sponsor budget API accepts:
- `purpose: "network-fee"` with `asset: "TRX"` for fee/resource limits;
- `purpose: "asset-grant"` only with `asset: "USDT"`, network `mainnet`, and the exact official contract above.

It rejects VTRC, testnet USDT-like contracts, and native TRX asset-grant principal. The PostgreSQL schema retains old historical rows for compatibility, but runtime policy will not create new VTRC or testnet-token budgets.

A new budget draft is always `pending-review`. It is not an activated budget, funding proof, or transfer authorization. Mainnet budget activation remains separately gated and cannot enable payout submission.

## Testnet reservation boundary

`POST /api/tron/sponsorship/transfers/reserve` is a testnet-only fee-resource reservation route. It accepts Nile/Shasta `network-fee` reservations for native TRX only. It rejects USDT/VTRC principal grants.

The endpoint does not use the end user's wallet balance, and it does not send Tether. Its response represents only an internal reservation. Testnet TRX and testnet token balances have no Mainnet monetary value.

## Mainnet Tether payout requests

The owner wallet UI submits an owner-signed request for organization review:

- `POST /api/treasury/payout-requests`
- `GET /api/treasury/payout-requests/:idempotencyKey`
- `GET /api/treasury/payout-requests?limit=50` (separate `TREASURY_PAYOUT_REVIEW_API_TOKEN`, read-only)

The asset, network, contract and decimals are fixed by backend code. A stored request is `pending-organization-review`; it is not an approval, budget reservation, Fireblocks instruction, transaction ID, or transfer. The review token is different from `SPONSOR_ADMIN_API_TOKEN` and cannot approve or execute payouts.

## Current production gate

The production payout routes still contain the immutable server-side execution gate:

`REAL_VALUE_PAYOUT_EXECUTION_DISABLED = true`

Keep `TREASURY_WITHDRAWALS_ENABLED=false` and `TREASURY_TRX_WITHDRAWALS_ENABLED=false`. The code does not currently submit a genuine Mainnet USDT transfer. External organization approval, Fireblocks production vault authorization and funding, security review and a separately approved release are still outstanding.

A future production path must verify the exact solidified Mainnet Tether Transfer event and reconcile actual USDT principal and TRX costs. An on-chain transfer is not an exchange credit; the receiving exchange's own deposit record is required.
