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


## 11. Focused exchange-workspace redesign changes (2026-11-28)

Direct commits on the existing production branch:
- `04a64ff4a67af8e4c37daae1e3b8150fa0201e6d` — Owner workspace now renders page-specific headings/descriptions and breadcrumbs; shared contract/fee configuration is progressively disclosed in a collapsible settings panel; local signer acceptance is limited to Deploy & Verify and Portfolio rather than repeated on every operation page.
- `bfbc3889dc77c23923fc6f290523019e75687952` — black/graphite and orange exchange visual layer for focused page headings, network status, compact advanced settings and responsive mobile layout.
- `4bddc328dcc50523447d9f365b19aca5e3650ec7` — removed duplicate Sponsor internal tab bar; added a compact Sponsor page context label and use the shared sidebar/mobile navigation.
- `02a4325e881614a51f3a76ee00612ba05dddc5d8` — Sponsor context visual styling.
- `74b093c35fb05586bc75d415869a49f264d78d96` — KMS signer now requires both Owner and Sponsor key ARNs and rejects a shared key.
- `d3fc29f1ca3dd6e611d4515469be91e1d9355934` — added regression coverage for missing and shared KMS key configuration.
- `f860905ffc8dbce5725b4929c90f3534a7d373f4` and `6808c7f897b8d20835507f3abc58bf2083212fce` — frontend tests updated to assert the new focused page structure and single shared Sponsor navigation.

The existing route IDs and existing operation handlers were preserved. This is an incremental visual/workspace refactor, not a complete page-by-page rebuild of every nested operation form. The shared Owner contract/fee configuration is now collapsed by default except on Deploy & Verify; operators can expand it where necessary.

The frontend CI run before the test expectation update failed because two tests asserted the removed generic Owner heading and duplicate Sponsor tab bar. Those assertions were updated to match the new UI. Verify the latest workflow after these commits before claiming the frontend build passes.

**Still not complete / not safe to release as final acceptance:**
- KMS signer remains a foundation only and is not wired into Owner confirm or Sponsor submit endpoints. Existing local vault signing remains the active path.
- KMS keys and Render workload identity have not been provisioned. Keep `TRON_KMS_SIGNING_ENABLED` unset/false.
- Owner Admin login still requires the independent local vault/device recovery path where the browser device key is absent or an old vault needs one-time migration. Sponsor vault recovery remains separate where needed.
- All Sponsor operations still use local Sponsor signing and existing Sponsor session semantics; a single Owner login does not magically remove the cryptographic Sponsor key boundary.
- The Sponsor page-specific content still needs a dedicated design pass beyond its duplicate-tab removal.
- Owner Withdraw currently contains both native TRX and official USDT subflows; they still need separate focused sub-pages without changing their underlying handlers.
- Full screenshot-driven desktop/mobile review and browser QA across every route remain outstanding.
- Production acceptance still requires all latest frontend/API CI, live service deployment checks, read-only Mainnet preflight, database durability/restore acceptance, and independent security review. No Mainnet transaction is to be initiated as a test.


## 12. Direct production-branch continuation — 2026-11-28

All changes below were committed directly to the existing branch `ui/modern-crypto-dashboard-theme`; no replacement branch or PR was created for this work.

### 12.1 Current UI implementation

- Owner mobile primary navigation now has five destinations in the requested order: Home, Deploy, Monitor, Assets, Profile. Sponsor mobile navigation remains its own Overview, Resources, Activity, and More pattern.
- Desktop sidebar continues to expose grouped existing Owner and Sponsor routes. The top workspace switch now uses compact Owner/Sponsor icon controls.
- Home now uses a compact AETHERIA overview launcher instead of rendering the entire monitoring dashboard as one long page. It presents status-backed launch cards for Multi-Hub Observability, Service Topology, MCP Execution Router, Live Infrastructure, Mainnet Connection, TRON Mainnet Resource Hub, Render Telemetry, External Uptime, Confirmed Chain Activity, and Function Return Bus. Selecting a card opens Live Monitor.
- Live Monitor now has nine focused section tabs and only renders the selected section: Service Topology, MCP Execution Router, Live Infrastructure, Mainnet Connection, TRON Mainnet Resource Hub, Render Telemetry, External Uptime, Confirmed Chain Activity, Function Return Bus. All telemetry continues to use the existing read-only Resource API and polling logic.
- Assets is now labelled as a distinct workspace. Its launcher opens the existing Deposits, Withdrawals, Credit History, Ownership Transfer and External Balance pages. Deposit history is rendered on its own route instead of occupying the Assets overview.
- Deploy & Verify now has shortcut cards to the existing Owner Issuance, External Credits, Batch Credits, Emergency Pause and Minting Authorization pages.
- Owner Admin authentication modal now uses the graphite/ember exchange visual language. The actual authentication/signing architecture has not been changed by styling.
- Native TRX and Official USDT withdrawals remain separate pages, with their existing transaction handlers and safety checks.
- Sponsor still uses its own independent workspace routes and only mounts the selected page. The existing Sponsor ledger and authorization checks are retained.

