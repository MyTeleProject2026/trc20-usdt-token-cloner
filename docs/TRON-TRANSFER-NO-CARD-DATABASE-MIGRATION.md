# Sponsor ledger migration when Render billing card is unavailable

This runbook is for the existing TRON Transfer Resource API and its single table,
`public.tron_transfer_sponsor_operations`. It does not change Owner Wallet keys,
Sponsor Wallet keys, the TRӾ contract, or Mainnet transaction policy.

## Important billing distinction

Render's current public pricing information lists major credit and debit cards as its
payment methods for paid services. Render's terms require a valid payment method for
paid features. Do not expect a PayPal, crypto, or bank-transfer option to appear in the
self-service billing page. Ask Render Support or Sales whether an invoice/bank-transfer
arrangement is available for this workspace; it is not a guaranteed self-service option.

Official references:
- https://render.com/pricing
- https://render.com/terms
- https://render.com/docs/render-dashboard

The current Sponsor ledger is a Render Free Postgres database. Render documents that
Free Postgres expires 30 days after creation, has no managed backups, and is intended
for testing rather than production. The instance currently recorded for this project
expires on 2026-12-20. Do not treat it as permanent storage.

## No-card interim option: external Neon Free Postgres

Neon advertises a Free Postgres plan that does not require a credit card. It is a
zero-cost interim destination, not a substitute for a paid production SLA or managed
production backup/recovery commitment.

Current published Neon Free limits are usage-based and include limited compute and
storage; compute may scale to zero while idle. Check the live plan before creating
the database:
- https://neon.com/pricing
- https://neon.com/docs/introduction/plans

A Neon Free database may keep the Sponsor ledger available without paying Render,
but it can pause or become unavailable when free quotas or service limits are reached.
It has no production availability guarantee. Sponsor execution must remain disabled
if database readiness is false. Do not enable Mainnet signing/broadcast solely because
a Neon database has been created.

## Migration sequence

### 1. Create the destination

1. Create a Neon account using its free signup flow (no card).
2. Create a PostgreSQL project. Prefer a region near Singapore if available, to reduce
   cross-region latency from the existing Render Resource API.
3. Copy both the direct and pooled connection strings. Use the direct endpoint for one-off migration and schema administration; use the pooled endpoint for normal Resource API runtime queries. Keep Neon's TLS parameters (normally `sslmode=require`).
4. Store it securely. Never paste the URL into chat, GitHub, frontend variables, or logs.

### 2. Protect the existing ledger

1. Deploy the Resource API version that enforces the durable `tron_transfer_sponsor_control` write gate before running the migration. Its Sponsor status endpoint must report `sponsorWritesPaused` and make `transactionExecutionAvailable=false` when the gate is active.
2. In Render Dashboard, open the existing database:
   `https://dashboard.render.com/d/dpg-dbvu3c142hec73856ogg-a`
2. Do not delete, suspend, or replace it.
3. Disable Sponsor transaction writes by keeping both
   `SPONSOR_TRANSACTION_ENGINE_ENABLED=false` and
   `SPONSOR_MAINNET_BROADCAST_ENABLED=false`.
4. Wait until any in-flight Sponsor operation has been reconciled. Do not migrate while
   a transaction is in `reserved`, `signed-not-broadcast`, or `broadcast-unknown`.

### 3. Run the ledger copy utility

The Resource API repository includes:

`Frontend-Tron-Transfer/resource-api/scripts/migrate-sponsor-ledger.mjs`

It requires the existing Node dependencies and two environment variables:
- `SOURCE_DATABASE_URL`: existing Render Postgres connection URL.
- `TARGET_DATABASE_URL`: Neon **direct** connection URL (the non-pooled hostname), for the migration process.
- `DATABASE_URL`: Neon direct connection URL, retained for schema administration and fallback.
- `DATABASE_URL_POOLED`: Neon pooled connection URL, preferred by the always-on Resource API for normal application queries.

Run from `Frontend-Tron-Transfer/resource-api`:

```sh
npm ci
SPONSOR_WRITES_PAUSED=true \
SOURCE_DATABASE_URL='(existing Render internal URL)' \
TARGET_DATABASE_URL='(Neon direct URL with TLS)' \
npm run migrate:sponsor-ledger
```

The utility first creates/sets `public.tron_transfer_sponsor_control.writes_paused=true` on the source database and commits that pause before opening its read-only snapshot. The Resource API takes a shared row lock while reserving each operation, so the pause waits for active reservations and prevents new ones. The source remains paused after the copy. The target is created paused too. If the migration fails, keep the source paused until you have explicitly reviewed and safely restored service. Run this from an environment that can reach both database endpoints. Prefer the
existing Resource API's Render SSH session in Singapore; do not open the database to
`0.0.0.0/0` or add a broad external IP allowlist.

The guarded runner is available in the existing Resource API codebase. From the
service's SSH session, change to `Frontend-Tron-Transfer/resource-api` and run:

