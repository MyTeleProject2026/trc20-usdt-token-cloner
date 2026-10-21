# Receiver history monitor — implementation status

## Included in this change

- Adds `GET /api/tron/receiver-history?network=mainnet|shasta|nile&address=T...&limit=20`.
- Supports an optional exact TRC-20 `contract` filter and bounds `limit` to 1–50.
- Supports TRONGrid cursor pagination with a validated, bounded fingerprint token; the UI can load older pages and deduplicates repeated rows during refresh.
- Queries only the known TRONGrid host for the selected network; callers cannot provide an arbitrary upstream URL.
- Uses the optional server-side `TRONGRID_API_KEY` without returning it to clients.
- Adds an incoming history panel to the Interact tab. While that tab is open, it refreshes every 30 seconds and also has a manual refresh button.
- Labels every result as an indexed candidate awaiting solidified verification. It does not treat an indexer row as a completed transfer or create/credit a balance.

## What is not claimed

This is an automatically refreshing, foreground receiver-history feed—not a persistent background worker. It refreshes while the app panel is open; it does not guarantee detection while every browser is closed. A durable monitor still needs an always-on worker/cron process, persistent tracked-address subscriptions, pagination checkpoints, retries, idempotent event storage, and per-record solidified receipt verification.

The existing solidified verification route remains the source of final on-chain verification. A future worker must reuse that verification logic (or a shared service) and persist each verified Transfer event under the unique key `network + transaction hash + token contract + log index`.

## Sponsor-funded assets and fees

Sponsor-funded TRX, sponsor-funded USDT grants, and sponsored transaction fees are three separate capabilities. This change does not enable any of them. They must remain disabled until a real, funded sponsor account/provider is integrated with explicit sponsor rules, an atomic reserve/spend ledger, recipient/network/contract/amount limits, expiry and eligibility checks, idempotency, reconciliation, a kill switch, and a passing Shasta end-to-end test. Mainnet activation requires separate operator approval and a reviewed small-value test.

A sponsor budget is not a receiver wallet balance. A receiver's spendable balance must be read from the selected chain. A platform cannot impose post-transfer spending restrictions on a normal external wallet; enforceable restrictions require an audited escrow/vesting contract or the receiving platform's own controls.

## External wallets and exchanges

The app can monitor chain events and display chain-reported balances. It cannot force every wallet to index a token, force an exchange to accept a deposit, or report an exchange deposit as credited without confirmation from that exchange. The receiver must use the exact supported network and token contract, and the receiving platform's minimum deposit, memo/tag, and confirmation rules still apply.