### 12.2 Sponsor rate-limit repair

- `SponsorWalletManager.jsx` now preserves HTTP 429/503 status and Retry-After metadata instead of replacing the error with a generic Error.
- Manual and automatic refresh attempts are paused for a bounded 15–300 second cooldown after 429/503, preventing refresh loops from amplifying provider rate limits.
- The current production-branch source already declares and initializes `ownerAdminCsrfToken` and `setOwnerAdminCsrfToken` in the Sponsor component. The previously reported undefined-setter diagnostic is not present in the current source. Confirm the deployed Render build is on the current branch commit before treating an old browser error as a current source defect.
- The old `Cannot access 'ln' before initialization` Sponsor diagnostic is not present as an `ln` binding in the current SponsorWalletManager source. Recheck the exact deployed bundle and browser console if it recurs.

### 12.3 Main asset valuation rule — preserve safety

- Native TRX, official USDT and TRӾ quantities remain separate.
- TRӾ has no verified market quote. Do not infer a TRӾ price from native TRX or display a synthetic combined USD total when TRӾ holdings are non-zero.
- The Assets UI may show verified reference valuations for native TRX and USDT, but must preserve the no-verified-TRӾ-quote disclosure.

### 12.4 Direct commits in this continuation

- `a45abddd66503689a46b0693729c0c6ac4faca2c` — add Owner Monitor and Profile routes and compact workspace switch.
- `0476bea73fc9b9edff9592687123bf652a6726c6` — five primary Owner mobile tabs.
- `41ff067c3e9204ad0f49b9c8c0c9ff42adf34633` — compact Home status launchers and nine focused Monitor tabs.
- `799487b66126c25f7bcbda766f25ae9e06d697a0`, `ef490c3db30c73aa8d0f41065dc079b316ea2310`, `fa22a5fad18a0c225d1395d322a8d13b8ce39889` — responsive overview and Monitor section styles/selector repairs.
- `9f91961cc330d111b7599deae351696dad7bcf51` — dedicated Deposits route.
- `d3a3d1e0c3c977986057a28c7bb66687ed3d2cae` — Assets shortcut launcher and route wiring.
- `de9138e1985f801dbf224747c8a8a2c57763c0c5` — responsive Assets shortcut styling.
- `d3e4730944bd1208337801d01563feff9f301e07` — Sponsor 429/503 cooldown implementation.
- `cc6488c4f6a083194ef87d2a0a46f80ca049242c`, `dd5a39ee685dc87a9949c5eeccb6c41d5a1d9e2a`, `2a07505e1400242b95309a61d0f3aea730d43b53`, `414a8f4dfc1337da3de07e8c29dbdcfd3c163052` — regression tests updated for the new navigation and focused workspaces.
- `c10584cd8776a2d384758ce45fb0352f9bf01d61` — fixed an Owner route conditional JSX build error found by CI.
- `6a0d93ccb03530edcf8da28d82d419465effa0c7`, `5b4fea77e94bb85b8953907ebb31bf6077fbe229` — Deploy & Verify shortcut cards and responsive styling.
- `020077151b93837a3a282b482a410df62dedeafb` — premium Owner Admin login styling.

### 12.5 CI observations

- A frontend build failure occurred after the first route refactor because of a missing JSX expression terminator in `App.jsx`; it was fixed in `c10584c`.
- A later frontend workflow completed successfully on `5b4fea7`; the run reported all 200 frontend tests passing and the production build succeeding.
- The latest commit at the time this section was written is `0200771`; its CI/frontend/uptime workflows must be checked again before claiming the latest source revision is green.
- No Mainnet transaction, deployment, withdrawal, staking, delegation, signing or broadcast was initiated by these changes.

### 12.6 Pull-request cleanup

- PR #314 (Owner Admin session error / Sponsor refresh throttling / premium exchange UI) was closed as superseded after its relevant Sponsor cooldown behavior and visual treatment were implemented directly on the production branch.
- PR #303 (older institutional-fintech workspace redesign) was closed as superseded by the newer direct exchange-style workspace work.
- Their head branches were not deleted: the available GitHub connection in this session exposes branch listing/creation and pull-request updates but no branch deletion operation. Do not claim those refs were deleted.
- Other open PRs were preserved pending individual source comparison. In particular, do not close/delete the Owner/Sponsor managed-identity migration, Owner database identity, Sponsor ledger bootstrap, Sponsor render-isolation, or proxy-aware rate-limit work without proving the changes are already incorporated.

## 13. Remaining six-stage production completion plan

### Stage 1 — Unified Owner Admin application authorization

Partly implemented: Owner login can establish paired Owner/Sponsor application sessions. Not complete: Sponsor workspace still retains separate vault lifecycle UI and local key unlock dependencies. The desired end state is one Owner Admin application session with role-scoped Owner/Sponsor permissions, no workspace re-login, and no separate wallet unlock when the managed signing service is fully provisioned.

### Stage 2 — Role-separated server-side signing

