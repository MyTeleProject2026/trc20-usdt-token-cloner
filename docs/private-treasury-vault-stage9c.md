# Private Treasury Vault financial trust registry and read-only PostgreSQL adapter

This Stage 9C integration is deliberately not wired into application startup or any payout route.

## Dedicated financial trust configuration

The financial observation verifier must use a trust registry separate from the organizational sponsor registry. The following environment values are read only; this code does not provision or modify them:

- `PRIVATE_TREASURY_VAULT_TRUST_VERSION`: pinned registry version.
- `PRIVATE_TREASURY_VAULT_TRUSTED_KEYS_JSON`: JSON object keyed by key ID. Each entry has exactly `status`, `issuer`, `audiences`, `publicKeyPem`, `notBeforeMs`, and `notAfterMs`.
- `PRIVATE_TREASURY_VAULT_TRUST_SHA256`: SHA-256 of compact JSON for normalized entries sorted by key ID; each audience array is sorted.
- `PRIVATE_TREASURY_VAULT_REVOKED_KEY_IDS_JSON`: JSON array of revoked key IDs (use `[]` when none).
- `PRIVATE_TREASURY_VAULT_REVOCATIONS_SHA256`: SHA-256 of compact JSON for the sorted revoked-key array.

Only Ed25519 public keys are accepted. Pins are mandatory. Missing, malformed, expired-window, or digest-mismatched trust state fails closed. The registry does not inherit sponsor identities or sponsor keys.

## PostgreSQL reader

`createPrivateTreasuryVaultReadOnlyRepository(pool)` issues only SELECT statements inside `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`. It does not initialize the application database, run migrations, or create tables. The caller must supply an already initialized pool and a valid dedicated trust snapshot. Replay IDs are read across the complete immutable claim history (no LIMIT); recent reservation detail is bounded to 1,000 rows.

The adapter is not connected to startup, routes, reservation writers, signers, or broadcast services. It is an observation/read interface only. It does not prove legal ownership, spend authority, or availability of funds outside the supplied signed observation.

All monetary values remain integer base units. The existing 1,000 USDT minimum remains 1,000,000,000 base units.
