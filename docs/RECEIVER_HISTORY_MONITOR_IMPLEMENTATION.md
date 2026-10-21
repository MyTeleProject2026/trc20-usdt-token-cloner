# Receiver history monitor — implementation status

## Included in this change

- Adds a protected `POST /api/tron/tracked-wallets` administrative endpoint. It refuses anonymous registration, requires a server-only `RECEIVER_WATCHLIST_ADMIN_TOKEN` of at least 32 characters, compares bearer tokens in constant time, validates network/address/label, and performs an idempotent database upsert.
- Registration is not the same as active monitoring: the response explicitly says `pending-worker-schedule`. The worker remains disabled unless separately configured and scheduled.

- Adds a bounded `GET /api/tron/receiver-history/persisted` endpoint backed by PostgreSQL. The normal API database initializer creates the same event-table schema as the opt-in worker, so the UI does not depend on the worker having run first.
- The receiver-history UI merges persisted worker rows with the live indexer feed and prefers stored solidified-verification results. Database monitoring remains optional; a database failure does not hide the live indexer feed.

- Adds `GET /api/tron/receiver-history?network=mainnet|shasta|nile&address=T...&limit=20`.
- Supports an optional exact TRC-20 `contract` filter and bounds `limit` to 1–50.
- Supports TRONGrid cursor pagination with a validated, bounded fingerprint token; the UI can load older pages and deduplicates repeated rows during refresh.
- Queries only the known TRONGrid host for the selected network; callers cannot provide an arbitrary upstream URL.
- Uses the optional server-side `TRONGRID_API_KEY` without returning it to clients.
- Adds an incoming history panel to the Interact tab. While that tab is open, it refreshes every 30 seconds and also has a manual refresh button.
- Labels every result as an indexed candidate awaiting solidified verification. It does not treat an indexer row as a completed transfer or create/credit a balance.

## What is not claimed

The UI's live indexer feed refreshes while the panel is open. Persistent results become available only after a separately scheduled worker is configured and the receiver is already present in the tracked-wallet table. The worker is opt-in and disabled by default; this change does not register arbitrary addresses, configure a Render cron, or guarantee monitoring while the browser is closed.

The existing solidified verification route remains the source of final on-chain verification. A future worker must reuse that verification logic (or a shared service) and persist each verified Transfer event under the unique key `network + transaction hash + token contract + log index`.

## Sponsor-funded assets and fees

Sponsor-funded TRX, sponsor-funded USDT grants, and sponsored transaction fees are three separate capabilities. This change does not enable any of them. They must remain disabled until a real, funded sponsor account/provider is integrated with explicit sponsor rules, an atomic reserve/spend ledger, recipient/network/contract/amount limits, expiry and eligibility checks, idempotency, reconciliation, a kill switch, and a passing Shasta end-to-end test. Mainnet activation requires separate operator approval and a reviewed small-value test.

A sponsor budget is not a receiver wallet balance. A receiver's spendable balance must be read from the selected chain. A platform cannot impose post-transfer spending restrictions on a normal external wallet; enforceable restrictions require an audited escrow/vesting contract or the receiving platform's own controls.

## External wallets and exchanges

The app can monitor chain events and display chain-reported balances. It cannot force every wallet to index a token, force an exchange to accept a deposit, or report an exchange deposit as credited without confirmation from that exchange. The receiver must use the exact supported network and token contract, and the receiving platform's minimum deposit, memo/tag, and confirmation rules still apply.


## Persistent worker implementation (feature branch; opt-in)

- Adds `npm run worker:receiver-history`, a one-shot sweep intended for a separately scheduled Render Cron Job or another trusted scheduler.
- The worker is disabled unless `RECEIVER_HISTORY_WORKER_ENABLED=true`; disabled mode performs no database connection and no network requests.
- When enabled, it reads only pre-existing `tracked_wallets` rows and uses fixed network hosts. It never accepts a watch address or upstream URL from a public request.
- Per sweep it scans at most 100 addresses and at most 5 pages of 50 incoming indexed rows per address. This bounds provider usage; unusually high activity may require more frequent sweeps or a reviewed limit adjustment.
- Writes are idempotent to `receiver_history_events`, records per-wallet success/error checkpoints, and labels every newly indexed event as a candidate awaiting solidified verification. It does not update a wallet balance or trigger a payout.
- When `TRON_VERIFIED_TOKEN_CONTRACTS` is configured with reviewed hex contract addresses, the worker checks up to 25 pending candidates per sweep against the selected network's solidified transaction body and receipt using the existing `verifySolidifiedTrc20Transfer` verifier. Successful matches are persisted with the exact Transfer log index via `recordTransferVerification`; missing receipts remain pending and mismatches are marked not verified.
- If the reviewed token allowlist is absent, candidates are stored but no event is promoted to verified. No generic token is treated as official USDT; Mainnet USDT must be separately reviewed and allowlisted with its exact contract address.
- The worker is code-only in this PR: no Render Cron Job, environment variables, production database migration, or deployment has been changed. A trusted scheduler and authorized watchlist onboarding must be configured deliberately after checks and review.

## Render Cron Job rollout checklist (manual, not applied)

The worker is a one-shot process intended for a scheduled Render Cron Job. This repository change does not create a Render service or alter existing service settings.

1. Confirm the API's existing PostgreSQL database is reachable from the Cron Job and that its plan/cost is acceptable.
2. In Render, create a separate Cron Job from this repository and the reviewed `main` branch only after the code review is complete.
3. Use build command `npm ci` and start command `npm run worker:receiver-history`.
4. Set `RECEIVER_HISTORY_WORKER_ENABLED=true` only on the Cron Job, never on the public web service unless a separately reviewed deployment design requires it.
5. Link the existing database using Render's private connection string as `DATABASE_URL`. Never paste database URLs or provider keys into Git, client code, issues, or logs.
6. Configure `TRONGRID_API_KEY` as a server-only secret if available. Do not set `TRON_VERIFIED_TOKEN_CONTRACTS` until exact token contracts have been independently reviewed and converted to the expected hexadecimal form; the worker normalizes optional `41` prefixes.
7. Start conservatively with a low-frequency schedule such as `*/15 * * * *` (UTC), then inspect run duration, provider rate limits, database load, and error checkpoints before considering a faster cadence. Cron runs can incur separate charges; check current Render pricing before creating the service.
8. Register only authorized addresses with the protected administrative endpoint after a server-only `RECEIVER_WATCHLIST_ADMIN_TOKEN` (minimum 32 characters) has been securely provisioned. Never expose this token in browser code.
9. Verify the first run reports bounded scan counts, then query the persisted endpoint and compare any `verified-on-chain` record against the solidified transaction receipt. An indexed candidate is not proof of a successful transfer; neither state proves an exchange credited a deposit.
10. Keep sponsorship disabled. The worker never signs/broadcasts transfers and does not credit user balances.

### Stop conditions

Keep the worker disabled if database initialization fails, the allowlist is unreviewed, provider errors repeat, address registration is unauthorized, or the schedule would exceed the budget. Disable the Cron Job first if it causes excessive provider/database load; preserve checkpoints and investigate before re-enabling.