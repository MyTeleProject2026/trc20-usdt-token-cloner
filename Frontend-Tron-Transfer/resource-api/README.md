# TRON Transfer resource API

Read-only Mainnet resource monitor for the TRON Transfer frontend.

## Endpoints

- `GET /health` — service health and upstream identity.
- `GET /v1/resources/:base58Address` — account Energy, free and staked/delegated Bandwidth by source, the maximum Bandwidth available to cover one transaction, native TRX balance, and current chain fee parameters.

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
