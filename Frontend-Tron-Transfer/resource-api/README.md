## Remote Sponsor signer transport

The Resource API now supports an HTTPS remote signer client through `SPONSOR_SIGNER_URL`, `SPONSOR_SIGNER_HMAC_SECRET` (minimum 32 characters), and the existing `SPONSOR_MAINNET_ADDRESS`. When no explicit adapter is injected and `SPONSOR_SIGNER_URL` is configured, the server constructs this adapter. The Resource API never sends a private key to the signer; it sends only the exact unsigned transaction body and its transaction ID.

### Request protocol

The client sends a JSON body containing `requestId`, `txID`, `raw_data_hex`, and `raw_data`. Headers contain a millisecond timestamp, a cryptographically random request ID, and an HMAC-SHA256 over `timestamp.requestId.rawJsonBody`. Requests use HTTPS only and have a bounded timeout. The signer service must independently:

- Authenticate the HMAC using a secret stored outside the Resource API.
- Reject timestamps outside a short configured skew window (recommended 60 seconds).
- Atomically reject previously consumed request IDs and retain them longer than the maximum request validity window.
- Recompute the transaction ID and validate the transaction's intended Sponsor, Owner, contract type, amount, resource, expiration and fee policy before signing.
- Sign only with a key whose derived Mainnet address is the configured Sponsor.
- Return the exact unchanged transaction body with the signature and a response HMAC over `requestId.txID.raw_data_hex.signaturesJoinedByComma`.
- Never broadcast transactions; broadcasting remains the Resource API engine's responsibility.
- Never log request secrets, private keys or complete authorization headers.

The client checks response request ID, transaction ID, raw bytes, raw transaction body, signature encoding and response HMAC before returning the signed transaction to the engine. The engine performs its own transaction-body integrity check and persists the transaction ID before any broadcast attempt.

**Deployment boundary:** this repository implements the Resource API remote-signer client and its tests, not the remote signer service itself. No HSM/KMS provider, signer endpoint, anti-replay datastore, key handle, network allowlist or production secret has been provisioned here. The remote signer service must be implemented and independently reviewed before setting these variables in Render. Do not enable Mainnet writes merely by configuring the URL.

## Isolated Sponsor signer adapter

The Sponsor engine accepts an injected signer adapter through its `signerAdapter` dependency. The contract is intentionally narrow:

- `address`: the adapter's public TRON Mainnet address.
- `signTransaction(unsignedTransaction)`: signs the exact transaction constructed and preflighted by the Resource API, returning the signed transaction object.

When an adapter is injected, the engine does not read `SPONSOR_MAINNET_PRIVATE_KEY` or pass a private key to the TronWeb provider factory. It checks that the adapter address exactly matches `SPONSOR_MAINNET_ADDRESS` and differs from the Owner. Before broadcast, it verifies that the signer did not change `txID`, `raw_data_hex`, or `raw_data`, and requires at least one signature. A mismatch fails closed before the transaction ID is persisted or broadcast.

The existing Render server factory can receive an already-constructed Sponsor engine through its `sponsorEngine` dependency. This provides the integration seam for a separately hosted HSM/KMS signer without moving Owner keys or granting the signer control over transaction construction, fee policy, database authorization, or broadcasting.

**Deployment status:** the adapter interface and tests are implemented, but the existing production server still uses its legacy environment-backed Sponsor signer unless an external engine is explicitly injected. No HSM/KMS vendor, endpoint, key handle, authentication method or network policy has been configured in this repository. Do not claim external custody is active until an approved signer service is provisioned, wired into `createServer({ sponsorEngine })`, and accepted with key-isolation and recovery tests. The existing encrypted browser Sponsor vault also remains a separate custody exposure for wallet challenge signing; this adapter alone does not remove that browser copy.

## Sponsor transaction execution and recovery

In the production server integration, Sponsor transaction execution requires two independent backend-managed password sessions: the configured Sponsor account session and a separate Owner Admin session whose address must match `TRON_OWNER_ADDRESS`. Sponsor writes also require Sponsor-session CSRF/Origin validation, an exact short-lived operation intent, explicit confirmation, and durable idempotency. The Sponsor server signer must derive the configured Sponsor address and must not equal the Owner address. Neither private key is returned to the browser.

