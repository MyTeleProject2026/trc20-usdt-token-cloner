# TRON Transfer Owner Admin — continuation handoff and completion tracker

> **Purpose:** This file is the durable context for continuing the existing TRON Transfer Owner Admin project in a new ChatGPT conversation. Read this file and `docs/OWNER_SPONSOR_WALLET_ARCHITECTURE.md` first. Do not ask the user to repeat requirements already recorded here.

## 1. Project identity and hard constraints

- Repository: `MyTeleProject2026/trc20-usdt-token-cloner`
- Existing production branch to update directly: `ui/modern-crypto-dashboard-theme`
- Frontend: existing Render Static Site `tron-transfer`, URL `https://tron-transfer.onrender.com`
- Backend: existing Render Web Service `tron-transfer-resource-api`
- Production network: TRON Mainnet only.
- Token: existing custom TRC-20 token `TRӾ`, six decimals. Preserve the current contract and on-chain state.
- Database: existing Neon production database. Do not create a replacement database or modify production records without a reviewed migration, backup and restore evidence.
- User explicitly requested direct commits to the existing branch: do not create a new branch or pull request for this work.
- Do not create a replacement application, repository or Render service.
- Do not add fake exchange features. The UI redesign must represent only capabilities already implemented in this application.
- No transaction should be signed or broadcast without explicit transaction-specific confirmation, fresh Mainnet preflight and durable operation persistence.

## 2. User's exact desired authentication and signing experience

The user has explicitly approved migrating the Owner and Sponsor signing identities to a protected server-side KMS/HSM signing service, with Owner Admin as the only application login and explicit confirmation for every transaction.

Required experience:

1. User signs into Owner Admin once.
2. The same authenticated platform session can open every authorized Owner and Sponsor workspace.
3. Workspace switching must not ask for a second account login, wallet connect, local vault unlock, or separate wallet password.
4. Existing Owner and Sponsor wallet addresses, balances, contract permissions and resource-delegation identities must remain independent.
5. Owner Admin authorization determines which application operations may be requested; it does not merge the on-chain accounts.
6. Backend signing selects the fixed Owner or Sponsor signing key based on server-side role/operation authorization. The browser cannot choose a KMS key or claim an arbitrary signer.
7. Every write operation displays an exact review and requires explicit final confirmation by the operator.
8. The correct existing wallet pays its own fees. Do not silently redirect transaction fees.
9. No silent/background blanket signing. An authenticated Owner Admin session is not approval for arbitrary transaction content.
10. No private keys, seed phrases, Owner Admin password, vault password or AWS credentials in localStorage/sessionStorage, GitHub, browser payloads, ordinary logs or source code.

## 3. Key technical point for KMS migration

AWS KMS supports imported asymmetric secp256k1 key material using `ECC_SECG_P256K1`. This allows preserving existing TRON addresses by importing the existing private key material into a KMS key created for external key material. Do not generate new KMS keypairs for existing wallets, because new public keys mean new TRON addresses.

KMS ECDSA signing output must be converted to TRON's 65-byte recoverable signature form. The backend must derive/verify the recovery byte and verify that the signature recovers to the exact existing configured Owner or Sponsor address. This adapter is not implemented yet and must be covered by cryptographic known-answer tests before it is connected to broadcast routes.

AWS references:
- https://docs.aws.amazon.com/kms/latest/developerguide/importing-keys.html
- https://docs.aws.amazon.com/kms/latest/developerguide/importing-keys-conceptual.html
- https://docs.aws.amazon.com/kms/latest/APIReference/API_CreateKey.html

The imported asymmetric key material is permanently associated with that KMS key and cannot be replaced with different material. Plan offline encrypted recovery, KMS key policy, IAM least privilege, CloudTrail audit, key disablement and a tested recovery procedure before production cutover.

## 4. Actual existing source architecture inspected

Branch source at commit `ebff578ebfb7502a6fa45e0dfd4a95cd7bfcd14a` includes:

