# TRON Transfer Resource API

The Resource API is the existing Tron Transfer application's Mainnet resource, wallet-operation, and transaction-verification backend. It is deployed as the existing Render Web Service. This project does not create a replacement application or a separate wallet dashboard.

**Network:** TRON Mainnet only. No testnet workflow is supported.

## Wallet architecture

The application has two independent wallet authorities:

- **Owner Wallet:** the existing Owner's imported wallet, used for TRӾ contract administration and deployment.
- **Sponsor Wallet:** a separate, import-only wallet used for Sponsor TRX, Stake 2.0, Energy and Bandwidth operations.

Each wallet has its own encrypted local vault and its own application session. The Owner and Sponsor addresses must be different. There is no Create Wallet flow and no requirement to connect TronLink or another injected browser wallet.

### Local vaults

The Owner and Sponsor vaults support importing an existing TRON private key, V3 Keystore JSON, or mnemonic. Vault data is encrypted in the browser using AES-256-GCM with PBKDF2-SHA256 (310,000 iterations). Unlocking derives the address again and verifies it against the saved vault address and the authenticated wallet role.

- The local private key is held in browser memory only while the vault is unlocked.
- The encrypted backup is stored in browser local storage; it is not a server-side key vault.
- Lock, logout, automatic inactivity lock, workspace exit and replacement clear the in-memory signer state.
- The Sponsor vault is independent of the Owner vault. Locking or replacing one does not replace the other.
- JavaScript strings cannot be reliably zeroized. Keep the browser and application origin trusted and patched.

The Owner/Sponsor workspaces share the same application origin and JavaScript runtime. Separate workspace navigation and encrypted vaults are not a hardened process or origin boundary against a same-origin script compromise. Use strong device security, protect the browser session, and never paste wallet secrets into chat, support tickets, logs or source control.

## Transaction signing boundaries

### Owner transactions

1. The Owner unlocks the existing local Owner vault.
2. The Resource API validates the Owner application session and prepares an exact unsigned Mainnet transaction with intent binding and fresh preflight.
3. The local Owner vault signs the exact prepared transaction.
4. The Resource API independently verifies transaction integrity, recovered signer and live account permission.
5. The signed transaction and transaction ID are persisted before broadcast.
6. The API broadcasts once and reconciles the original transaction against solidified Mainnet state.

The Owner private key is not sent to the Resource API. Owner operation and deployment APIs do not require TronLink.

### Sponsor transactions

Sponsor operations use a two-phase local-signing protocol:

1. `POST /api/sponsor/intent` creates a short-lived intent bound to Mainnet, Sponsor address, Owner recipient, operation, resource, amount and idempotency key.
2. `POST /api/sponsor/operations/prepare` validates the intent, checks the Sponsor write-control gate, builds and preflights the exact unsigned transaction, and persists that unsigned transaction in the Sponsor ledger before returning it.
3. The imported local Sponsor vault reviews and signs that exact transaction. The private key is never sent to the Resource API.
4. `POST /api/sponsor/operations/submit` verifies the exact transaction body, txID, recovered Sponsor signer and live TRON account permission. It repeats balance, protected-reserve, Bandwidth-fee and operation-specific resource checks immediately before broadcast.
5. The API commits the signed transaction and txID to the ledger before any broadcast attempt. It then reacquires the Sponsor write-control lock and makes one broadcast attempt.
6. The API reconciles the original transaction against solidified Mainnet state. An ambiguous result is never automatically re-signed or re-broadcast.

The legacy one-step endpoint `POST /api/sponsor/operations` returns HTTP 410 and cannot invoke a server-side signer. The Resource API does not use `SPONSOR_MAINNET_PRIVATE_KEY`, `SPONSOR_SIGNER_URL`, or a remote signer service.

Supported Sponsor operations are `stake`, `delegate`, `undelegate`, `unstake`, `withdraw`, and a bounded Sponsor-to-Owner native TRX `topup`. Sponsor operations cannot sign Owner TRӾ contract transactions.

## Sponsor API endpoints

- `GET /api/sponsor/status` — non-secret configuration, database, pause, durability and execution readiness.
- `POST /api/sponsor/session/challenge` and `POST /api/sponsor/session/verify` — wallet challenge authentication where the legacy signed-message session flow is used. Managed application sessions are supported separately.
- `POST /api/sponsor/intent` — create a short-lived operation intent.
- `POST /api/sponsor/operations/prepare` — reserve the idempotency key, prepare and persist an unsigned transaction.
- `POST /api/sponsor/operations/submit` — verify and persist a locally signed transaction before the one broadcast attempt.
- `GET /api/sponsor/operations` — read the Sponsor operation ledger.
- `GET /api/sponsor/operations/:idempotencyKey` — read and reconcile one operation without automatically rebroadcasting it.
- `POST /api/sponsor/ledger/bootstrap` — guarded schema bootstrap. It creates/extends the Sponsor ledger and leaves writes paused; it does not migrate historical data or enable execution.
- `POST /api/tron/sponsorship/resource-delegations/verify-wallet` — independently verify a recorded delegation against solidified Mainnet state.