Before execution, the API reserves the idempotency key in the durable ledger and acquires a shared lock on the Sponsor write-control row. That lock remains held until signing, broadcast attempt, and final operation status are durably recorded. A concurrent maintenance pause therefore cannot be switched on between reservation and signing; it waits for the in-flight operation to leave the critical section.

The transaction ID is persisted before attempting broadcast. If the process or provider fails after signing, the operation remains `signed-not-broadcast` or `broadcast-unknown`. A later authenticated GET of `/api/sponsor/operations/:idempotencyKey` reconciles that exact transaction against solidified Mainnet state. It may mark a verified success as `confirmed`, a solidified failed receipt as `failed`, or preserve the ambiguous state with the latest reconciliation result. It never automatically re-signs or re-broadcasts an ambiguous operation; the idempotency key remains non-retryable.

# TRON Transfer resource API

Mainnet resource monitor and guarded Owner/Sponsor transaction service for the existing TRON Transfer frontend. Public chain/resource endpoints remain read-only; Owner and Sponsor writes use independent backend-managed identities, role-bound sessions, exact-intent authorization, durable PostgreSQL idempotency and explicit server-side execution gates.

## Endpoints

- `GET /health` — service health and upstream identity.
- `POST /api/tron/mainnet/rpc/:walletMethod` — allowlisted, read-only TronWeb RPC proxy used by the existing Owner UI. Browser reads are routed through the Resource API; write/broadcast/deployment RPC methods are denied.
- `GET /v1/resources/:base58Address` — account Energy, free and staked/delegated Bandwidth by source, the maximum Bandwidth available to cover one transaction, native TRX balance, current chain fee parameters, and network-wide resource limits/weights.
- `GET /v1/transactions/:base58Address?limit=20` — up to 50 latest confirmed Mainnet native transactions and official USDT TRC-20 transfers for a Sponsor Wallet, retrieved from TronGrid with an optional server-side API key. This avoids TronWeb's deprecated related-transaction endpoints.
- `POST /api/owner/operations/prepare`, `GET /api/owner/operations`, `GET /api/owner/operations/:operationId`, `POST /api/owner/operations/:operationId/confirm`, and `POST /api/owner/operations/:operationId/cancel` — session-bound Owner operation preparation, journal recovery, explicit confirmation and solidified receipt reconciliation. Every POST requires the Owner session CSRF token.


## Existing TRON Transfer Owner Admin operations

Owner administration uses the existing Owner Admin UI and existing TRӾ pages. It does not create a replacement dashboard or a second application.

- Owner authentication is a backend password session with one-time first enrollment. The browser never receives, imports, stores or signs with the Owner private key.
- The Resource API reads `TRON_OWNER_PRIVATE_KEY` only from its server-side secret environment and verifies the derived address against `TRON_OWNER_ADDRESS`. The independent Sponsor signer and Sponsor address remain separate. Sponsor readiness requests are coalesced and briefly cached only while the ledger confirms writes are paused; when writes are not paused, status is read fresh. PostgreSQL connection and statement waits are bounded so an unhealthy database returns a fail-closed status instead of holding the browser request open indefinitely.
- The allowlisted existing-contract operations are Owner issuance/credit, external credit, batch credit (maximum 50 recipients), TRӾ transfer, pause/unpause, minting enable/disable and the first step of two-step ownership transfer. The Owner issuance path preserves the contract's auditable `credit(address,uint256,bytes32)` reference semantics.
- The browser submits typed intent fields only. The backend binds the intent to the configured `TRAX_CONTRACT_ADDRESS`, builds the canonical TRON Mainnet TriggerSmartContract transaction, and records the intent hash and preflight evidence in `tron_transfer_owner_operations`.
- Preflight reuses the shared TRON Mainnet resource-budget, permission, Energy simulation, Bandwidth single-transaction coverage, fee-cap and zero-TRX-burn helpers. The backend also checks the deployed runtime bytecode SHA-256 in `TRAX_RUNTIME_BYTECODE_SHA256`, TRӾ metadata, current on-chain Owner and Owner permission ID 0.
- Confirmation requires the exact phrase `CONFIRM TRON MAINNET OWNER OPERATION` and the stored intent hash. Immediately before signing, the backend rebuilds the same intent, repeats the Mainnet preflight, validates the transaction integrity, signs with the Owner-only server key, recovers the signer, and checks live TRON permission weight.
- The signed transaction and transaction ID are durably recorded before broadcast. Broadcast ambiguity is retained as `broadcast-unknown`; later authenticated reads query TRON's solidified-node transaction and receipt. A confirmed receipt must match the stored transaction ID, Owner, contract and signer. The system never automatically re-signs or rebroadcasts an ambiguous transaction.
- The existing History page includes the Owner-identity-scoped operation journal, recoverable across password sessions so prepared intents and transaction receipts can be recovered after a page reload. Raw signed transaction payloads and private keys are not returned by the journal endpoint.
- Rate limits apply to preparation, confirmation and journal reads. The Owner and Sponsor ledgers remain isolated by wallet role.