- `Frontend-Tron-Transfer/resource-api/owner-wallet-auth-api.mjs`: Owner wallet session and paired Sponsor session-group issuance. It can create both session cookies when the configured Sponsor identity is enrolled and matches.
- `Frontend-Tron-Transfer/resource-api/sponsor-wallet-auth-api.mjs`: Sponsor role session lifecycle, including Sponsor session creation paired to the Owner session group.
- `Frontend-Tron-Transfer/resource-api/managed-wallet-identities.mjs`: currently reports signer custody as `encrypted-local-owner-vault` and `encrypted-local-sponsor-vault`.
- `Frontend-Tron-Transfer/src/managed-wallet-auth-client.mjs`: separate role clients and role-specific cookies/CSRF handling.
- `Frontend-Tron-Transfer/src/lib/device-wallet-vault.mjs`, `owner-wallet-vault.mjs`, `sponsor-wallet-vault.mjs`: browser-local encrypted vault/device key logic.
- `Frontend-Tron-Transfer/resource-api/owner-operation-api.mjs`: Owner operations currently accept a client-signed transaction, verify signer/intent/permission, persist signed operation state, broadcast and reconcile.
- `Frontend-Tron-Transfer/resource-api/sponsor-api.mjs` and `sponsor-engine.mjs`: Sponsor execution currently expects a local Sponsor signature; the ledger persists signed payload and transaction ID before broadcast and has pause/idempotency/reconciliation protections.
- `Frontend-Tron-Transfer/resource-api/trax-deployment-api.mjs`: existing deployment preparation/verification workflow; inspect its exact confirmation/signing path before KMS integration.
- `Frontend-Tron-Transfer/resource-api/wallet-signer-acceptance-api.mjs`: verifies local key control through a sign-only challenge; it does not perform a transaction or broadcast.
- `Frontend-Tron-Transfer/resource-api/server.js`: wires the existing Owner/Sponsor authentication APIs, Owner operations, Sponsor API, deployment API and signer acceptance API.

Important: paired Owner/Sponsor application sessions are already partly present. That does not mean the application is fully unified or that server-side signing exists. Browser-local signing remains active until the KMS migration is implemented and accepted.

## 5. Current branch repair committed in this continuation

A real runtime bug reported by the user was inspected against the actual production branch.

Error observed:
- Sponsor workspace UI showed a runtime failure involving `setOwnerAdminCsrfToken is not defined`.
- Source file: `Frontend-Tron-Transfer/src/SponsorWalletManager.jsx`.
- Root cause: code referenced the Owner Admin CSRF setter, but the matching React state declaration was missing.

Committed repair:
- Added `const [ownerAdminCsrfToken, setOwnerAdminCsrfToken] = useState('')`.
- Added a regression assertion to `Frontend-Tron-Transfer/tests/sponsor-workspace-runtime.test.mjs`.

Commits on the existing production branch:
- Runtime fix commit: `ea95810261d6b7a0d9294cb4b86527fdeba1f485`
- Regression test commit / branch head at time of architecture documentation: `ebff578ebfb7502a6fa45e0dfd4a95cd7bfcd14a`

The associated GitHub Actions runs were still in progress when this handoff was written. Re-check the current branch head and latest CI/frontend/uptime workflow results before claiming that the repair has passed or deployed.

No KMS keys were created or imported. No production AWS credentials were configured. No Mainnet transaction was signed or broadcast by this repair.

## 6. Screenshot findings and UI requirements

The user provided mobile screenshots showing the existing Owner and Sponsor application interfaces.

Observed UI surfaces:
- Sponsor workspace top menu: Overview, Resources, Automation, Activity.
- Sponsor wallet overview with refresh, lock, logout and replace controls.
- Sponsor wallet receive/deposit address, copy action, TRONSCAN link and refresh-deposits action.
- Sponsor Activity shows backend password session status, Mainnet network, security events, durable PostgreSQL ledger count, resource history and recent chain transaction records.
- Owner Portfolio shows separate native TRX, custom TRӾ and official USDT TRC20 balances; no verified TRӾ market quote; combined USD valuation withheld when no verified quote exists.
- Owner deposits display the configured Owner address and confirmed incoming native TRX/official USDT records.
- Owner Transfer tab includes sign-only acceptance, TRӾ Mainnet contract address, fee-limit input and existing TRX transfer review action.
- Owner More workspace lists existing functions: Deploy & verify, Owner issuance, External credits, Batch credits, Emergency pause, Minting authorization, Withdraw, Credit history, Ownership transfer, External balance lookup.
- Deployment readiness screen displays artifact/ledger checks, execution gate, Mainnet Energy/Bandwidth/fee fallback, read-only preflight and controls for check readiness, refresh resources, prepare deployment and verify contract state.

Observed errors/status:
- Sponsor live refresh returned HTTP 429. A 429 means the live read was rate-limited; do not represent old balances as fresh. Existing client cooldown mitigation may exist in later commits; diagnose upstream provider rate limits and confirm Retry-After handling.
- Owner Admin screenshot showed `Owner Admin session unavailable` and `setOwnerAdminCsrfToken is not defined`; the missing setter is now patched in the current branch. Re-test actual session restoration after CI/deployment.
- Deployment readiness screenshot showed owner native balance `0.000070 TRX`, Energy required with margin `1,301,089`, available Energy `0`, estimated bandwidth `6,906 bytes`, largest single available quota `600`, estimated TRX fallback `137.014900 TRX`, and both Energy/Bandwidth shortfalls. It explicitly stated read-only check, no persisted transaction, no signature requested and no broadcast attempted. This is a hard deployment blocker until a fresh preflight passes.
- Do not infer exact current balances/resources from old screenshots. Re-read live Mainnet data at the time of acceptance.
- Owner portfolio showed live quote unavailable and no verified TRӾ market quote. Do not infer TRӾ price from native TRX or invent a combined portfolio valuation.

