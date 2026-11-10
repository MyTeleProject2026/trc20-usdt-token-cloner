# Stage 8K — FYStack workspace USDT balance observation

## Confirmed official API contract

FYStack's public Workspace API documents:

- `GET /workspaces/{workspace_id}/balances?symbol=USDT`
- Production base URL: `https://api.fystack.io/api/v1`
- Authentication headers: `ACCESS-API-KEY`, `ACCESS-TIMESTAMP`, `ACCESS-SIGN`
- HMAC canonical string: `method={METHOD}&path={PATH}&timestamp={TIMESTAMP}&body={BODY}`
- Signature: HMAC-SHA256, hex digest, then base64-encode the hex string.
- Response includes symbol totals and network-specific rows with `asset_id`, `network_id`, `network_name`, `balance`, and `wallet_count`.

The response aggregates across every wallet in the workspace. It is not a wallet-specific available balance and does not distinguish held/reserved funds. A USDT symbol alone does not prove the token contract. Therefore this API result must never be used as a withdrawable balance.

Sources:
- https://docs.fystack.io/workspaces
- https://docs.fystack.io/authentication

## Implementation

`server/fystack-workspace-balance-reader.mjs` adds a server-side read-only client for the documented workspace endpoint. It never calls a state-changing endpoint. It classifies only network rows named exactly `Tron mainnet` and reports them as workspace-level observations.

The output deliberately sets:
- `walletSpecificBalanceVerified: false`
- `tokenContractVerified: false`
- `availableBalanceVerified: false`
- `spendableBalanceImpact: none`
- `ledgerMutationPerformed: false`
- `payoutAuthorizationGranted: false`
- `executionEnabled: false`

This closes the earlier documentation gap about workspace-level balance observations, but it does not replace the missing wallet-specific balance API/response contract added in later FYStack release notes.

## Operational prerequisites not supplied by this stage

- Workspace UUID, API key and API secret are not present in repository code and are not requested in chat.
- Server-side secret storage and owner-authenticated route integration remain separate work.
- Exact wallet-level balance/available-vs-held response schema remains unverified.
- Credit approval and real USDT funding remain unestablished.

## Preserved constraints

No withdrawal creation, approval, policy mutation, wallet mutation, signing, broadcast, sweep, ledger credit, database migration, or transfer. Existing historical records are untouched. The 1,000 USDT minimum is unchanged. No Fireblocks/Fincra integration is introduced by this new module.
