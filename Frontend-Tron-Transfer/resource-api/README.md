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

This service is designed for the existing Render Web Service with root directory `Frontend-Tron-Transfer/resource-api`, Node runtime, `npm test && npm run check` build command, and `npm start` start command. It binds to `0.0.0.0:$PORT`. When Sponsor writes are enabled, only the independent Sponsor private key is read by the backend as a Render secret. The Owner private key is never configured on this service. Owner-originated TRӾ deployment and contract administration use the existing encrypted local Owner Wallet signer in the frontend; the backend does not sign Owner transactions. RPC API keys are infrastructure credentials only; they do not grant transaction-signing permission.

## Important limits

- TRON resource reads use Tatum Mainnet when configured, with TronGrid fallback. Both providers expose chain state; neither grants resources merely because an API key is configured.
- The authenticated Sponsor API can sign and broadcast only explicitly authorized Sponsor Stake 2.0, delegation lifecycle, and capped native TRX top-up transactions; it cannot sign Owner transactions.
- TRON has no protocol free Energy quota. Free Bandwidth is reported from the live account-resource response.
- Exact smart-contract deployment Energy is not inferred from an arbitrary fee cap. A deployment-specific simulation or the exact node estimate is required.
- Free Energy faucet claims are not automated here. The published TronRental faucet requires a support-issued access code and account registration; it is a promotional manual claim, not an unauthenticated server API. Its published 131,000 Energy claim is not asserted to cover contract deployment.

The API accepts only GET requests for resource reads, validates TRON Base58 address syntax, limits request rates, caches snapshots briefly, and restricts browser CORS to the TRON Transfer frontend and local Vite development.

## Sponsor API and transaction controls

The resource API owns Sponsor operations; the frontend must not fall back to the separate Token Studio API.

- `GET /api/sponsor/status` — reports non-secret Sponsor configuration and whether execution is available.
- `POST /api/sponsor/session/challenge` and `POST /api/sponsor/session/verify` — authenticate the configured independent Sponsor wallet with a one-time signed message. The returned bearer session is short-lived and held by the client only.
- `POST /api/sponsor/intent` — creates a five-minute exact-intent message bound to Mainnet, Sponsor, Owner recipient, operation, resource, amount and idempotency key. Supported operations are `stake`, `delegate`, `undelegate`, `unstake`, `withdraw`, and a bounded Sponsor-to-Owner native TRX `topup`.
- `POST /api/sponsor/operations` — requires the Sponsor's signature over that exact intent and the explicit confirmation phrase before the server-side signer can act. When `SPONSOR_ADMIN_TOKEN` is configured, the same write request must also include `x-sponsor-admin-token`; the frontend accepts it in a memory-only password field and never stores it.
- `GET /api/sponsor/operations` and `GET /api/sponsor/operations/:idempotencyKey` — read the durable Sponsor operation ledger and reconcile ambiguous broadcasts. Reconciliation never automatically rebroadcasts a transaction.
- `GET /api/tron/sponsorship/resource-delegations` and `POST /api/tron/sponsorship/resource-delegations/verify-wallet` — authenticated, ledger-backed delegation history and independent Mainnet verification.

Required server-side configuration:

- `DATABASE_URL` — durable PostgreSQL ledger; execution fails closed without it.
- `SPONSOR_SESSION_SECRET` — at least 32 bytes for signed short-lived sessions.
- `SPONSOR_MAINNET_ADDRESS` and `SPONSOR_MAINNET_PRIVATE_KEY` — the independent Sponsor signer; the derived address must match exactly. The private key is read only by the backend and is never returned or logged.
- `TRON_OWNER_ADDRESS` — the existing Owner recipient; must differ from the Sponsor address.
- `SPONSOR_TRANSACTION_ENGINE_ENABLED=true` and `SPONSOR_MAINNET_BROADCAST_ENABLED=true` — both are required to enable execution. Both default to disabled.
- `SPONSOR_LIQUID_RESERVE_TRX` — protected liquid TRX reserve; defaults to 2 TRX.
- `SPONSOR_STAKING_ENABLED=true` — explicitly enables Sponsor Stake 2.0 operations.
- `SPONSOR_MAX_AUTOMATIC_STAKE_TRX` — maximum single stake operation; must be a positive TRX amount to enable staking. It defaults to zero (disabled).
- `SPONSOR_MAX_OWNER_TOPUP_TRX` — optional separate maximum single Owner top-up; if omitted, the existing `SPONSOR_MAX_AUTOMATIC_STAKE_TRX` value is used as the top-up cap.
- `SPONSOR_ADMIN_TOKEN` — optional second-factor secret for Sponsor write requests. If set, it must contain at least 32 characters and be supplied by the operator in the Sponsor UI; it is not exposed as a frontend build variable.
- `SPONSOR_MAX_TX_FEE_SUN` — maximum permitted Bandwidth-shortfall fee in SUN; defaults to zero, so an uncovered transaction is blocked.