UI target:
- Redesign the entire existing application in a consistent premium crypto-exchange style, using a cohesive dark graphite/black base, warm gold accent, readable neutral text and polished controls.
- Redesign the sidebar, top section menu, mobile navigation, workspace switcher, all existing Owner and Sponsor pages, nested pages, forms, tables, operation review, confirmations, status/error/loading/empty states and responsive mobile layouts.
- Each existing page should have its own clear information hierarchy and end-to-end flow, similar in polish and usability to major exchange dashboards, but only expose current implemented application functions.
- Do not add trading, conversion, generic exchange deposits/withdrawals, price claims, liquidity or other features not supported by the existing backend.
- Every visible button must call a real existing handler or a newly implemented backend capability. No decorative/fake-live controls.
- Preserve transaction review, explicit confirmation, real API data, ledger state and Mainnet safety gates.

## 7. Required completion stages

### Stage 1 — KMS preparation and identity preservation
- Confirm AWS account/region and who controls KMS key policies.
- Define Render-to-AWS workload identity/credential delivery securely.
- Prepare existing Owner and Sponsor private key material offline. Never send it through ChatGPT, GitHub or source files.
- Create separate `ECC_SECG_P256K1` `SIGN_VERIFY` KMS keys with external/imported material.
- Import each existing wallet key independently.
- Verify public key/address equivalence for both current TRON Mainnet addresses.
- Define key recovery, backup, expiry/disable alarms, IAM least privilege and CloudTrail.
- Do not enable KMS signing before independent address verification.

### Stage 2 — KMS TRON signer adapter
- Add AWS SDK dependency in Resource API.
- Implement a server-only KMS client with fixed role-to-key ARN mapping.
- Implement transaction digest calculation and exact transaction binding.
- Convert KMS DER ECDSA signature to TRON 65-byte recoverable signature.
- Verify the recovered address and transaction ID match the expected existing wallet and persisted unsigned transaction.
- Add cryptographic known-answer tests and negative tests for wrong role, wrong key, wrong digest, invalid DER, high-S normalization, wrong recovery ID, expiry, timeout, duplicate request and unavailable KMS.
- Disabled-by-default configuration; fail closed on missing config or any verification mismatch.

### Stage 3 — single Owner Admin session and authorization
- Consolidate UI authentication state into one Owner Admin session context.
- Keep secure server-side Owner/Sponsor role grants and operation-level authorization.
- Remove Sponsor separate login and ordinary local vault unlock prompts only after server-side signing is available and accepted.
- Workspace navigation must not generate new credentials or ask the user to reconnect wallets.
- Keep CSRF, origin checks, expiry, revocation, audit and rate limiting.
- Prove Owner Admin session can access authorized Sponsor workspace but cannot exceed configured permissions.

### Stage 4 — integrate KMS across all existing write paths
- Owner contract operations and issuance.
- TRӾ deploy/verify preparation and confirmation.
- External and batch credits.
- Emergency pause and minting authorization.
- Ownership transfer.
- Existing native TRX/USDT withdrawals and transfers.
- Sponsor stake/unstake, withdraw, delegate/undelegate and existing Sponsor transfers.
- Any other existing operation that currently expects local signed transaction.
- Every route must load a persisted prepared transaction, revalidate it, require explicit confirmation, sign using the fixed role KMS key, verify the recovered signer and exact intent, persist signed bytes/txID before broadcast, broadcast once and reconcile solidified receipt.
- No generic arbitrary-digest signing endpoint accessible to browser clients.

### Stage 5 — full UI redesign and acceptance
- Inspect every route and component from the current branch tree.
- Redesign each existing page and nested action in a consistent exchange-style layout.
- Preserve the actual data sources, API contracts, operation handlers and confirmation semantics.
- Test all navigation and buttons on mobile and desktop.
- Fix all runtime errors and all 429/5xx handling; do not hide provider outages by showing stale data as current.
- Test Owner/Sponsor session restoration, workspace switching, logout, revocation and recovery.
- Run all frontend, Resource API, contract and repository CI suites.

