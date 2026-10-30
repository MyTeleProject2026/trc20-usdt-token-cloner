# Testnet sponsor request intake and organization handoff

## Purpose and scope

The workflow frontend can now persist a sponsor-review request instead of only copying an unsaved summary. This is an **intake and review handoff**, not a payout processor.

The route is testnet-only (`nile` and `shasta`). It accepts an authenticated wallet session, validates the requester and recipient addresses, checks the exact USDT-labelled testnet TRC-20 contract against the server-side testnet allowlist, validates integer base units/decimals, and stores an idempotent request in PostgreSQL. VTRC is not accepted by this intake route.

**Important asset identity boundary:** a Nile/Shasta contract configured under `SPONSOR_USDT_NILE_CONTRACTS` or `SPONSOR_USDT_SHASTA_CONTRACTS` is a testnet test asset only. It is not Tether-issued Mainnet USDT and has no claim to Tether backing or Mainnet value. Genuine TRON USDT is only the official Mainnet contract `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` with 6 decimals. Do not label testnet tokens as genuine Tether USDT in the UI or to recipients.

It does not:
- create or activate a sponsor budget;
- prove sponsor ownership, consent, funding, or legal authority;
- reserve sponsor funds;
- call Fireblocks or any other custody provider;
- build, sign, submit, or broadcast a transaction;
- create Mainnet USDT or credit an exchange account.

Testnet tokens have no Mainnet value and are not official Mainnet USDT.

## Requester API

### Create a request

`POST /api/tron/sponsorship/requests`

Headers:
- `Authorization: Bearer <short-lived TRON wallet session>`
- `Content-Type: application/json`
- Browser-origin header must match the origin used when the wallet session was issued.

Example JSON for an allowlisted testnet TRC-20 token:

```json
{
  "idempotencyKey": "request-key-generated-with-crypto-randomuuid",
  "network": "nile",
  "recipientAddress": "T...",
  "asset": "TRC20",
  "tokenContract": "T...",
  "amountBaseUnits": "2500000",
  "decimals": 6
}
```

For native testnet TRX, use `"asset":"TRX"`, omit `tokenContract`, and use six decimals. Amounts are positive integer base units; decimal or exponent-form amounts are not accepted by the API.

The requester address is taken from the authenticated wallet session, not from the request body. The requested network must exactly match the wallet session network. Mainnet is rejected.

A successful response has:
- `status: "pending-organization-review"`
- `payoutAuthorized: false`
- `canSubmitSponsoredTransfer: false`
- `submissionEnabled: false`
- `providerSubmissionAttempted: false`
- `transactionBroadcast: false`

The same idempotency key with the same intent returns the existing record. Reusing that key for a different intent returns HTTP 409. A wallet is limited to ten new intake requests per hour.

### Read one of your requests

`GET /api/tron/sponsorship/requests/:idempotencyKey`

Requires the same wallet session. The API returns only the request belonging to that wallet address and testnet.

## Sponsor organization review queue

The sponsor administrator can poll the review queue from a trusted server or private API client:

```http
GET /api/tron/sponsorship/requests?network=nile&limit=50
Authorization: Bearer <SPONSOR_ADMIN_API_TOKEN>
```

Use `network=shasta` for Shasta or omit the network to inspect both testnets. The token must remain server-side. Do not place `SPONSOR_ADMIN_API_TOKEN` in frontend variables, browser code, a URL, an issue, a log, or chat.

The queue contains only requests whose status is `pending-organization-review`. It is not an approval API. The organization's responsible sponsor administrator must independently check the recipient, intended token contract, network, amount, applicable agreement, budget, and signatory authority.

## Handoff to the existing sponsor ledger

Only after the organization has independently approved the exact testnet request and its budget/agreement scope, the sponsor administrator may create the existing sponsor-budget reservation using the operator-only reservation endpoint:

`POST /api/tron/sponsorship/transfers/reserve`

The queue's `idempotencyKey`, `network`, `recipientAddress`, `asset`, `tokenContract`, and `amountBaseUnits` are the request identity to compare against the approved reservation. The reservation still requires the existing server-side sponsor agreement scope, active budget, correct distinct sponsor roles, and fresh solidified funding snapshot. The request queue itself grants none of these permissions.

The fee/resource sponsor is a separate role from the asset-principal sponsor. Any fee/resource delegation, budget reservation, and post-transaction cost settlement must be reviewed independently. Do not assume that a successful request record or a balance snapshot means the transfer is funded.

The existing sponsor operator console is at `#/sponsor-operator`. It uses the connected sponsor wallet for explicit testnet wallet approval and does not request private keys from the application.

## Production boundary

This intake queue does not provide a Mainnet path. Real Mainnet USDT payout requires the actual treasury-owning organization to approve the arrangement, control the funded vault, authorize the exact use of its assets, and complete independent security and release reviews. Fireblocks credentials remain backend-only. The existing immutable Mainnet payout kill switch must remain in place.

A solidified TRON transfer is still not proof that an exchange has credited a customer's deposit. Exchange credit must be confirmed by the receiving exchange's own authorized deposit records.