Not complete. `kms-tron-signer.mjs` exists and has DER parsing, low-S normalization, public-key/address verification, role-specific key ARN checks and signature-recovery validation. It is not wired into Owner operation confirmation, TRӾ deployment confirmation or Sponsor submit/broadcast. The current active paths remain local Owner/Sponsor vault signing.

Required before enabling KMS:
1. Provision two distinct AWS KMS asymmetric secp256k1 keys.
2. Import the existing Owner and Sponsor private-key material into their respective KMS keys so the existing TRON addresses are preserved; do not generate replacement keys.
3. Verify each KMS public key derives to the configured on-chain address.
4. Configure least-privilege Render workload identity/IAM, CloudTrail audit and role-specific environment configuration.
5. Integrate KMS signing into each operation after exact transaction review, explicit transaction-specific confirmation, fresh preflight and durable intent persistence.
6. Add cryptographic known-answer tests, signature-recovery tests, replay/idempotency tests and failure/reconciliation tests.
7. Keep `TRON_KMS_SIGNING_ENABLED` disabled until all gates pass. Do not fall back silently to a different wallet or key.

This cannot be honestly marked complete from source changes alone; the existing private key material, AWS account/KMS provisioning and Render IAM configuration are external prerequisites.

### Stage 3 — Complete exchange-style desktop/mobile redesign

Partly implemented: compact Home, five Owner mobile destinations, nine focused Monitor tabs, Assets launcher, Deploy shortcuts, separate Sponsor navigation and premium login styling. Remaining: full screenshot-driven review of every Owner and Sponsor page, consistent top bar/sidebar responsive states, tables/forms/detail panels, profile/security layout and page-specific mobile interaction testing.

### Stage 4 — Guided one-operation-at-a-time workflows

Partly implemented: existing TRX and USDT withdrawal pages are separate; deposit is separate; existing token operations are routed to their own pages; deployment has existing readiness/preflight/confirmation/verification gates. Remaining: present deployment as distinct Configure → Review → Preflight → Confirm → Execute → Verify screens, and apply the same staged layout to each existing Sponsor write operation without changing backend transaction semantics.

### Stage 5 — Browser QA and production deployment verification

Pending for the latest commit. Required: desktop and mobile browser tests, login/session restoration tests, Sponsor route crash regression tests, 429 cooldown tests, keyboard/focus tests, visual checks at common breakpoints, Render deploy commit verification and live read-only endpoint checks. Never use a Mainnet transaction as a smoke test.

### Stage 6 — Final acceptance and repository cleanup

Pending. Reconcile every open PR against the production branch before closing it; remove only proven duplicate/unneeded branches after confirming no PR depends on them and no unique unmerged work would be lost. The currently available GitHub integration cannot delete branch refs, so use GitHub UI or a separately authorized branch-delete tool for that operation. Retain security, dependency and recovery history. Complete final security review, DB backup/restore proof, Mainnet read-only readiness, contract verification and TRONSCAN checks.

**Acceptance rule:** Do not call the platform production-ready until Stages 1–6 are evidenced by code, passing tests, verified deployment, external key custody configuration, and browser acceptance. Keep Mainnet writes locked until the relevant deployment and operation gates pass.


### 12.7 Latest verification snapshot after documentation commit `915a3849`

- GitHub CI: **success** on `915a3849fc5087c35c21d1c8929491e54b384791`.
- Frontend build/tests and uptime probe: **success** on immediately preceding code commit `020077151b93837a3a282b482a410df62dedeafb`; frontend tests passed and production build completed.
- Uptime probe on `915a3849`: frontend HTTP 200; Resource API health HTTP 200; Owner resource read HTTP 200; TronScan HTTP 200; Sponsor readiness HTTP 200; owner/sponsor sign-only endpoints correctly returned unauthenticated HTTP 401; runtime, uptime history and Render metrics passed. One probe failed only because the Mainnet RPC provider-health endpoint returned HTTP 200 after 5,040 ms, exceeding the probe's latency threshold. Both Tatum and TronGrid reported the same block height. Treat this as a latency warning, not an RPC outage.
- Live Owner resource snapshot: Energy available 0; free Bandwidth 600; staked/delegated Bandwidth 0. Mainnet deployment remains blocked.
- Live Sponsor readiness: database and durable ledger checks passed, but wallet enrollment and both signer-acceptance checks were false; writes remain paused and transaction execution is unavailable/disabled. Do not enable Sponsor writes or Mainnet broadcast.
- Render deploy revision was not independently checked because the Render connection lists multiple workspaces and requires the user to confirm which workspace to inspect. Ask the user to confirm the production Tron Transfer workspace before reading deployment details.

### 12.8 Branch/PR cleanup status

- Closed as superseded: PR #314 and PR #303.
- Their branch refs remain in GitHub because this session's GitHub connector does not expose branch deletion. Do not state they were deleted.
- Other open PRs remain intentionally untouched pending per-PR reconciliation; do not mass-close dependency, security, managed-wallet identity or Sponsor ledger work without reviewing their diffs.