### Stage 6 — production release
- Verify exact production commit.
- Verify Neon database identity, backup and restore.
- Configure KMS and Render secrets using secure dashboard/role mechanisms.
- Perform read-only KMS address acceptance before any signing.
- Keep Mainnet write gates disabled until security review and resource preflight pass.
- Enable writes in controlled operation families with explicit user authorization.
- Verify signed transaction persistence, one-time broadcast, transaction ID and solidified Mainnet receipt.
- Confirm both existing Render services deployed and healthy.
- Keep rollback/recovery procedure ready. Do not remove old local vault recovery until KMS cutover has been accepted.

## 8. Current blockers / do not claim completed

- KMS AWS account/region/role configuration is not supplied or connected in this chat.
- Existing Owner/Sponsor private keys have not been imported into KMS.
- KMS signing adapter and TRON recoverable signature conversion are not implemented.
- Owner/Sponsor transaction endpoints still rely on local signed transaction payloads.
- Full single-login UI cleanup is not accepted.
- All existing Owner/Sponsor pages have not been manually browser-tested.
- Complete page-by-page exchange-style redesign is not finished.
- Latest CI/deployment status for the CSRF setter repair must be checked.
- Live resource 429 issue needs current provider diagnosis.
- Deployment readiness previously failed for insufficient Energy/Bandwidth/TRX; fresh live preflight required.
- No Mainnet KMS signing/broadcast acceptance has been performed.

## 9. Instructions to the next ChatGPT conversation

Start by reading:
1. `docs/TRON_TRANSFER_OWNER_ADMIN_CONTINUATION_HANDOFF.md` (this file).
2. `docs/OWNER_SPONSOR_WALLET_ARCHITECTURE.md`.

Then:
- Inspect the current head of `ui/modern-crypto-dashboard-theme`; do not assume the commit listed here is still latest.
- Check latest GitHub Actions results and Render service deployment status.
- Continue direct implementation on this same branch. Do not create another branch or PR.
- Make source changes in small, testable commits; run tests after each backend/security change.
- Never expose or request private keys, seed phrases, vault passwords, AWS credentials or other secrets in chat.
- Do not say KMS signing is complete until both addresses are verified, every transaction path is integrated, signature conversion tests pass, security review passes and production acceptance is recorded.
- Do not remove the local vault or enable Mainnet write gates before rollback, key recovery and KMS acceptance are proven.
- Keep the TRӾ contract and all existing on-chain state unchanged.


## 10. Further direct implementation added after this handoff was first written

The existing production branch now also contains a KMS signer foundation:

- `Frontend-Tron-Transfer/resource-api/kms-tron-signer.mjs`
- `Frontend-Tron-Transfer/resource-api/tests/kms-tron-signer.test.mjs`
- `@aws-sdk/client-kms` declared in `Frontend-Tron-Transfer/resource-api/package.json`
- Resource API syntax-check command includes the new signer module.
- Resource API README now describes the adapter and explicitly states it is not active in transaction routes.

The adapter is disabled unless `TRON_KMS_SIGNING_ENABLED=true`, requires separate Owner/Sponsor key ARNs, checks KMS key type/usage/algorithm, derives the public-key address and compares it to the configured existing TRON identity, validates txID against SHA-256(raw_data_hex), requests KMS ECDSA signing over the 32-byte digest, parses DER, normalizes low-S, and tests recovery IDs until the signature recovers to the configured TRON address. It returns a TRON 65-byte recoverable signature only after that check.

**This is not yet the complete KMS migration.** It is not called by Owner operation confirmation, TRӾ deployment, or Sponsor transaction submission. No KMS keys/credentials exist in production from this work. Existing browser-local signing remains active. Do not enable `TRON_KMS_SIGNING_ENABLED`.

The adapter currently depends on the existing frontend package's `ethers` dependency for public-key/signature recovery and the Resource API's new AWS SDK KMS dependency. Confirm CI resolves both dependencies in the Render build environment. Cryptographic KMS known-answer tests against a real test key, integration into every transaction path, and independent security review are still required.

Updated commits after the earlier runtime repair:
- KMS adapter: `ce3edf05a80b36a80e2d35511eb6618805f8f866`
- Resource API dependency/check: `735d02d4563562bfbd3d2882a44d5f08743c8486`
- KMS unit tests: `51c75d49891aa8892c6e48cbfc3d694e2cd71f53`
- distinct-key enforcement: `4f35a088c89e913ee9fffab3a0a48f82b144e6ce`
- distinct-key regression test: `558649ba3dbb1ea408a88ae54ad0682fc1426657`
- Resource API README status: `be9641dd66562c124fe8e42b54e043d0c7f595ff`

Before continuing, inspect the current branch head because additional documentation commits may have advanced it.