```sh
npm run sponsor-ledger:pause
npm run sponsor-ledger:preflight
npm run sponsor-ledger:migrate
```

The runner selects the source using the same database-variable precedence as the
running API. It reads only the staged direct Neon endpoint from
`SPONSOR_MIGRATION_TARGET_DATABASE_URL`; it does not accept a caller-supplied source
URL and refuses pooled Neon targets, identical database identities, or execution
unless `SPONSOR_WRITES_PAUSED=true`,
`SPONSOR_TRANSACTION_ENGINE_ENABLED=false`, and
`SPONSOR_MAINNET_BROADCAST_ENABLED=false` are explicitly set in the service
environment. The pause command verifies that the source ledger exists, then creates
or updates the durable Sponsor control row to `writes_paused=true`. The preflight is
read-only and must return `readyToMigrate=true` before running the migration command.
The migration command still independently checks for in-flight/ambiguous operations,
an empty target, matching row counts, and a matching SHA-256 digest. Both databases
remain paused after a successful copy.

Set `SPONSOR_WRITES_PAUSED=true` only after both Sponsor transaction writes and Mainnet broadcasts are disabled. The utility refuses to run without this explicit gate and rejects any source ledger containing `reserved`, `signed-not-broadcast`, or `broadcast-unknown` operations. It verifies both row counts and a SHA-256 digest over every migrated ledger field before committing.

The utility:
- refuses to run when source and target identities match;
- requires the source Sponsor ledger table to exist;
- creates the compatible destination table and index;
- refuses to merge into a non-empty destination;
- copies the complete Sponsor operation rows, preserving IDs and idempotency hashes;
- resets the destination identity sequence;
- compares source and destination row counts;
- prints counts only, never credentials or row contents;
- rolls back on failure.

It also creates the target maintenance-control row in the paused state. It does not copy other application tables because this Sponsor ledger currently uses only `public.tron_transfer_sponsor_operations` plus the one-row `public.tron_transfer_sponsor_control` gate. Recheck that assumption before running against a newer schema.

### 4. Point the existing Resource API at the destination

In Render Dashboard, open the existing service:
`https://dashboard.render.com/web/srv-dbrjpq56e07s73bueevg`

For the current Resource API configuration, set the server-side variables:
- `SPONSOR_DATABASE_URL` = Neon direct URL.
- `SPONSOR_DATABASE_URL_POOLED` = Neon pooled URL.

These Sponsor-specific variables take precedence over the legacy shared variables. The API selects `SPONSOR_DATABASE_URL_POOLED` first, then `SPONSOR_DATABASE_URL`, then `DATABASE_URL_POOLED`, then `DATABASE_URL`. The previously documented setup using `DATABASE_URL` (Neon direct) and `DATABASE_URL_POOLED` (Neon pooled) remains supported when neither Sponsor-specific variable is set. Remove or correct any stale Sponsor-specific URL, because it overrides the shared Neon configuration. Do not add either value as a `VITE_*` variable. Keep Sponsor transaction execution flags disabled.

After the service redeploys, check:
- `GET /health` returns healthy Mainnet service status;
- `GET /api/sponsor/status` reports `databaseConfigured=true`,
  `databaseReady=true`, and `sponsorWritesPaused=true` until cutover is approved;
- the existing Sponsor operation count matches the migration output;
- a read-only Sponsor operation-history request succeeds.

 If any check fails, restore the previous `DATABASE_URL` and `DATABASE_URL_POOLED` values and redeploy. Keep the source Render database paused and untouched until rollback is no longer needed. After the target is verified, explicitly unpause only the target using an authorized database session:

```sql
UPDATE public.tron_transfer_sponsor_control
SET writes_paused = FALSE, pause_reason = NULL, updated_at = now()
WHERE id = 1;
```

Do this only after the Resource API points at the target, counts/checksum match, the backup is verified, and the Sponsor transaction execution/broadcast environment flags remain off until separately approved.

### 5. Production security gate

A free external database is an interim continuity measure only. Before enabling
Sponsor signing/broadcast, require:
- verified backup/export and a tested restore procedure;
- confirmed database region, TLS, connection limits, and availability expectations;
- Sponsor signer address/private-key match;
- Sponsor/Owner address separation;
- reserve, stake cap, top-up cap and transaction fee cap review;
- explicit operator authorization for the exact Mainnet operations.

Do not enable background automatic spending. The planner is read-only and every Sponsor
write must remain separately authenticated, signed for its exact intent, confirmed,
ledger-reserved, and solidified on Mainnet.

## If you cannot use any payment method

You can keep using the existing Render Free service and a no-card Neon Free database
as an interim setup, subject to their free-tier limitations. You cannot turn a Render
Free Postgres instance into a non-expiring paid database without satisfying Render's
billing requirements. Contact Render Support about invoice arrangements if you need
Render-managed paid Postgres but cannot use a supported card.

Never use a wallet private key, crypto transfer, or third-party payment link as a
substitute for a legitimate Render billing method.
