# Solidified TRC-20 transfer verification API

The API exposes a read-only verification endpoint:

`GET /api/tron/verify-transfer/:txId?contract=<hex>&from=<hex>&to=<hex>&amountSun=<integer>`

All addresses must be hex encoded (20-byte hex, optionally prefixed with `41`). `amountSun` is the exact integer in the token's smallest unit. The endpoint queries the configured TRONGrid Solidity endpoints for the solidified transaction body and receipt, then validates the successful execution result and matching `Transfer(address,address,uint256)` event.

## Required Render environment

- `TRON_VERIFIED_TOKEN_CONTRACTS`: comma-separated list of reviewed token contract addresses in hex format. If absent or empty, the endpoint fails closed with HTTP 503.
- `TRON_SOLIDITY_API_URL`: optional approved HTTPS TRONGrid endpoint. Defaults to `https://api.trongrid.io`; only the approved TRONGrid hosts are accepted.
- `TRONGRID_API_KEY`: optional TRONGrid API key. Keep it only in backend environment variables.

Do not add a token to the allowlist until its contract identity and behavior have been independently reviewed. The allowlist prevents the endpoint from claiming verification for an arbitrary contract that emits a Transfer-shaped event. A successful result means the event matched on the solidified chain for the configured contract; it does not independently certify that a token is official Tether USDT or that a token has economic value.

## Response states

- `verified-on-chain`: transaction body and receipt were found in solidified state and the expected event matched.
- `awaiting-solidification` / `awaiting-solidified-receipt`: HTTP 202; retry using the same transaction ID.
- `not-verified`: data was returned but the expected transfer could not be validated.
- `token-contract-not-allowlisted`: HTTP 403; the contract is not approved for this service.
- `verified-token-allowlist-not-configured`: HTTP 503; no contract has been approved.
- `solidified-provider-request-failed`: HTTP 502; provider access failed, so verification is inconclusive.

This endpoint never broadcasts transactions, signs for users, edits application balances, or treats an indexer/broadcast response as final proof. Never display a pending or unverified transaction as a confirmed deposit.