### Owner ledger migration and execution gates

Apply the existing wallet-auth/Owner-ledger migration first, then the additive lifecycle migration:

1. `migrations/20261122_backend_wallet_auth.sql`
2. `migrations/20261123_owner_operation_ledger.sql`

Do not apply either migration until the Neon database backup and restore procedure has been verified. The second migration adds the atomic `confirming` lifecycle state to the existing Owner operation table.

The following server-side variables are required before any Owner operation can be prepared:

- `TRON_OWNER_ADDRESS` and `TRON_OWNER_PRIVATE_KEY` — the configured Owner Mainnet identity and server-only private key.
- `TRAX_CONTRACT_ADDRESS` — the exact existing TRӾ Mainnet contract address.
- `TRAX_RUNTIME_BYTECODE_SHA256` — lowercase SHA-256 of the exact deployed runtime bytecode verified against the approved TRӾ artifact.
- `OWNER_MAX_FEE_LIMIT_SUN` — server-side fee ceiling (the current default is 150,000,000 SUN).

Preparation is intentionally fail-closed unless these three database evidence flags are true:

- `OWNER_OPERATION_LEDGER_DURABLE=true`
- `OWNER_OPERATION_LEDGER_BACKUP_VERIFIED=true`
- `OWNER_OPERATION_LEDGER_RESTORE_TESTED=true`

Signing and broadcast require both additional gates:

- `OWNER_OPERATION_EXECUTION_ENABLED=true`
- `OWNER_OPERATION_MAINNET_ACK=CONFIRM_GUARDED_OWNER_EXECUTION`

Do not set the database evidence flags or Mainnet execution gates until the migration has been applied, backup/restore has been demonstrated, the exact deployed TRӾ bytecode and Owner identity have been independently verified, and the full Owner/Sponsor regression suite has passed. These values are not enabled by this code change. No Mainnet transaction is sent by migration or deployment.

### Deliberately separate operations

- TRӾ contract deployment remains locked in the existing UI until a separate backend deployment route pins the exact creation bytecode/ABI artifact and performs its own deployment-specific preflight. The TriggerSmartContract Owner signer does not sign CreateSmartContract deployment transactions.
- The current Owner signer cannot accept a two-step ownership transfer on behalf of a different pending-owner address. The new pending owner must authorize its own acceptance transaction; the existing Owner session does not impersonate it.
- No Solidity contract rewrite, upgrade or Mainnet deployment is included in this change.

## Browser Mainnet RPC proxy and network reliability

The existing TRӾ Owner panel configures its read-only TronWeb client to use `VITE_RESOURCE_API_URL` (or the existing Resource API origin) at `/api/tron/mainnet/rpc`, rather than calling `api.trongrid.io` directly from the browser. The proxy exposes only an explicit read-method allowlist, keeps `TRONGRID_API_KEY` and `TATUM_API_KEY` on the server, coalesces identical in-flight reads, caches successful identical reads for 1.5 seconds, and serializes upstream RPC requests at no more than roughly two requests per second per Resource API process. The same process-wide queue also paces the existing resource snapshots and Tatum/TronGrid fallback reads. A TronGrid `429` activates a minimum five-second provider cooldown. Transaction broadcast, deployment, signing, and arbitrary RPC methods are not exposed through this proxy. Owner signing and preflight still perform their own fresh backend reads and fail closed on provider, DNS, timeout, permission, or resource errors; the short UI cache is never used as signing evidence.

