# TRON Transfer resource API

Read-only Mainnet resource monitor for the TRON Transfer frontend.

## Endpoints

- `GET /health` — service health and upstream identity.
- `GET /v1/resources/:base58Address` — account Energy, free and staked/delegated Bandwidth by source, the maximum Bandwidth available to cover one transaction, native TRX balance, and current chain fee parameters.

## Bandwidth accounting

TRON does not add free Bandwidth and staked/delegated Bandwidth together to cover a single transaction. The API therefore returns:
- `bandwidth.maxSingleTransactionAvailable`: the larger of the two available quotas; use this for one-transaction coverage checks.
- `bandwidth.availableAcrossSeparateTransactions` (and legacy `totalAvailable`): an aggregate that may be used across separate transactions, not as a single-transaction budget.
- `bandwidth.singleTransactionCoverageRule`: a text explanation of the full-coverage rule.

The TRӾ deployment preflight uses the same one-source coverage rule and blocks any estimated TRX fallback when zero-TRX-burn mode is active.

## Deployment

This service is designed for a Render Web Service with root directory `Frontend-Tron-Transfer/resource-api`, Node runtime, `npm run check` build command, and `npm start` start command. It binds to `0.0.0.0:$PORT`. It needs no wallet key or private key. `TRONGRID_API_KEY` is optional infrastructure configuration for reliable production RPC reads, not a wallet credential or transaction-signing permission.

## Important limits

- Mainnet reads use the public TronGrid FullNode HTTP API. Configure an optional server-side `TRONGRID_API_KEY` in Render to send the `TRON-PRO-API-KEY` header; the key is never returned by the health or resource endpoints. Without a key, the service falls back to anonymous public access, which may be heavily rate limited or rejected. The API reports this honestly rather than fabricating resource data.
- The service is read-only. It cannot create Energy, delegate resources, sign, or broadcast transactions.
- TRON has no protocol free Energy quota. Free Bandwidth is reported from the live account-resource response.
- Exact smart-contract deployment Energy is not inferred from an arbitrary fee cap. A deployment-specific simulation or the exact node estimate is required.
- Free Energy faucet claims are not automated here. The published TronRental faucet requires a support-issued access code and account registration; it is a promotional manual claim, not an unauthenticated server API. Its published 131,000 Energy claim is not asserted to cover contract deployment.

The API accepts only GET requests for resource reads, validates TRON Base58 address syntax, limits request rates, caches snapshots briefly, and restricts browser CORS to the TRON Transfer frontend and local Vite development.