Every Sponsor write requires the authenticated Sponsor identity, the independent Owner Admin authorization/CSRF check, the durable ledger, an unpaused control row, and explicit Mainnet execution gates. Missing or unreadable control state is treated as paused.

## Sponsor ledger schema and cutover

The Sponsor operation table stores the idempotency hash, request hash, operation, resource, amount, Sponsor and Owner addresses, status, transaction ID, prepared unsigned transaction, signed transaction, result code and confirmation block.

The guarded bootstrap creates or adds these columns:

- `prepared_transaction JSONB`
- `signed_transaction JSONB`

Readiness checks verify both columns. An existing table without either column is not accepted as ready. Runtime status/read routes are read-only; only the separately authorized bootstrap endpoint performs schema creation/extension.

The Sponsor control row defaults to `writes_paused=true`. Keep it paused through database identity verification, backup/restore acceptance, security review and release cutover. Do not bypass the guarded bootstrap route with direct SQL. Do not enable Sponsor writes merely because the schema exists.

### Sponsor environment variables

Configure these only on the existing Resource API service in Render. Never put secrets in frontend build variables.

- `SPONSOR_MAINNET_ADDRESS` — configured Sponsor Mainnet address. It must be valid and different from `TRON_OWNER_ADDRESS`.
- `TRON_OWNER_ADDRESS` — configured Owner recipient.
- `SPONSOR_SESSION_SECRET` — at least 32 bytes for signed short-lived Sponsor sessions.
- `SPONSOR_DATABASE_URL_POOLED` or `SPONSOR_DATABASE_URL` — optional dedicated Sponsor PostgreSQL connection; Sponsor-specific variables take precedence over shared `DATABASE_URL_POOLED` and `DATABASE_URL`.
- `OWNER_ADMIN_EXPECTED_DATABASE_IDENTITY_SHA256` — expected one-way fingerprint for the approved production database endpoint, database name and role. A missing or mismatched fingerprint blocks production acceptance.
- `SPONSOR_LEDGER_DURABLE=true`, `SPONSOR_LEDGER_BACKUP_VERIFIED=true`, `SPONSOR_LEDGER_RESTORE_TESTED=true` — operator attestations; set only after a non-expiring production database, recoverable backup and tested restore are independently verified.
- `SPONSOR_TRANSACTION_ENGINE_ENABLED=true` and `SPONSOR_MAINNET_BROADCAST_ENABLED=true` — both must be explicitly enabled before local-signing operations can execute. Keep both false until release approval.
- `SPONSOR_LIQUID_RESERVE_TRX` — protected liquid reserve; defaults to 2 TRX.
- `SPONSOR_STAKING_ENABLED=true` — explicit Stake 2.0 enablement.
- `SPONSOR_MAX_AUTOMATIC_STAKE_TRX` — maximum single stake amount; defaults to zero (disabled).
- `SPONSOR_MAX_OWNER_TOPUP_TRX` — separate maximum Owner top-up; if omitted, the configured stake cap is used.
- `SPONSOR_MAX_TX_FEE_SUN` — maximum authorized Bandwidth-shortfall fee in SUN; defaults to zero, so uncovered transactions are blocked.

There is no Sponsor private-key environment variable in the local-vault architecture. Remove any obsolete `SPONSOR_MAINNET_PRIVATE_KEY`, `SPONSOR_SIGNER_URL` or remote-signer HMAC secret from the existing Render service only after confirming the deployed production revision no longer depends on the old signer. This feature branch has not been deployed.

## Mainnet resource reads and RPC

For read-only account-resource, account-balance and chain-parameter queries, the Resource API preserves the existing **Tatum Mainnet primary → TronGrid fallback** routing. Configure `TATUM_API_KEY` and `TATUM_TRON_NETWORK=mainnet` to enable Tatum; `TATUM_TRON_RPC_URL` may select only the approved `https://tron-mainnet.gateway.tatum.io` origin. Tatum credentials stay server-side and are never returned by health or resource endpoints. `TRONGRID_API_KEY` is the fallback credential. When Tatum is not configured for Mainnet, reads use TronGrid directly. Provider cooldowns are isolated so a Tatum rate limit does not suppress the TronGrid fallback.

