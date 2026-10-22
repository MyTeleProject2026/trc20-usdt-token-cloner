# GasFree provider discovery: verified scope and enablement gates

## Why this provider was selected for discovery

The official GasFree developer documentation describes a TRON TRC-20 workflow where the user authorizes a transfer with a wallet signature and a service provider submits the authorization and pays the on-chain gas costs. Its API includes provider discovery, token support/fee discovery, GasFree account lookup, submission, and status lookup.

- Official documentation: https://docs.gasfree.io/
- Official SDK repository: https://github.com/gasfreeio/gasfree-sdk-js
- TRON resource model: https://developers.tron.network/docs/bandwidth-and-energy
- TRON resource delegation: https://developers.tron.network/docs/delegation

This repository change implements **authenticated read-only discovery only** via `GET /api/gasfree/capabilities?network=mainnet|nile`. It reports the live provider directory and per-token fee configuration, when approved server API credentials are configured. It never signs, submits, or broadcasts a transfer.

## Fees and funding: do not label this as free

The provider API's token configuration includes `activateFee` and `transferFee`, denominated in the transferred token's smallest unit. The documentation says these values may change. A user must explicitly review the live fees and maximum-fee authorization.

GasFree is not documented as a source of free USDT/TRX principal for a sender to forward to another wallet. A provider paying the on-chain gas is not the same as a sponsor granting assets to the receiver. The API directory also does not prove that any listed provider has a zero-fee offer, available liquidity, or a funded account.

The current product requirement remains external-sponsor-only and no user-funded fallback. Therefore this discovery endpoint **never enables sponsored submission** and exposes `providerFundingVerified: false` and `canSubmitSponsoredTransfer: false`, even when the provider API is reachable.

## Networks and developer access

The documented provider API origins and path prefixes are:

| Network | API origin | Path prefix |
| --- | --- | --- |
| Mainnet | `https://open.gasfree.io` | `/tron` |
| Nile testnet | `https://open-test.gasfree.io` | `/nile` |

The documented provider API does not list Shasta as an API environment. This implementation rejects Shasta rather than silently redirecting a Shasta request to Nile or Mainnet. The documentation says the integrator must apply for access to receive an API key and API secret. Both are server-only environment variables: `GASFREE_API_KEY` and `GASFREE_API_SECRET`. Never put the API secret in `VITE_*` variables, browser code, a commit, a URL, or logs.

## Before any send route can be enabled

All of the following require evidence and explicit authorization; provider discovery is not enough:

1. Written provider terms and fee schedule that fit the external-sponsor-only policy (or an explicit product-policy decision accepting token-denominated user fees).
2. Approved API access and confirmation of exactly which provider(s), networks and official token contracts are supported.
3. A verified sponsor funding/custody model that distinguishes on-chain gas costs from asset principal and states who pays each.
4. Wallet-side typed-data signing using the official SDK and a UI that displays the exact network, token contract, recipient, amount, provider, `maxFee`, deadline and nonce before the user signs.
5. Server-side request authentication, token/provider allowlists, authorization limits, nonce/expiry checks, request idempotency, audit records, and reconciliation from finalized chain evidence.
6. Nile testnet end-to-end tests with an approved provider, including activation, first transfer, repeated requests, pending/failure paths, and status reconciliation; security review before any Mainnet use.
7. An emergency pause and explicit operator approval separate from normal deployment.

A standard TRON token transfer can arrive at a wallet without the receiver taking an action, but an exchange credits a deposit only under that exchange's own token/network, address, confirmation, maintenance, and deposit-credit rules. No sender-side provider can guarantee that every exchange or wallet displays, credits, or notifies an asset in the same way. The app must distinguish chain receipt, verified wallet balance, application notification, and exchange-account credit.

## What this PR changes

- Adds HMAC-SHA256 authenticated, fixed-host, read-only provider/token discovery for the documented Mainnet and Nile environments.
- Normalizes provider/token records and returns token-denominated fee amounts without trusting a token symbol as proof of identity.
- Keeps submission and funding verification disabled.
- Exposes a capability endpoint and regression tests without altering live deployment configuration or database state.
