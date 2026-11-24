# Tron Transfer production acceptance layer

This release adds a read-only acceptance endpoint and a production smoke command. It does not activate Sponsor writes or authorize Mainnet broadcasts.

## Read-only endpoints

- `GET /health`: confirms that the Resource API process is serving requests and identifies the configured TRON network.
- `GET /api/acceptance/production`: returns the Sponsor/Owner acceptance checklist, database connectivity/schema state, and explicit execution-gate state.
- `GET /api/sponsor/status`: existing detailed Sponsor readiness response.

The acceptance endpoint is diagnostic only. It does not create schema, migrate data, sign transactions, or broadcast transactions. It returns check IDs and states, not private keys, API tokens, database URLs, or session secrets. The database-target check requires the Resource API environment variable `OWNER_ADMIN_EXPECTED_DATABASE_IDENTITY_SHA256` to match the fingerprint computed from its selected database URL. The fingerprint includes endpoint hostname, database name and role, but excludes the password; it is safe for diagnostics and cannot be used to connect to the database. If `OWNER_ADMIN_DATABASE_URL` is configured, it is the canonical direct endpoint for migrations and deployment persistence. Sponsor runtime queries may use a pooled URL, but acceptance fingerprints the direct Owner Admin endpoint to avoid treating a Neon pooler hostname as a different logical database.

## Acceptance checks

The live endpoint reports these server-side checks only:

1. Configured Owner Mainnet address is valid.
2. Sponsor Mainnet address is valid and distinct from Owner.
3. Sponsor address configuration is present and independent.
4. Sponsor ledger database is configured.
5. Selected database target matches the operator-approved Neon endpoint, database name and role fingerprint.
6. Sponsor operations table, prepared/signed payload columns, and control row are present.
7. Backup and restore acceptance flags are set.
8. Sponsor writes remain paused.
9. Independent Owner Admin authorization is configured for Sponsor administration.
10. Managed wallet session authentication is configured.
11. The local Sponsor signer execution path is available in code/configuration.
12. Mainnet execution remains explicitly disabled during acceptance.

The endpoint does **not** claim to prove that a browser vault is unlocked, that a user has completed Owner or Sponsor enrollment, or that a real wallet signature has been produced. It also does not exercise pending-owner transaction acceptance or password recovery. Pending-owner acceptance now uses an ephemeral local signer imported in the browser; its private key is not persisted or sent to the API. These remain separate browser and integration acceptance gates.

The Owner local-signing path, pending-owner acceptance, role-scoped password recovery, session revocation, persistence-before-broadcast, and solidified recovery have dedicated source and regression tests. Passing those tests is not a substitute for a real browser acceptance run against the deployed build.

A passing server-side report is labelled `ready-for-independent-review`, not production-approved. Operator evidence, independent review, and explicit release approval remain mandatory. The API always reports `executionEnabled: false` in this acceptance report.

## Run the production smoke check

Run from `Frontend-Tron-Transfer/resource-api`:

```sh
TRON_TRANSFER_API_BASE_URL=https://<existing-resource-api-host> npm run smoke:production-acceptance
```

The command uses HTTPS only, refuses redirects, checks the health and acceptance endpoints, reports blocked check IDs, and exits non-zero if a required check is missing or Mainnet execution is not confirmed disabled. It does not require or accept any secret.

## Owner and Sponsor browser acceptance

Use the existing production frontend in a real desktop and mobile browser. Do not paste passwords, private keys, seed phrases, session cookies, or database credentials into browser developer tools.