`ERR_NAME_NOT_RESOLVED` is a DNS/resolver or upstream reachability failure, not a TronGrid quota response. The proxy can keep provider credentials private and use the configured Tatum-first/TronGrid-fallback path, but it cannot repair a Render DNS outage or a provider outage. When all configured providers are unreachable, the UI must display unavailable and leave writes blocked.

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

This service is designed for the existing Render Web Service with root directory `Frontend-Tron-Transfer/resource-api`, Node runtime, `npm test && npm run check` build command, and `npm start` start command. It binds to `0.0.0.0:$PORT`. Keep `TRON_OWNER_PRIVATE_KEY`, the independent Sponsor signing key, and RPC provider credentials only in Render server-side secrets; none may be included in frontend build variables. The Owner key is consumed only by the backend-managed Owner signer after the Owner session, exact-intent, runtime-bytecode, live permission, resource, fee and database-durability gates pass. Sponsor signing remains a separate identity and execution path. RPC API keys are infrastructure credentials only; they do not grant transaction-signing permission.

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
- `POST /api/sponsor/operations` — requires the Sponsor's signature over that exact intent and the explicit confirmation phrase before the server-side signer can act. Every Sponsor write request must also include `x-sponsor-admin-token`; the frontend accepts it in a memory-only password field and never stores it. Missing or invalid server configuration blocks execution.
- `GET /api/sponsor/operations` and `GET /api/sponsor/operations/:idempotencyKey` — read the durable Sponsor operation ledger and reconcile ambiguous broadcasts. Reconciliation never automatically rebroadcasts a transaction.
- `GET /api/tron/sponsorship/resource-delegations` and `POST /api/tron/sponsorship/resource-delegations/verify-wallet` — authenticated, ledger-backed delegation history and independent Mainnet verification.

Required server-side configuration:

For the existing Render deployment, keep the Resource API and Sponsor PostgreSQL database in the same region (currently Singapore) and configure the database's **Internal Database URL** as the Render service's `SPONSOR_DATABASE_URL` environment variable. Do not open the database to the public internet or add a `0.0.0.0/0` IP allowlist entry. If using a pooled PostgreSQL provider such as Neon, use its pooled URL in `SPONSOR_DATABASE_URL_POOLED` and its direct URL in `SPONSOR_DATABASE_URL`. The service prefers the pooled Sponsor-specific URL, then the direct Sponsor-specific URL, then the legacy shared database variables.

