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
3. Copy the pooled connection string for the production branch. Keep the TLS parameter
   supplied by Neon (normally `sslmode=require`).
4. Store it securely. Never paste the URL into chat, GitHub, frontend variables, or logs.

### 2. Protect the existing ledger

1. In Render Dashboard, open the existing database:
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
- `TARGET_DATABASE_URL`: Neon destination connection URL.

Run from `Frontend-Tron-Transfer/resource-api`:

```sh
npm ci
SOURCE_DATABASE_URL='(existing Render internal URL)' \
TARGET_DATABASE_URL='(Neon pooled URL with TLS)' \
npm run migrate:sponsor-ledger
```

Run this from an environment that can reach both database endpoints. The existing
Render database currently has an empty external IP allowlist, so a local computer
cannot connect until an authorized temporary IP allowlist entry is configured in
Render. Prefer a controlled migration runner in the same Render region; do not open
the database to `0.0.0.0/0`.

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

It does not copy other application tables because this Sponsor ledger currently uses
only `public.tron_transfer_sponsor_operations`. Recheck that assumption before running
against a newer schema.

### 4. Point the existing Resource API at the destination

In Render Dashboard, open the existing service:
`https://dashboard.render.com/web/srv-dbrjpq56e07s73bueevg`

Update only the server-side `DATABASE_URL` secret to the Neon pooled URL. Do not add
it as a `VITE_*` variable. Keep Sponsor transaction execution flags disabled.

After the service redeploys, check:
- `GET /health` returns healthy Mainnet service status;
- `GET /api/sponsor/status` reports `databaseConfigured=true` and
  `databaseReady=true`;
- the existing Sponsor operation count matches the migration output;
- a read-only Sponsor operation-history request succeeds.

If any check fails, restore the previous `DATABASE_URL` value and redeploy. Keep the
source Render database untouched until rollback is no longer needed.

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
