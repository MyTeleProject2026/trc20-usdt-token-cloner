# TRON Transfer resource API

Mainnet resource monitor and guarded Sponsor transaction service for the TRON Transfer frontend. Public chain/resource endpoints remain read-only; Sponsor write operations require a signed wallet session, a separate exact-intent signature, durable PostgreSQL idempotency, and explicit server-side execution flags.

## Endpoints

- `GET /health` — service health and upstream identity.
- `GET /v1/resources/:base58Address` — account Energy, free and staked/delegated Bandwidth by source, the maximum Bandwidth available to cover one transaction, native TRX balance, current chain fee parameters, and network-wide resource limits/weights.
- `GET /v1/transactions/:base58Address?limit=20` — up to 50 latest confirmed Mainnet native transactions and official USDT TRC-20 transfers for a Sponsor Wallet, retrieved from TronGrid with an optional server-side API key. This avoids TronWeb's deprecated related-transaction endpoints.

## RPC provider diagnostics

Every successful `GET /v1/resources/:base58Address` response includes an `rpc` object:
- `preferredProviderOrder`: configured upstream priority (Tatum first when its key is present, then TronGrid).
- `providersUsed`: the actual upstream used independently for `accountResources`, `account`, and `chainParameters`. A value of `trongrid` for any read means that read fell back from Tatum.
- This metadata contains provider identifiers only; API keys and authorization headers are never returned.

## Mainnet RPC providers

- Tatum is preferred when `TATUM_API_KEY` is configured. Requests use the official TRON Mainnet HTTP API gateway at `https://tron-mainnet.gateway.tatum.io/wallet` and authenticate with the `x-api-key` header.
- TronGrid remains the fallback provider. Configure `TRONGRID_API_KEY` to send its `TRON-PRO-API-KEY` header; otherwise the service attempts the public endpoint.
- The service never returns either API key from `/health` or resource responses. Keep both keys in Render server-side environment variables; never put them in frontend build variables or browser code.
- If Tatum is unavailable or rejects a request, the resource reader retries that RPC call through TronGrid. If both providers fail, it returns an upstream error and does not invent resource values.
- Tatum RPC access provides blockchain connectivity and read/broadcast infrastructure. It does not create Energy, provide free Bandwidth, grant resources, or authorize a wallet signature.

## Bandwidth accounting

TRON does not add free Bandwidth and staked/delegated Bandwidth together to cover a single transaction. The API therefore returns:
- `bandwidth.maxSingleTransactionAvailable`: the larger of the two available quotas; use this for one-transaction coverage checks.
- `bandwidth.availableAcrossSeparateTransactions` (and legacy `totalAvailable`): an aggregate that may be used across separate transactions, not as a single-transaction budget.
- `bandwidth.singleTransactionCoverageRule`: a text explanation of the full-coverage rule.
- `networkResourceWeights`: live `TotalEnergyLimit`, `TotalEnergyWeight`, `TotalNetLimit`, and `TotalNetWeight` values (returned as decimal strings) for stake-requirement estimates. These ratios fluctuate with network staking and are estimates, not guaranteed resource quotes.

The TRӾ deployment preflight uses the same one-source coverage rule and blocks any estimated TRX fallback when zero-TRX-burn mode is active.

## Deployment

This service is designed for a Render Web Service with root directory `Frontend-Tron-Transfer/resource-api`, Node runtime, `npm run check` build command, and `npm start` start command. It binds to `0.0.0.0:$PORT`. It needs no wallet key or private key. RPC API keys are infrastructure credentials only; they do not grant transaction-signing permission.

## Important limits

- TRON resource reads use Tatum Mainnet when configured, with TronGrid fallback. Both providers expose chain state; neither grants resources merely because an API key is configured.
- The service is read-only. It cannot create Energy, delegate resources, sign, or broadcast transactions.
- TRON has no protocol free Energy quota. Free Bandwidth is reported from the live account-resource response.
- Exact smart-contract deployment Energy is not inferred from an arbitrary fee cap. A deployment-specific simulation or the exact node estimate is required.
- Free Energy faucet claims are not automated here. The published TronRental faucet requires a support-issued access code and account registration; it is a promotional manual claim, not an unauthenticated server API. Its published 131,000 Energy claim is not asserted to cover contract deployment.

The API accepts only GET requests for resource reads, validates TRON Base58 address syntax, limits request rates, caches snapshots briefly, and restricts browser CORS to the TRON Transfer frontend and local Vite development.

## Sponsor API and transaction controls

The resource API owns Sponsor operations; the frontend must not fall back to the separate Token Studio API.

- `GET /api/sponsor/status` — reports non-secret Sponsor configuration and whether execution is available.
- `POST /api/sponsor/session/challenge` and `POST /api/sponsor/session/verify` — authenticate the configured independent Sponsor wallet with a one-time signed message. The returned bearer session is short-lived and held by the client only.
- `POST /api/sponsor/intent` — creates a five-minute exact-intent message bound to Mainnet, Sponsor, Owner recipient, operation, resource, amount and idempotency key.
- `POST /api/sponsor/operations` — requires the Sponsor's signature over that exact intent and the explicit confirmation phrase before the server-side signer can act.
- `GET /api/sponsor/operations` and `GET /api/sponsor/operations/:idempotencyKey` — read the durable Sponsor operation ledger and reconcile ambiguous broadcasts.
- `GET /api/tron/sponsorship/resource-delegations` and `POST /api/tron/sponsorship/resource-delegations/verify-wallet` — authenticated, ledger-backed delegation history and independent Mainnet verification.

Required server-side configuration:

- `DATABASE_URL` — durable PostgreSQL ledger; execution fails closed without it.
- `SPONSOR_SESSION_SECRET` — at least 32 bytes for signed short-lived sessions.
- `SPONSOR_MAINNET_ADDRESS` and `SPONSOR_MAINNET_PRIVATE_KEY` — the independent Sponsor signer; the derived address must match exactly. The private key is read only by the backend and is never returned or logged.
- `TRON_OWNER_ADDRESS` — the existing Owner recipient; must differ from the Sponsor address.
- `SPONSOR_TRANSACTION_ENGINE_ENABLED=true` and `SPONSOR_MAINNET_BROADCAST_ENABLED=true` — both are required to enable execution. Both default to disabled.
- `SPONSOR_LIQUID_RESERVE_TRX` — protected liquid TRX reserve; defaults to 2 TRX.
- `SPONSOR_MAX_TX_FEE_SUN` — maximum permitted Bandwidth-shortfall fee in SUN; defaults to zero, so an uncovered transaction is blocked.

The transaction engine validates the exact Stake 2.0 contract, Sponsor signer, Owner recipient, resource, amount and expiration; checks Sponsor balance/reserve and one-source Bandwidth coverage; persists the transaction ID before broadcast; and only reports a delegation verified after a successful solidified Mainnet receipt and matching on-chain delegation state. An ambiguous broadcast is never automatically retried. No Owner wallet key is accepted by this API.

The Sponsor engine remains unavailable until its server-side credentials and database are configured. Adding the code does not create Energy, Bandwidth, TRX, or a provider grant, and does not authorize a TRӾ deployment.
