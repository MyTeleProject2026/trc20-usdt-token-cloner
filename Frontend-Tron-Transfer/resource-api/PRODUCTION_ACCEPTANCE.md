# Tron Transfer production acceptance layer

This release adds a read-only acceptance endpoint and a production smoke command. It does not activate Sponsor writes or authorize Mainnet broadcasts.

## Read-only endpoints

- `GET /health`: confirms that the Resource API process is serving requests and identifies the configured TRON network.
- `GET /api/acceptance/production`: returns the Sponsor/Owner acceptance checklist, database connectivity/schema state, and explicit execution-gate state.
- `GET /api/sponsor/status`: existing detailed Sponsor readiness response.

The acceptance endpoint is diagnostic only. It does not create schema, migrate data, sign transactions, or broadcast transactions. It returns check IDs and states, not private keys, API tokens, database URLs, or session secrets.

## Acceptance checks

The report evaluates:
1. Owner address configuration consistency.
2. Sponsor address format and separation from Owner.
3. Sponsor signer configuration and derived/declared address match.
4. Sponsor ledger database configuration.
5. Existing ledger schema and control-row availability.
6. Operator-attested durable backup and restore-test flags.
7. Sponsor writes remain paused.
8. Independent Owner Admin password-session integration and Sponsor-session separation.
9. Sponsor session authentication configuration.
10. Mainnet execution remains explicitly disabled during acceptance.

A passing report is labelled `ready-for-independent-review`, not production-approved. Operator evidence, independent review, and explicit release approval remain mandatory. The API always reports `executionEnabled: false` in this acceptance report.

## Run the production smoke check

Run from `Frontend-Tron-Transfer/resource-api`:

```sh
TRON_TRANSFER_API_BASE_URL=https://<existing-resource-api-host> npm run smoke:production-acceptance
```

The command uses HTTPS only, refuses redirects, checks the health and acceptance endpoints, reports blocked check IDs, and exits non-zero if a required check is missing or Mainnet execution is not confirmed disabled. It does not require or accept any secret.

## Owner and Sponsor browser acceptance

Use the existing production frontend in a real desktop and mobile browser. Do not paste passwords, private keys, seed phrases, session cookies, or database credentials into browser developer tools.

- Confirm the Owner workspace loads, navigation works, and the connected address is the configured Owner.
- Confirm the Sponsor workspace loads independently and displays the Sponsor identity separately.
- Confirm read-only Sponsor status is visible and blocked checks are clearly labelled.
- Confirm browser storage, page source, network responses, and console output contain no Sponsor or Owner private key, static Sponsor Admin token, session secret, or database URL. Confirm Sponsor transaction requests include the independent Owner session cookie and Sponsor CSRF proof, without any private-key or static admin-token header.
- Confirm navigation, reload, logout/session expiry, narrow mobile viewport, keyboard focus, and error/empty states.
- Confirm no Owner or Sponsor page silently submits, signs, or broadcasts a transaction during page load or status refresh.
- Keep all write controls disabled while acceptance is in progress.

Browser acceptance must be recorded with browser/version, viewport, build commit, route, observed result, and timestamp. A screenshot alone does not prove signing custody or transaction safety.

## Release gates not automated by this layer

- A real database backup and restoration drill must be evidenced independently; environment flags are operator attestations, not proof.
- Sponsor signing must be tested with broadcast disabled and the signature recovered/verified against the configured Sponsor address.
- Process-restart recovery must be exercised against a non-production or safely isolated test ledger.
- Mainnet stake/delegation and funding acceptance require separately approved operations and chain evidence.
- Do not enable Mainnet execution merely because this diagnostic returns HTTP 200.