- Confirm the Owner workspace loads and navigation works. Owner access requires the independent managed Owner password session and unlock of the encrypted local Owner Wallet; the imported vault address, authenticated Owner session address, configured Owner address and transaction owner must all match. No TronLink connection is required.
- Confirm the Sponsor workspace loads independently and displays the Sponsor identity separately.
- Confirm read-only Sponsor status is visible and blocked checks are clearly labelled.
- Confirm browser storage, page source, network responses, and console output contain no Sponsor or Owner private key, static Sponsor Admin token, session secret, or database URL. Confirm Sponsor transaction requests include the independent Owner session cookie and Sponsor CSRF proof, without any private-key or static admin-token header.
- Confirm navigation, reload, logout/session expiry, narrow mobile viewport, keyboard focus, and error/empty states.
- Confirm no Owner or Sponsor page silently submits, signs, or broadcasts a transaction during page load or status refresh.
- Confirm Owner deployment and contract-operation prompts appear only after explicit confirmation and fresh resource preflight. The encrypted local Owner Wallet must sign the exact persisted unsigned transaction; the Resource API must reject missing, mismatched or invalid signatures and must persist the verified signature before broadcasting.
- Keep all write controls disabled while acceptance is in progress.

Browser acceptance must be recorded with browser/version, viewport, build commit, route, observed result, and timestamp. A screenshot alone does not prove signing custody or transaction safety.

## Release gates not automated by this layer

- A real Neon database snapshot/backup and restoration drill must be evidenced independently; environment flags are operator attestations, not proof.
- Apply Owner Admin migrations only with the direct PostgreSQL endpoint after the backup/restore gate. Set `OWNER_ADMIN_EXPECTED_DATABASE_IDENTITY_SHA256` to the independently verified target fingerprint; the runner refuses a missing or mismatched host/database/role pin and rejects Neon pooler endpoints. Then verify migration checksums and required tables.
- Owner encrypted-local-vault signing must be tested with broadcast disabled and the recovered signature verified against the configured Owner address and live permission.
- Sponsor encrypted-local-vault signing must be tested with broadcast disabled and the recovered signature verified against the configured Sponsor address; Owner and Sponsor session, vault, and signer identities must not cross-authorize.
- Owner and Sponsor recovery tokens must be generated for the intended role, consumed once, and verified not to cross-authenticate the other wallet role.
- Process-restart recovery must be exercised against a non-production or safely isolated test ledger.
- Mainnet deployment and pending-owner acceptance remain disabled until artifact pins, live resource coverage, database durability, backup/restore evidence, independent security review and explicit approval are complete.
- Mainnet stake/delegation and funding acceptance require separately approved operations and chain evidence.
- Do not enable Mainnet execution merely because this diagnostic returns HTTP 200.

## Database restoration and migration checksum reconciliation

The isolated restore rehearsal was performed from the existing Neon snapshot on branch `br-royal-shadow-be3pzyvg`. The six current migration files were replayed transactionally and the restored Owner Admin schema was compared against production using a stable catalog fingerprint over Owner/Sponsor-control columns, defaults, constraints, indexes, sequences, triggers, policies, functions and table properties. Both branches produced fingerprint `0eb0424ecbab1e18a0ab5db74ea2bfe0251956faba02b3cbcfc3e0146ce804df`.

Production's six migration-ledger checksum values are legacy values from the earlier migration source. They do not equal the current file hashes, even though the catalog fingerprint matches. The migration runner now recognizes only those six exact legacy values and updates them to the current file hashes only after the complete schema fingerprint matches. An unknown checksum or schema drift aborts and rolls back. The restored branch ledger was updated to the current file hashes for this rehearsal; production's ledger was not directly modified.

The Sponsor operations table is intentionally excluded from this Owner Admin fingerprint because it is a separate guarded Sponsor bootstrap. It exists on the restored snapshot branch but remains absent on live production until the authenticated bootstrap endpoint is run after deployment and Owner enrollment.

## 2026-11-24 production backup and restore drill

A fresh Neon branch clone was created from the live production branch immediately before the pending Sponsor-ledger bootstrap:

- Production source: `br-proud-mud-bexgns9g` (`production`)
- Pre-bootstrap backup clone: `br-damp-glade-bed0ds7s` (`owner-admin-pre-sponsor-bootstrap-backup-2026-11-24`)
- Restore drill clone: `br-floral-truth-beqdyv9s` (`owner-admin-restore-drill-2026-11-24`), created from the backup clone.
- All three branches reached Neon state `ready`.

The migration runner's exact `OWNER_ADMIN_SCHEMA_FINGERPRINT_SQL` was executed unchanged against all three branches. All three returned:

`0eb0424ecbab1e18a0ab5db74ea2bfe0251956faba02b3cbcfc3e0146ce804df`

The six-row Owner Admin migration ledger was also compared across production, backup and restore drill. All six version/checksum pairs match exactly across the three branches. The production legacy checksums are intentionally retained until the guarded migration runner performs its in-transaction reconciliation after validating the expected schema fingerprint.

The restore drill contains the expected Owner Admin tables, indexes and Sponsor control row. Owner accounts, sessions, Owner operations, deployments and pending-owner acceptances are all zero on the production, backup and restore branches; Sponsor writes remain paused.

**Remaining production database blocker:** `public.tron_transfer_sponsor_operations` is still absent on production, the backup clone and the restore drill. It exists on the older 2026-11-23 restore rehearsal branch only. The fresh backup/restore exercise proves the current production schema and migration ledger can be cloned and restored; it does not bootstrap Sponsor operations or authorize writes.

A Neon manual snapshot could not be created because the project had reached its snapshot quota. No existing snapshot or branch was deleted to make room. The fresh protected-by-branch-lineage clone remains available as the pre-bootstrap recovery point; Neon protection could not be enabled because the plan's protected-branch quota is full.

No production table was altered, no migration was applied, and no Sponsor write gate was changed during this drill.

## First Owner and Sponsor enrollment — one-time bootstrap secrets

The managed wallet-auth routes use two independent, one-time enrollment secrets. Configure both on the **existing Render Resource API Web Service only**; never add them to frontend build variables, source files, GitHub Actions output, or browser storage.

- `TRON_OWNER_ENROLLMENT_TOKEN` authorizes the first Owner enrollment at `POST /api/wallet-auth/owner/enroll`, sent in the `x-owner-enrollment-token` request header.
- `TRON_SPONSOR_ENROLLMENT_TOKEN` authorizes the first Sponsor enrollment at `POST /api/wallet-auth/sponsor/enroll`, sent in the `x-sponsor-enrollment-token` request header.

Each value must be an independently generated random secret of at least 32 bytes. Generate each separately on a trusted local machine (do not reuse one value for both roles):

```sh
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

The command emits a 43-character base64url token. Run it twice, once for each variable. Paste each generated value directly into the matching Render environment variable field and save/redeploy the existing Resource API. Do not paste either value into ChatGPT, GitHub, frontend configuration, or logs. If a token is exposed, replace it before enrollment.

Before enrollment, verify that the existing Resource API has the intended Mainnet Owner and Sponsor addresses configured and that they are valid and distinct. The Owner enrollment route refuses enrollment unless both identities are ready and distinct. The enrollment request also requires a new application password meeting the current minimum 12-character policy. This password is separate from the local wallet-vault unlock password; never send either password to ChatGPT.

Check `GET /api/wallet-auth/owner/status` and `GET /api/wallet-auth/sponsor/status` before enrolling. Each role can be enrolled only once; a repeat returns HTTP 409. After a successful first enrollment, remove the corresponding enrollment token from the Render environment and redeploy the Resource API. Keep recovery procedures available before removing access to the only bootstrap mechanism.

The Sponsor ledger bootstrap is a separate operation from Sponsor account enrollment. It requires an authenticated Owner Admin session, Owner CSRF proof, the explicit confirmation string `INITIALIZE_SPONSOR_LEDGER_SCHEMA`, and a matching approved database identity. It creates the Sponsor operations schema but leaves Sponsor writes paused. Do not enable transaction execution as part of enrollment or schema bootstrap.
