# Direct sponsor-to-recipient Mainnet workflow

## Active architecture

TRON Token Studio keeps its existing wallet and account interface. Sponsor payout navigation opens the direct sponsor workflow; it does not open the retired vault/treasury dashboard.

A requester authenticates a TRON Mainnet wallet identity and submits an exact recipient address, official Tether Mainnet USDT contract, six-decimal amount and idempotency key. The requester wallet is not treated as the source of USDT.

The active sponsor flow is wallet-to-wallet and does not require Fireblocks, a Fireblocks vault, a managed custody API, or a platform treasury account:

- The asset-principal sponsor signs a one-time message bound to the requester, sponsor organization/agreement, recipient, official contract, amount, request key and expiry.
- A distinct fee sponsor signs a separate request-bound fee-coverage approval.
- The backend rechecks the configured sponsor-role addresses, fresh on-chain balances, exact agreement scopes and the required fee-resource evidence before preparing approval challenges.
- Sponsor approvals are approval records only. They are not TRON transaction signatures, balance reservations, Energy/Bandwidth delegation transactions, transfers or settlement records.

## Active API endpoints

Mainnet requester endpoints:

- `POST /api/tron/sponsorship/mainnet-direct/requests`
- `GET /api/tron/sponsorship/mainnet-direct/requests/:idempotencyKey`
- `GET /api/tron/sponsorship/mainnet-direct/readiness`

Principal sponsor approval endpoints:

- `GET /api/tron/sponsorship/mainnet-direct/review-queue`
- `POST /api/tron/sponsorship/mainnet-direct/requests/:idempotencyKey/approval-challenge`
- `POST /api/tron/sponsorship/mainnet-direct/requests/:idempotencyKey/approve`

Separate fee sponsor approval endpoints:

- `GET /api/tron/sponsorship/mainnet-direct/fee-review-queue`
- `POST /api/tron/sponsorship/mainnet-direct/requests/:idempotencyKey/fee-approval-challenge`
- `POST /api/tron/sponsorship/mainnet-direct/requests/:idempotencyKey/approve-fees`

All browser requests require a valid Mainnet wallet-authentication session and the configured frontend origin. Owner-only legacy vault and Fireblocks endpoints are not mounted by the active API service.

## Required backend sponsor configuration

The active direct workflow uses sponsor-controlled public addresses and reviewed agreement scopes:

- `SPONSOR_ASSET_MAINNET_ADDRESS`
- `SPONSOR_MAINNET_DIRECT_ORGANIZATION_REFERENCE`
- `SPONSOR_MAINNET_DIRECT_AGREEMENT_REFERENCE`
- `SPONSOR_MAINNET_DIRECT_AGREEMENT_SHA256`
- `SPONSOR_MAINNET_DIRECT_MAX_PAYOUT_USDT_BASE_UNITS`
- `SPONSOR_FEE_MAINNET_ADDRESS`
- `SPONSOR_MAINNET_DIRECT_FEE_ORGANIZATION_REFERENCE`
- `SPONSOR_MAINNET_DIRECT_FEE_AGREEMENT_REFERENCE`
- `SPONSOR_MAINNET_DIRECT_FEE_AGREEMENT_SHA256`
- `SPONSOR_MAINNET_DIRECT_MAX_FEE_SUN`
- Exact `SPONSOR_APPROVED_AGREEMENT_REFERENCES` entries for both roles.

These values must be supplied and approved by the actual sponsor. A public address, a balance displayed by an explorer, a configuration value or a message signature is not by itself proof of legal authority or consent. The asset principal must hold genuine USDT at the official Mainnet contract. The fee sponsor must hold sufficient TRX or arrange and prove an explicitly authorized resource delegation. The sponsor controls the wallets and authorizes only the requests it accepts.

## Current implementation boundary

The following capabilities are implemented in the current direct-sponsor code:

- Mainnet requester identity challenge and request persistence with idempotency.
- Separate sponsor wallet identity sessions.
- Request-specific, expiring, one-use principal and fee approval challenges.
- Signature recovery against the separately configured sponsor addresses.
- Agreement-scope, principal-balance, fee-balance and resource-evidence preflight checks.
- PostgreSQL persistence for requests, challenges and approvals.

The following capabilities are **not implemented or enabled** in this checkpoint:

- Atomic principal and fee-resource reservations for a live payout.
- Request-bound unsigned TRON transaction construction.
- Sponsor transaction signing of the exact TRC20 transfer.
- Mainnet broadcast and ambiguous-timeout recovery.
- Independent solidified receipt and exact USDT `Transfer` event reconciliation.
- Final sponsor-ledger settlement and exchange deposit-credit confirmation.

Accordingly, both principal and fee approvals still report that no funds/resources are reserved, no transaction signature exists, and no TRON broadcast has occurred. Mainnet payout execution remains disabled. A sponsor approval must never be presented as a completed transfer.

## Safety and acceptance requirements

- Never use third-party public addresses as spendable funding sources without their owners' explicit authorization.
- Never request or store sponsor seed phrases, private keys or raw wallet credentials in the browser or application database.
- Never substitute VTRC, a lookalike token or a testnet asset for genuine Tether USDT.
- Never charge the requester's personal wallet as an automatic fallback.
- Keep execution disabled until an independently verified sponsor mandate, real funds, signed transaction policy, atomic accounting, transaction signing, broadcast protections, solidified receipt verification, database backup/restore and security review are complete.
- A successful on-chain transfer does not prove an exchange credited the deposit. Verify the exchange's TRON USDT deposit requirements and credit status separately.

The frontend Static Site and backend Web Service currently deploy from `main`; this draft PR is not automatically deployed to those services. Do not describe this branch as deployed until a successful reviewed deployment is independently verified.
