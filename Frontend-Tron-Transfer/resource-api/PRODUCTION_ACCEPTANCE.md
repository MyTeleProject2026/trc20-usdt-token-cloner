# Tron Transfer production acceptance layer

This release adds a read-only acceptance endpoint and a production smoke command. It does not activate Sponsor writes or authorize Mainnet broadcasts.

## Read-only endpoints

- `GET /health`: confirms that the Resource API process is serving requests and identifies the configured TRON network.
- `GET /api/acceptance/production`: returns the Sponsor/Owner acceptance checklist, database connectivity/schema state, and explicit execution-gate state.
- `GET /api/sponsor/status`: existing detailed Sponsor readiness response.

The acceptance endpoint is diagnostic only. It does not create schema, migrate data, sign transactions, or broadcast transactions. It returns check IDs and states, not private keys, API tokens, database URLs, or session secrets. The database-target check requires the Resource API environment variable `OWNER_ADMIN_EXPECTED_DATABASE_IDENTITY_SHA256` to match the fingerprint computed from its selected database URL. The fingerprint includes endpoint hostname, database name and role, but excludes the password; it is safe for diagnostics and cannot be used to connect to the database. If `OWNER_ADMIN_DATABASE_URL` is configured, it is the canonical direct endpoint for migrations and deployment persistence. Sponsor runtime queries may use a pooled URL, but acceptance fingerprints the direct Owner Admin endpoint to avoid treating a Neon pooler hostname as a different logical database.

## Acceptance checks

The report evaluates:
1. Owner address configuration consistency.
2. Sponsor address format and separation from Owner.
3. Sponsor signer configuration and derived/declared address match.
4. Sponsor ledger database configuration.
5. Exact database target identity matches the operator-approved Neon endpoint, database name and role; only a one-way fingerprint is returned.
6. Existing ledger schema and control-row availability.
7. Operator-attested durable backup and restore-test flags.
8. Sponsor writes remain paused.
9. Independent Owner Admin password-session integration and Sponsor-session separation.
10. Sponsor session authentication configuration.
11. Mainnet deployment execution remains explicitly disabled during acceptance.
12. Artifact-pinned TRӾ deployment source, creation bytecode, runtime bytecode and manifest fingerprints match the pinned Solidity build.
13. The connected Owner TronLink wallet signs the exact prepared transaction; the Resource API recovers and verifies the configured Owner address and live TRON permission, then durably persists the signed transaction and broadcast intent before broadcasting. The backend does not sign Owner transactions or require an Owner private-key environment variable.
14. Pending-owner challenge/session is distinct from the configured Owner session and acceptance verifies the exact pending-owner signature, transaction and solidified owner state.
15. Owner and Sponsor password changes, role-scoped one-time recovery, single-session revocation and revoke-other-sessions routes are available; recovery tokens and session tokens are hash-stored.

A passing report is labelled `ready-for-independent-review`, not production-approved. Operator evidence, independent review, and explicit release approval remain mandatory. The API always reports `executionEnabled: false` in this acceptance report.

## Run the production smoke check

Run from `Frontend-Tron-Transfer/resource-api`:

```sh
TRON_TRANSFER_API_BASE_URL=https://<existing-resource-api-host> npm run smoke:production-acceptance
```

The command uses HTTPS only, refuses redirects, checks the health and acceptance endpoints, reports blocked check IDs, and exits non-zero if a required check is missing or Mainnet execution is not confirmed disabled. It does not require or accept any secret.

## Owner and Sponsor browser acceptance

Use the existing production frontend in a real desktop and mobile browser. Do not paste passwords, private keys, seed phrases, session cookies, or database credentials into browser developer tools.

- Confirm the Owner workspace loads and navigation works. Owner access requires both the independent managed Owner password session and a connected TronLink signer; the app session address, TronLink authorized account, TronWeb active address, configured Owner address and transaction owner must all match.
- Confirm the Sponsor workspace loads independently and displays the Sponsor identity separately.
- Confirm read-only Sponsor status is visible and blocked checks are clearly labelled.
- Confirm browser storage, page source, network responses, and console output contain no Sponsor or Owner private key, static Sponsor Admin token, session secret, or database URL. Confirm Sponsor transaction requests include the independent Owner session cookie and Sponsor CSRF proof, without any private-key or static admin-token header.
- Confirm navigation, reload, logout/session expiry, narrow mobile viewport, keyboard focus, and error/empty states.
- Confirm no Owner or Sponsor page silently submits, signs, or broadcasts a transaction during page load or status refresh.
- Confirm Owner deployment and contract-operation prompts appear only after explicit confirmation and fresh resource preflight. TronLink must sign the exact persisted unsigned transaction; the Resource API must reject missing, mismatched or invalid signatures and must persist the verified signature before broadcasting.
- Confirm Owner deployment and contract-operation prompts appear only after explicit confirmation and fresh resource preflight. TronLink must sign the exact persisted unsigned transaction; the Resource API must reject missing, mismatched or invalid signatures and must persist the verified signature before broadcasting.
- Keep all write controls disabled while acceptance is in progress.

Browser acceptance must be recorded with browser/version, viewport, build commit, route, observed result, and timestamp. A screenshot alone does not prove signing custody or transaction safety.

## Release gates not automated by this layer

- A real Neon database snapshot/backup and restoration drill must be evidenced independently; environment flags are operator attestations, not proof.
- Apply Owner Admin migrations only with the direct PostgreSQL endpoint after the backup/restore gate, then verify migration checksums and required tables.
- Owner TronLink signing must be tested with broadcast disabled and the recovered signature verified against the configured Owner address and live permission.
- Owner TronLink signing must be tested with broadcast disabled and the recovered signature verified against the configured Owner address and live permission.
- Sponsor signing must be tested with broadcast disabled and the signature recovered/verified against the configured Sponsor address.
- Owner and Sponsor recovery tokens must be generated for the intended role, consumed once, and verified not to cross-authenticate the other wallet role.
- Process-restart recovery must be exercised against a non-production or safely isolated test ledger.
- Mainnet deployment and pending-owner acceptance remain disabled until artifact pins, live resource coverage, database durability, backup/restore evidence, independent security review and explicit approval are complete.
- Mainnet stake/delegation and funding acceptance require separately approved operations and chain evidence.
- Do not enable Mainnet execution merely because this diagnostic returns HTTP 200.
