# Sponsor on-chain balance status

## Endpoint

`GET /api/tron/sponsorship/funding-status?network=mainnet|shasta|nile`

The endpoint performs read-only queries against the selected Tatum TRON Solidity gateway. It reports the configured sponsor wallet's native TRX balance and, where the server has a reviewed network-specific contract list, the balance of those exact TRC-20 contracts. Token balances are returned as integer base units with the contract address and decimals. A failed token query is marked unavailable and is never converted into a zero balance.

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