- `SPONSOR_DATABASE_URL_POOLED` or `SPONSOR_DATABASE_URL` — optional dedicated Sponsor ledger connection. Use the pooled URL in the first variable and the direct URL in the second. These Sponsor-specific values take precedence over the shared variables below. If either is set to an obsolete or unreachable host, it will override the Neon values in the shared variables.
- `DATABASE_URL_POOLED` or `DATABASE_URL` — backward-compatible runtime configuration. For the previously documented Neon setup, set `DATABASE_URL` to the Neon direct URL and `DATABASE_URL_POOLED` to the Neon pooled URL. The Resource API selects the first non-empty variable in this order: `SPONSOR_DATABASE_URL_POOLED`, `SPONSOR_DATABASE_URL`, `DATABASE_URL_POOLED`, then `DATABASE_URL`. Thus, a configured Neon pooled URL is used unless a Sponsor-specific URL overrides it.
- `GET /api/sponsor/status` returns a safe `databaseConnection` diagnostic containing only the selected environment-variable name, provider family (`neon`, `render-postgres`, or `external-postgres`), and connection mode (`pooled` or `direct`). It never returns the hostname, username, password, database name, or query parameters. Use this field to confirm which configured destination the Resource API actually selected.
- `SPONSOR_LEDGER_DURABLE=true`, `SPONSOR_LEDGER_BACKUP_VERIFIED=true`, and `SPONSOR_LEDGER_RESTORE_TESTED=true` — all three attestations are required before Sponsor write intents or execution are accepted. Set them only after moving to a non-expiring production database, verifying the source backup, and completing a restore/recovery test. They default to false; a reachable but temporary/free database is not sufficient.
- `SPONSOR_SESSION_SECRET` — at least 32 bytes for signed short-lived sessions.
- `SPONSOR_MAINNET_ADDRESS` and `SPONSOR_MAINNET_PRIVATE_KEY` — the independent Sponsor server signer; the derived address must match exactly. The backend key is never returned or logged. **Current custody limitation:** the Sponsor browser vault also stores an encrypted copy of the same private key so it can sign the wallet-authentication challenge. The key therefore exists in both the browser's encrypted vault and the Render API environment; it is not isolated to the backend. The Owner and Sponsor workspaces also run under the same application origin and JavaScript runtime, so the workspace switch is a UI/access-flow boundary, not a hardened process or origin boundary against same-origin script compromise. Do not describe this as hardware-backed, single-custody, or cryptographically isolated signing.
- `TRON_OWNER_ADDRESS` — the existing Owner recipient; must differ from the Sponsor address.
- `SPONSOR_TRANSACTION_ENGINE_ENABLED=true` and `SPONSOR_MAINNET_BROADCAST_ENABLED=true` — both are required to enable execution. Both default to disabled.
- `SPONSOR_LIQUID_RESERVE_TRX` — protected liquid TRX reserve; defaults to 2 TRX.
- `SPONSOR_STAKING_ENABLED=true` — explicitly enables Sponsor Stake 2.0 operations.
- `SPONSOR_MAX_AUTOMATIC_STAKE_TRX` — maximum single stake operation; must be a positive TRX amount to enable staking. It defaults to zero (disabled).
- `SPONSOR_MAX_OWNER_TOPUP_TRX` — optional separate maximum single Owner top-up; if omitted, the existing `SPONSOR_MAX_AUTOMATIC_STAKE_TRX` value is used as the top-up cap.
- `SPONSOR_MAX_TX_FEE_SUN` — maximum permitted Bandwidth-shortfall fee in SUN; defaults to zero, so an uncovered transaction is blocked.

The transaction engine validates the exact Stake 2.0, delegation lifecycle, or native TRX transfer contract; Sponsor signer; fixed Owner recipient; resource; amount; and expiration. It checks Sponsor balance, protected reserve, configured stake/top-up cap, and one-source Bandwidth coverage; persists the transaction ID before broadcast; and verifies the transaction against solidified Mainnet state. Delegation is additionally checked against live delegated-resource state. Undelegation is limited to the Sponsor's currently confirmed delegation to the configured Owner. Unstaking is limited to the Sponsor's own frozen Stake 2.0 balance minus active delegation and requires an available unfreeze slot. Unfreeze is not an immediate liquid-balance withdrawal: the current Mainnet Stake 2.0 delay is normally 14 days, and the actual expiry is read from the account state. Matured withdrawal is allowed only for the exact currently withdrawable amount, and the solidified receipt must report the matching `withdraw_expire_amount` before the operation is marked confirmed. An ambiguous broadcast is never automatically retried. No Owner wallet key is accepted by the Sponsor API. Owner-originated contract operations use the backend-managed Owner password session and the server-only Owner signer; the Owner private key never enters the browser. Sponsor funding does not sign Owner contract transactions.

The Sponsor engine remains fail-closed until its server-side credentials, independent Sponsor signer, Sponsor session secret, Owner Admin session integration, database connectivity, and the durable-database/backup/restore attestations are verified. The active browser no longer imports, encrypts, stores, or unlocks Sponsor private keys; the Sponsor RPC client is read-only. The frontend provisioning planner uses fresh Owner/Sponsor Mainnet snapshots, live network resource weights, current delegation capacity, Sponsor balance, protected reserve, and the configured stake cap. It selects only one next action (stake or delegate); after a stake is confirmed, it requires a fresh Mainnet read before planning delegation. The planner itself never signs or broadcasts. Sponsor resource actions and TRX top-ups are explicit, per-operation approvals; this release does not run an unattended scheduler or automatically spend Sponsor funds in the background. Adding the code does not create Energy, Bandwidth, TRX, or a provider grant, and does not authorize a TRӾ deployment.

## Production readiness and cutover gates

Complete these checks against the existing Render services before enabling Sponsor writes or declaring the production release complete:

