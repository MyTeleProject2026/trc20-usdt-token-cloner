# TRON Transfer resource API

Read-only Mainnet resource monitor for the TRON Transfer frontend.

## Endpoints

- `GET /health` — service health and upstream identity.
- `GET /v1/resources/:base58Address` — account Energy, free/staked/delegated Bandwidth totals, native TRX balance, and current chain fee parameters.

## Deployment

This service is designed for a Render Web Service with root directory `Frontend-Tron-Transfer/resource-api`, Node runtime, `npm run check` build command, and `npm start` start command. It binds to `0.0.0.0:$PORT`. It needs no wallet key, private key, API secret, or environment variable.

## Important limits

- Mainnet reads use the public TronGrid FullNode HTTP API without an API key. Official TronGrid documentation says production requests should use an API key and anonymous requests may be heavily rate limited or rejected. The API reports this honestly rather than fabricating resource data.
- The service is read-only. It cannot create Energy, delegate resources, sign, or broadcast transactions.
- TRON has no protocol free Energy quota. Free Bandwidth is reported from the live account-resource response.
- Exact smart-contract deployment Energy is not inferred from an arbitrary fee cap. A deployment-specific simulation or the exact node estimate is required.
- Free Energy faucet claims are not automated here. The published TronRental faucet requires a support-issued access code and account registration; it is a promotional manual claim, not an unauthenticated server API. Its published 131,000 Energy claim is not asserted to cover contract deployment.

The API accepts only GET requests for resource reads, validates TRON Base58 address syntax, limits request rates, caches snapshots briefly, and restricts browser CORS to the TRON Transfer frontend and local Vite development.