The transaction engine validates the exact Stake 2.0, delegation lifecycle, or native TRX transfer contract; Sponsor signer; fixed Owner recipient; resource; amount; and expiration. It checks Sponsor balance, protected reserve, configured stake/top-up cap, and one-source Bandwidth coverage; persists the transaction ID before broadcast; and verifies the transaction against solidified Mainnet state. Delegation is additionally checked against live delegated-resource state. Undelegation is limited to the Sponsor's currently confirmed delegation to the configured Owner. Unstaking is limited to the Sponsor's own frozen Stake 2.0 balance minus active delegation and requires an available unfreeze slot. Unfreeze is not an immediate liquid-balance withdrawal: the current Mainnet Stake 2.0 delay is normally 14 days, and the actual expiry is read from the account state. Matured withdrawal is allowed only for the exact currently withdrawable amount, and the solidified receipt must report the matching `withdraw_expire_amount` before the operation is marked confirmed. An ambiguous broadcast is never automatically retried. No Owner wallet key is accepted by this API. Owner-originated contract deployment and token operations use the existing encrypted local Owner Wallet signer; Sponsor funding does not sign those Owner transactions.

The Sponsor engine remains fail-closed until its server-side credentials, independent Sponsor signer, session secret, admin token (when configured), and database are verified. The frontend provisioning planner uses fresh Owner/Sponsor Mainnet snapshots, live network resource weights, current delegation capacity, Sponsor balance, protected reserve, and the configured stake cap. It selects only one next action (stake or delegate); after a stake is confirmed, it requires a fresh Mainnet read before planning delegation. The planner itself never signs or broadcasts. Sponsor resource actions and TRX top-ups are explicit, per-operation approvals; this release does not run an unattended scheduler or automatically spend Sponsor funds in the background. Adding the code does not create Energy, Bandwidth, TRX, or a provider grant, and does not authorize a TRӾ deployment.

## Production readiness and cutover gates

Complete these checks against the existing Render services before enabling Sponsor writes or declaring the production release complete:

1. **Persistent database:** use a paid, non-expiring Render Postgres plan for the production Sponsor ledger. Keep the database in the same Render region as the Resource API and configure the service with the database's internal connection string. Do not use a time-limited free database for a production transaction ledger.
2. **Database migration and recovery:** take and verify a backup/export before moving an existing ledger. Restore or migrate the data into the production database, then verify the expected Sponsor operation and delegation tables, constraints, and indexes. Do not delete or suspend the source database until the new database has been checked and the rollback window has expired.
3. **Sponsor readiness:** call `GET /api/sponsor/status` from the production frontend origin. Require `databaseReady`, `ownerAddressMatches`, `sponsorIndependent`, `sessionAuthenticationConfigured`, and `engineConfigured` to be true. If the Admin token is required, also require `adminTokenConfigured`. `transactionExecutionAvailable` is a configuration/readiness signal; it does not prove that the Sponsor wallet has enough TRX, Energy, or Bandwidth for a particular operation.
4. **Execution remains disabled until authorized:** keep `SPONSOR_TRANSACTION_ENGINE_ENABLED` and `SPONSOR_MAINNET_BROADCAST_ENABLED` false until the operator has checked the Sponsor address, private-key-derived address, Owner recipient, protected reserve, stake/top-up caps, fee cap, wallet funding, and exact operation intent. Enable only the operations the operator has approved.
5. **Deploy order:** merge the reviewed application change into the configured production branch, verify the Resource API build and health check, verify Sponsor status and read-only Mainnet resource responses, then verify the frontend against that API. Do not treat a successful `/health` response alone as proof that Sponsor database migrations or transaction execution are ready.
6. **Mainnet safety:** keep the existing TRӾ contract source and artifact unchanged. Contract deployment, token administration, and Sponsor transactions each require their own explicit authorization and live preflight; CI success is not authorization to broadcast.

The production database must have an independently verified backup and a tested recovery path. Never put database URLs, private keys, session secrets, Admin tokens, or RPC API keys in frontend build variables, source control, logs, or public status responses.


## No-card database continuity

If Render paid billing is unavailable, see [`docs/TRON-TRANSFER-NO-CARD-DATABASE-MIGRATION.md`](../../docs/TRON-TRANSFER-NO-CARD-DATABASE-MIGRATION.md) for the guarded migration path to an external PostgreSQL provider and the included `npm run migrate:sponsor-ledger` utility. A no-card free database is an interim continuity option only; keep Sponsor signing and broadcast disabled until durable backup, restore, availability, and Mainnet readiness requirements are independently met.
