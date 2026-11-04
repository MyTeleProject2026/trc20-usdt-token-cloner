# Direct sponsor-to-recipient Mainnet withdrawal model

## Target transaction path

The requester uses the existing TRON Token Studio account and withdrawal UI. The platform persists a request and presents it to the authorized sponsor. The sponsor's own TRON wallet signs a transaction whose sender is the asset-principal sponsor and whose recipient is the requested external wallet or exchange deposit address. The signed transaction is broadcast to TRON Mainnet only after the request, exact agreement scope, sponsor budget, signature, and transaction-specific fee/resource coverage have been checked.

The platform is not the owner of the sponsor wallet and does not hold the principal. The requester's identity wallet is not the sender and does not need USDT or TRX. The direct sponsor wallet must hold genuine official USDT; the sponsor or separately authorized fee sponsor must cover the network costs. The requested amount and fee amount are accounted for separately so the recipient amount is not silently reduced.

## Current repository checkpoint

The new diagnostic endpoint is:

- `GET /api/tron/sponsorship/mainnet-direct/readiness?refresh=1`

It reads the existing fee-sponsor and asset-principal sponsor snapshots on Mainnet, checks the official Tether TRC-20 contract, role separation, audited Energy/Bandwidth delegation, matching Mainnet agreement-scope allowlists, and database readiness. It does not return sponsor addresses or credentials.

This is a diagnostic checkpoint, not a withdrawal route. `preflightReady`, `canCreateSigningIntent`, and `canSubmitSponsoredTransfer` remain false. The source-level Mainnet execution gate is hard-coded closed; environment variables cannot open it.

## Still required for real execution

1. Build a Mainnet-specific request reservation and approval state machine that binds the requester's authenticated identity, recipient, official USDT contract, exact amount, sponsor scope, expiry, replay nonce, and idempotency key.
2. Add an asset-sponsor wallet signing flow. Signing happens in the sponsor's connected wallet; private keys and seed phrases must never enter the API or browser storage. The server must validate the exact persisted unsigned transaction, sender, recipient, contract, amount, fee limit, transaction expiry, signature permission, and sponsor approval before submission.
3. Verify transaction-specific Energy and Bandwidth capacity for the exact transaction, with a distinct fee-sponsor budget and resource reservation. An observed delegation or a current resource balance alone is not a guarantee of zero TRX burn.
4. Add fixed-origin Mainnet broadcast, durable single-transaction claim, ambiguous-timeout handling, and retries restricted to the same transaction ID.
5. Reconcile the exact USDT Transfer event and successful receipt from solidified TRON chain data, then verify the receiver's balance delta and settle the sponsor principal and fee ledgers once.
6. Independently review the sponsor's legal authority, account ownership, source of funds, agreement scope, wallet signing policy, emergency pause, production database backup/restore, and security posture.
7. Complete a funded low-value Mainnet acceptance transfer under the sponsor's authority. A successful TRON transfer proves on-chain receipt, not an exchange's internal deposit credit; that must be checked separately with the exchange.

## Guardrails

- No fabricated balances, simulated Mainnet receipts, fake transaction IDs, or claims that an exchange credited a deposit without exchange evidence.
- No private key, seed phrase, API secret, or Fireblocks signing material is accepted through these APIs.
- No fallback to the requester's funds is allowed.
- Do not enable Mainnet execution from an environment flag alone. The source-level gate stays closed until the implementation, independent reviews, and acceptance evidence are complete.

## Mainnet request-intake checkpoint

A separate Mainnet request intake is now available for authenticated Mainnet wallet identities:

- `POST /api/tron/sponsorship/mainnet-direct/requests`
- `GET /api/tron/sponsorship/mainnet-direct/requests/:idempotencyKey`
- `GET /api/tron/sponsorship/mainnet-direct/requests?limit=50` (server-only sponsor-review token)

It accepts only the official Tether Mainnet USDT contract, six-decimal positive integer base units, a valid recipient distinct from the requester, and an idempotency key. Requests are persisted in a dedicated table, separate from the testnet intake queue. The requester can retrieve only their own request. The sponsor review queue requires the server-side admin token.

The status is always `pending-sponsor-review`. This intake does not establish sponsor authority, reserve principal or fee budget, create a signing intent, sign, broadcast or settle. It deliberately has no approve/execute endpoint yet. Mainnet execution remains hard-disabled.

### User interface and verification

The existing Mainnet read-only panel now includes a separate requester identity and request form. It requires TronLink to be manually set to the official HTTPS TRON Mainnet node (`api.trongrid.io`), signs only the server's short-lived wallet-identity challenge, and keeps the resulting session token in component memory. The form submits recipient, USDT amount and a browser-generated idempotency key to the Mainnet request API. Editing the recipient or amount generates a new request key; retrying an unchanged request reuses the same key.

The form is not connected to the testnet sender wallet or testnet transfer flow. It does not request a transaction signature, and the request receipt is labelled `No transfer sent`. A user must sign in again after a page refresh because the Mainnet requester session token is not persisted in browser storage.

The sponsor queue is currently a server-token-protected operator review endpoint. It is not an external sponsor organization login, does not prove the legal sponsor mandate, and does not yet provide sponsor approval or transaction signing.