Signed transaction broadcast, transaction-history REST queries, Owner transaction preparation/verification, and Sponsor transaction preparation/verification continue to use the existing TronGrid Mainnet path. Tatum and TronGrid here are blockchain RPC/data connectivity only—not Energy/Bandwidth suppliers, fee sponsors, wallet custodians, or funding sources. The platform's own Sponsor wallet stakes its TRX, delegates its own Energy/Bandwidth directly to the configured Owner wallet, and can explicitly transfer its own TRX to Owner. No third-party resource provider or external Sponsor is configured.

TRON does not combine free Bandwidth and staked/delegated Bandwidth into one single-transaction allowance. The preflight uses the more conservative single-source coverage rule. The fee cap defaults to zero, so a transaction that needs an uncovered TRX fee is blocked. A provider API key does not grant Energy, Bandwidth or transaction authorization.

There is no protocol free Energy quota. This code does not claim or automate free Energy grants, free Bandwidth grants, or independent fee sponsorship. Resource estimates are not guarantees. Sponsor resource actions require explicit per-operation approval; no unattended scheduler is enabled.

## Owner Admin and TRӾ operations

Owner Admin continues to use the existing TRӾ pages and existing contract. The backend binds typed intent fields to the configured `TRAX_CONTRACT_ADDRESS`, prepares canonical Mainnet transactions, verifies the local Owner signature and live permission, persists the signed transaction before broadcast, and reconciles the original txID against solidified state.

Owner operation/deployment APIs remain guarded by the existing Owner session, exact intent, fee/resource preflight and durable ledger. Deployment artifacts are pinned by source, creation bytecode, runtime bytecode and manifest hashes. Contract deployment and token issuance are separate actions and each requires explicit confirmation and independent readiness.

Required Owner/deployment configuration includes:

- `TRON_OWNER_ADDRESS`
- `TRAX_CONTRACT_ADDRESS`
- `TRAX_SOURCE_SHA256`
- `TRAX_CREATION_BYTECODE_SHA256`
- `TRAX_RUNTIME_BYTECODE_SHA256`
- `TRAX_DEPLOYMENT_ARTIFACT_SHA256`
- `OWNER_MAX_FEE_LIMIT_SUN` and `TRAX_DEPLOYMENT_MAX_FEE_LIMIT_SUN`

Owner operation and deployment ledger durability flags and execution acknowledgements must remain disabled until migrations, backup/restore, artifact identity, contract state, wallet identity, Energy, Bandwidth and zero-TRX-burn preflight have been independently accepted. CI success does not authorize a Mainnet signature or broadcast.

The contract source `contracts/Restricted1TRAX.sol` is not changed by this wallet-architecture work. TRӾ is an owner-issued custom TRC-20 token, not native TRX; it has no implied reserve, collateral, redemption, guaranteed market price or free-energy entitlement.

## Database migrations and verification

Use the direct PostgreSQL URL and the documented explicit migration acknowledgements only after a verified snapshot and restore drill. The migration runner applies ordered SQL transactionally, stores SHA-256 checksums, refuses changed applied migrations and verifies required tables. Do not use transaction-pooler URLs for migration execution.

Useful commands from this directory:

- `npm test` — Resource API unit/integration tests.
- `npm run check` — Node syntax checks for the Resource API and migration scripts.
- `npm run migrate:owner-admin-ledgers` — guarded Owner Admin ledger migration; requires the documented acknowledgement and direct database URL.
- `npm run database:identity-fingerprint` — prints only the selected database variable, provider, connection mode and one-way identity fingerprint.
- `npm run migrate:sponsor-ledger` / `npm run check:migrate:sponsor-ledger` — Sponsor ledger migration utilities; follow their backup and rollback attestations.

For the integrated frontend, run `npm test` or `npm run build` from `Frontend-Tron-Transfer`. The build compiles the pinned TRӾ artifact, runs the frontend regression suite and builds the static site.

## Production cutover checklist

1. Keep this change on the feature branch until the complete CI suite and independent security review pass.
2. Verify the exact production Neon branch/database/role fingerprint and non-expiring database target.
3. Verify backup and restore; run the guarded Sponsor schema bootstrap only after Owner enrollment and explicit authorization.
4. Confirm Sponsor control remains paused and the two Mainnet execution flags remain false.
5. Deploy only to the existing Render frontend and Resource API services after merge approval.
6. Verify read-only Mainnet status, resource snapshots, Owner local signing and Sponsor local signing acceptance without broadcasting a real transaction.
7. Enable Sponsor writes or any TRӾ deployment only after a separate explicit release authorization and fresh Mainnet preflight.

Do not remove source databases or historical branches merely because a replacement exists. Preserve rollback evidence until acceptance is complete. Do not delete wallet keys, recovery data or transaction records as part of source cleanup.