1. **Persistent database:** use a paid, non-expiring Render Postgres plan for the production Sponsor ledger. Keep the database in the same Render region as the Resource API and configure the service with the database's internal connection string. Do not use a time-limited free database for a production transaction ledger.
2. **Database migration and recovery:** take and verify a backup/export before moving an existing ledger. Restore or migrate the data into the production database, then verify the expected Sponsor operation and delegation tables, constraints, and indexes. Do not delete or suspend the source database until the new database has been checked and the rollback window has expired.
3. **Sponsor readiness:** call `GET /api/sponsor/status` from the production frontend origin. Require `databaseReady`, `ledgerDurabilityVerified`, `ownerAddressMatches`, `sponsorIndependent`, `sessionAuthenticationConfigured`, and `engineConfigured` to be true. `ledgerDurabilityVerified` is true only when all three explicit durability/backup/restore attestations are configured. If the Admin token is required, also require `adminTokenConfigured`. `transactionExecutionAvailable` is a configuration/readiness signal; it does not prove that the Sponsor wallet has enough TRX, Energy, or Bandwidth for a particular operation.
4. **Execution remains disabled until authorized:** keep `SPONSOR_TRANSACTION_ENGINE_ENABLED` and `SPONSOR_MAINNET_BROADCAST_ENABLED` false until the operator has checked the Sponsor address, private-key-derived address, Owner recipient, protected reserve, stake/top-up caps, fee cap, wallet funding, and exact operation intent. Enable only the operations the operator has approved.
5. **Deploy order:** merge the reviewed application change into the configured production branch, verify the Resource API build and health check, verify Sponsor status and read-only Mainnet resource responses, then verify the frontend against that API. Do not treat a successful `/health` response alone as proof that Sponsor database migrations or transaction execution are ready.
6. **Mainnet safety:** keep the existing TRӾ contract source and artifact unchanged. Contract deployment, token administration, and Sponsor transactions each require their own explicit authorization and live preflight; CI success is not authorization to broadcast.

The migration runner adds two mandatory operator attestations for the copy step (not for read-only preflight): `SPONSOR_MIGRATION_BACKUP_VERIFIED=true` and `SPONSOR_MIGRATION_ROLLBACK_PLAN_CONFIRMED=true`. Set the first only after confirming a recoverable source backup/export, and the second only after documenting that the source database will remain intact throughout the rollback window. The runner refuses to spawn the migration process when either attestation is absent or false. These flags are assertions, not automated proof that a backup can be restored; the restore drill remains a separate acceptance requirement.

The production database must have an independently verified backup and a tested recovery path. Never put database URLs, private keys, session secrets, Admin tokens, or RPC API keys in frontend build variables, source control, logs, or public status responses.


## No-card database continuity

If Render paid billing is unavailable, see [`docs/TRON-TRANSFER-NO-CARD-DATABASE-MIGRATION.md`](../../docs/TRON-TRANSFER-NO-CARD-DATABASE-MIGRATION.md) for the guarded migration path to an external PostgreSQL provider and the included `npm run migrate:sponsor-ledger` utility. A no-card free database is an interim continuity option only; keep Sponsor signing and broadcast disabled until durable backup, restore, availability, and Mainnet readiness requirements are independently met.


### Neon connection URLs

For Neon, configure server-side `DATABASE_URL` with the direct connection string and `DATABASE_URL_POOLED` with the pooled connection string. The Sponsor Resource API prefers `DATABASE_URL_POOLED` for normal runtime queries and falls back to `DATABASE_URL`. Use the direct URL as `TARGET_DATABASE_URL` for the one-off ledger migration. Never expose either URL through a `VITE_*` frontend variable or commit it to Git.

## PostgreSQL TLS mode compatibility

Sponsor API runtime pools, migration preflight pools, and migration copy pools normalize legacy PostgreSQL URL modes `sslmode=require`, `prefer`, and `verify-ca` to the explicit `sslmode=verify-full` setting. This preserves the strict certificate-and-hostname verification behavior currently provided by node-postgres 8.16 while avoiding its compatibility warning about future major-version semantics. Existing `verify-full` and local `disable` modes are preserved. The helper never logs or returns connection URLs, usernames, or passwords. Neon pooled URLs remain the preferred runtime connection; the one-time ledger migration continues to require the direct Neon endpoint.
