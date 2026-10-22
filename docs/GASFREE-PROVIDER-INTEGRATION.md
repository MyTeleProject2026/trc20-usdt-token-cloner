# GasFree provider discovery: verified scope and enablement gates

## Why this provider was selected for discovery

The official GasFree developer documentation describes a TRON TRC-20 workflow where the user authorizes a transfer with a wallet signature and a service provider submits the authorization and pays the on-chain gas costs. Its API includes provider discovery, token support/fee discovery, GasFree account lookup, submission, and status lookup.

- Official documentation: https://docs.gasfree.io/
- Official SDK repository: https://github.com/gasfreeio/gasfree-sdk-js
- TRON resource model: https://developers.tron.network/docs/bandwidth-and-energy
- TRON resource delegation: https://developers.tron.network/docs/delegation

This repository change implements authenticated, fixed-host, read-only calls through:

- `GET /api/gasfree/capabilities?network=mainnet|nile` — provider directory and supported-token fee configuration.
- `GET /api/gasfree/account?network=mainnet|nile&address={EOA}` — provider account status, recommended nonce, pending/frozen amounts and supported asset metadata. The documented response does not guarantee a spendable balance field; an absent balance is unknown, not zero.
- `GET /api/gasfree/trace?network=mainnet|nile&traceId={id}` — provider trace state and reported transaction metadata. A provider state is not independent chain-finality verification.

These calls require approved server-side API credentials. They never sign, submit, or broadcast a transfer, create a wallet balance, or credit a sponsor ledger.

## Fees and funding: do not label this as free

The provider API's token configuration includes `activateFee` and `transferFee`, denominated in the transferred token's smallest unit. The documentation says these values may change. A user must explicitly review the live fees and maximum-fee authorization.

GasFree is not documented as a source of free USDT/TRX principal for a sender to forward to another wallet. A provider paying the on-chain gas is not the same as a sponsor granting assets to the receiver. The API directory also does not prove that any listed provider has a zero-fee offer, available liquidity, or a funded account.

The current product requirement remains external-sponsor-only and no user-funded fallback. Therefore this discovery endpoint **never enables sponsored submission** and exposes `providerFundingVerified: false` and `canSubmitSponsoredTransfer: false`, even when the provider API is reachable.

## Other public provider offers reviewed

These alternatives do not establish a universally free sponsor-funded programme either:

- **TronTransfer** publicly documents sponsored USDT energy delegation, but its documented flow includes a separate TRX fee transaction to a collection address. That is a paid service rather than confirmed zero-cost sponsorship. See https://doc.trontransfer.com/.
- **FluxRail Pay** advertises a flat transfer fee. Its published example includes a `from_private_key` field in the transfer request. This repository will not send wallet private keys or recovery phrases to an external HTTP API; any future integration must use a documented non-custodial signature flow instead. See https://fluxrail.io/pay.
- TRON's own resource documentation says Energy has no free account quota; it is obtained through stake or delegation, or paid through the network's fee mechanism when resources are insufficient. See https://developers.tron.network/docs/bandwidth-and-energy and https://developers.tron.network/docs/delegation.

The research therefore found real gasless/energy sponsorship products, but **no verified unconditional free provider covering both network costs and the asset principal**. A sponsor-funded asset grant is a separate business arrangement and requires an explicitly consenting, funded sponsor.

## Receiver notifications and exchange credit

The receiver-history UI emits an in-app status message when a previously unseen incoming event is independently marked `verified-on-chain`. Initial historical rows and unverified indexer candidates do not trigger that alert. A separate opt-in requests browser Notification permission and, when granted, shows a device/browser notification for newly verified events while this page is running. This is not a service-worker push notification and does not work as a guaranteed background alert when the page is closed. It is not a notification delivered by other wallet apps or exchanges, and it does not prove exchange account credit.

## Networks and developer access

The documented provider API origins and path prefixes are:

| Network | API origin | Path prefix |
| --- | --- | --- |
| Mainnet | `https://open.gasfree.io` | `/tron` |
| Nile testnet | `https://open-test.gasfree.io` | `/nile` |

The documented provider API does not list Shasta as an API environment. This implementation rejects Shasta rather than silently redirecting a Shasta request to Nile or Mainnet. The documentation says the integrator must apply for access to receive an API key and API secret. The current adapter isolates credentials by network using these server-only variables:

| Environment variable | Network |
|---|---|
| `GASFREE_MAINNET_API_KEY` | Mainnet key |
| `GASFREE_MAINNET_API_SECRET` | Mainnet HMAC secret |
| `GASFREE_NILE_API_KEY` | Nile testnet key |
| `GASFREE_NILE_API_SECRET` | Nile HMAC secret |

Never put the API secret in `VITE_*` variables, browser code, a commit, a URL, or logs. The adapter rejects cross-network credential fallback.

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

- Adds HMAC-SHA256 authenticated, fixed-host, read-only provider/token discovery, account lookup and trace lookup for the documented Mainnet and Nile environments.
- Normalizes provider/token records and returns token-denominated fee amounts without trusting a token symbol as proof of identity; the UI explicitly checks the official Mainnet USDT contract address rather than relying on its symbol.
- Adds a follow-up from a provider trace to the existing independent solidified transaction/receipt verifier and, after exact Transfer-event verification, re-reads the receiver balance for the same network/contract/address.
- Adds opt-in browser notifications for newly verified receiver-history events and event-index-specific display keys.
- Keeps authorization submission, sponsor-funding claims and spendable sponsor-funded balances disabled.
- Adds regression tests without altering live deployment configuration or database state.
