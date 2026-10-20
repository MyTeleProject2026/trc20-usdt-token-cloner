# TRC20 Token Clone PostgreSQL storage

This project uses a dedicated PostgreSQL schema, `trc20_token_clone`, inside the explicitly assigned Render PostgreSQL instance. It does not create or modify tables in the default `public` schema and does not use the sponsor-ledger project's tables.

## Render configuration

Set the backend web service environment variable `DATABASE_URL` to the database's **internal** connection URL (same Oregon region). Never put a database URL or password in source control, frontend build variables, browser code, or logs. Keep the URL only in Render's secret environment-variable settings.

The backend creates the schema and project tables idempotently on startup. Check `GET /api/storage/status` for storage readiness. `GET /health` is a process liveness check, not a database readiness check.

## Project-owned schema and tables

Every table has a database comment identifying it as belonging only to the TRC20 Token Clone project.

| Table | Purpose |
| --- | --- |
| `trc20_token_clone.token_deployments` | Independent token deployment metadata: network, name, symbol, 18 decimals, base-unit supply, contract address, transaction hash, and status. A submitted record is not proof of deployment. |
| `trc20_token_clone.transfer_verifications` | Results of checks against TRON solidified transaction body and receipt, keyed by network, transaction hash, and token contract. Only `verified-on-chain` represents a successful verification. This is not a token-balance ledger. |
| `trc20_token_clone.tracked_wallets` | Optional public TRON wallet addresses and display labels. |
| `trc20_token_clone.audit_events` | Non-secret application audit metadata. |

The tables intentionally do not store wallet private keys, seed phrases, API credentials, or user passwords. This is an independent TRC20 token project, not official Tether USDT.

## Important operational notes

- Use the Render internal URL for the backend; do not expose the external URL to the browser.
- The PostgreSQL connection string supplied during setup was exposed in chat. Rotate the database credential in Render and update the backend's `DATABASE_URL` immediately after this connection is established.
- The assigned database is on Render's free plan and currently has an expiry date. Confirm Render's current database lifecycle and arrange a backup/migration before expiry; do not assume it is durable indefinitely.
- Database initialization requires PostgreSQL DDL privileges for this schema. If startup logs say initialization failed, inspect `/api/storage/status` and Render logs; do not treat chain verification as database-persisted until storage is ready.
- No table or endpoint should be interpreted as authorizing transfers or storing/signing wallet secrets. Transfers remain locally wallet-signed, and sponsorship remains disabled until separately integrated and verified.
