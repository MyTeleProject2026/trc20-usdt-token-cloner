# Sponsor on-chain balance status

## Endpoint

`GET /api/tron/sponsorship/funding-status?network=mainnet|shasta|nile`

The endpoint performs read-only queries against the selected Tatum TRON Solidity gateway. It reports the configured sponsor wallet's native TRX balance and, where the server has a reviewed network-specific contract list, the balance of those exact TRC-20 contracts. Token balances are returned as integer base units with the contract address and decimals. A failed token query is marked unavailable and is never converted into a zero balance.

Successful solidified balance snapshots are cached for up to 10 seconds per network, and simultaneous reads for the same network share one in-flight provider request. The response labels a cached snapshot and its age so the UI can distinguish reused data from a fresh read.

The endpoint does not sign, submit, or broadcast transactions. It deliberately returns `sponsorFundingVerified: false`, `canSubmitSponsoredTransfer: false`, and `submissionEnabled: false` even after a chain balance has been read. A public chain balance snapshot is not evidence of the sponsor's consent, control of a signing authority, availability of a separate approved budget, or permission to spend those assets.

## Backend environment

Set these values only in the backend's server environment:

- `SPONSOR_MAINNET_ADDRESS`, `SPONSOR_SHASTA_ADDRESS`, `SPONSOR_NILE_ADDRESS`: the public sponsor address intended to be monitored on each exact network.
- `TATUM_API_KEY`: backend-only read API key for the Tatum TRON Solidity gateways.
- `SPONSOR_USDT_SHASTA_CONTRACTS`, `SPONSOR_USDT_NILE_CONTRACTS`: reviewed testnet USDT-like contract addresses, comma separated. A testnet token is not official Mainnet USDT.
- `SPONSOR_VTRC_MAINNET_CONTRACTS`, `SPONSOR_VTRC_SHASTA_CONTRACTS`, `SPONSOR_VTRC_NILE_CONTRACTS`: reviewed VTRC contract addresses for each network, comma separated. VTRC remains an independent project token.
- On Mainnet, the USDT query is pinned to Tether's official TRON contract in the backend; a symbol or configurable address cannot redefine official USDT.

The endpoint rejects malformed sponsor addresses, invalid networks, and malformed token allowlists. It checks the address returned by the Solidity gateway against the requested sponsor address. The API key is used only in a server-side header and is not returned in JSON.

## Readiness interpretation

- `sponsor-address-not-configured`: no wallet address is configured for that network; no chain balance was queried.
- `provider-credentials-missing`: a wallet address exists, but the read API key is missing; no balance was inferred.
- `solidified-sponsor-balances-read`: the native TRX balance was obtained from the selected network's solidified state. Each token contract has its own `verified` or `unavailable` status.
- `solidified-balance-read-failed`: the API could not verify the chain balance. Treat it as unknown, not zero.

This view does not measure the PostgreSQL sponsor budget ledger. Operators must reconcile on-chain assets against separately approved per-network, per-asset budget limits; fee resources and transfer principal must remain distinct. It also does not enable a GasFree submission: GasFree's documented activation/transfer fees are paid in the transferred token and therefore do not prove external sponsor-paid fees.

## Remaining activation gates

Before any sponsor-funded TRX or USDT transfer can be enabled, implement and independently review provider/sponsor authorization, wallet or managed signer authorization, atomic reservation against actual available budget, idempotency/replay protection, per-recipient and daily limits, a pause mechanism, failure release, finality reconciliation, audit events, and a complete Nile end-to-end test. Mainnet also requires explicit operator approval and a real sponsor agreement. No seed phrase or private key should be sent to this service.


## Protected sponsor budget ledger

The following administrative endpoints require `Authorization: Bearer <SPONSOR_ADMIN_API_TOKEN>`. Configure a random server-only token of at least 32 characters in the backend environment. Never expose it as a Vite variable or embed it in the frontend.

- `GET /api/tron/sponsorship/budgets?network=mainnet|shasta|nile` lists configured budget caps, reservations, recorded spend and ledger-available base units. It is read-only and requires the admin token.
- `POST /api/tron/sponsorship/budgets` creates a budget draft for a configured server-side sponsor address. Required JSON fields are `network`, `sponsorReference`, `purpose` (`network-fee` or `asset-grant`), `asset` (`TRX`, `USDT`, or `VTRC`), `budgetBaseUnits` (positive integer string), and `tokenContract` for token assets.

Creation always sets the row to `pending-review`; duplicate identities are rejected and audited in the same database transaction. The endpoint cannot activate, reserve, sign, submit, or broadcast a transfer. No public UI stores or sends the administrator token. The requested amount is a ledger cap, not a verified wallet balance; compare it with the read-only funding snapshot during operator review. Existing budgets are not edited by these endpoints.


## Budget emergency pause

`POST /api/tron/sponsorship/budgets/:id/pause` is protected by the same server-only administrator bearer token. It requires one controlled reason code: `operator-request`, `funding-mismatch`, `provider-incident`, or `emergency-stop`. It uses a row lock and a database transaction to change the configured budget to `paused` and record an audit event. Repeated pauses are idempotent. Depleted budgets remain terminal. A paused budget cannot be used for new reservations by the existing reservation function. Pausing cannot reverse or cancel transactions already submitted to TRON.

The funding endpoint accepts `refresh=1` to bypass a fresh successful snapshot once per 10 seconds per network. Repeated forced refreshes are throttled; successful snapshots cache for up to 10 seconds and provider failures cache for 3 seconds to avoid retry storms. Responses carrying sponsor balances or ledger details include `Cache-Control: no-store`.


## Budget activation gate

`POST /api/tron/sponsorship/budgets/:id/activate` requires the protected administrator token, a review/ticket reference, and an agreement reference that has already been placed in server-only `SPONSOR_APPROVED_AGREEMENT_REFERENCES` after an operator independently reviews the signed sponsor agreement. Merely supplying a string is not sufficient. The endpoint refreshes the exact network's chain snapshot and rejects throttled/stale reads, mismatched sponsor accounts, missing exact-asset balances, and caps that exceed the chain balance after other active/paused allocations for the same wallet/network/asset are included.

Activation is serialized at the sponsor-wallet/network/asset level with a PostgreSQL transaction and advisory lock, stores the approval/review references and timestamp, and writes an audit event. Inactive drafts do not consume an allocation until approved, but outstanding reservations on other inactive records are still included. A successful activation makes the ledger budget eligible for internal reservations only; there is still no signing or submission capability.

Mainnet activation additionally requires `SPONSOR_MAINNET_BUDGET_ACTIVATION_ENABLED=true`, which defaults to `false`. Both the allowlisted agreement reference and this separate Mainnet gate are required in addition to administrator authentication and fresh balance reconciliation. These configuration settings never turn on the GasFree submission endpoint or a transfer broadcast path.
