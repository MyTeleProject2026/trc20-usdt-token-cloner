# Owner-only treasury-funded USDT withdrawals

This feature lets the single configured owner request a payout from a separately funded TRON Mainnet treasury. It does not mint USDT, fabricate balances, or force an exchange to credit a deposit.

## Current implementation

- `GET /api/treasury/withdrawals/readiness`: owner-authenticated configuration and official-USDT funding check.
- `POST /api/treasury/withdrawals`: transaction-specific owner-signed payout request.
- `GET /api/treasury/withdrawals/:idempotencyKey`: status lookup for the stored request.
- `POST /api/treasury/withdrawals/:idempotencyKey/verify`: reads the confirmed transaction and receipt, then checks the exact treasury sender, recipient, amount, official USDT contract and matching Transfer event.
- `npm run treasury:reconcile`: one bounded reconciliation pass over stored broadcasts that have transaction hashes. It can finalize a request only when the existing on-chain verifier proves a successful official-USDT Transfer event or a confirmed failed receipt.
- The API requires the existing Mainnet wallet-auth session to match `TREASURY_OWNER_ADDRESS` and the request Origin; each payout also requires a short-lived owner signature bound to the exact request.
- The private console setting `OWNER_WALLET_ADDRESS` must exactly match `TREASURY_OWNER_ADDRESS`. A missing or mismatched value fails closed and disables treasury withdrawals.
- The server-side signer must derive exactly `TREASURY_ADDRESS`. Only the official Mainnet Tether TRC-20 address is used.
- PostgreSQL idempotency reservations, payout limits, and conservative accounting for unresolved broadcasts prevent retries from casually duplicating payments.
- Pending, ambiguous, or unverifiable transactions remain unresolved; a broadcast response or transaction hash alone is not success evidence.

## Backend environment variables

Keep these in the backend service's secret/environment settings only. Never put private keys, admin tokens, or provider credentials into `VITE_*` values, frontend files, APK resources or Git.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Persistent PostgreSQL database for payout idempotency and audit records |
| `OWNER_WALLET_ADDRESS` | The single address allowed through private owner-console login; must exactly match `TREASURY_OWNER_ADDRESS` |
| `TREASURY_WITHDRAWALS_ENABLED=true` | Explicitly enables the withdrawal route after review |
| `TREASURY_SIGNER_MODE=env-hot-wallet` | Enables the current server-side environment key signer |
| `TREASURY_OWNER_ADDRESS` | The one owner address allowed to request payouts |
| `TREASURY_ADDRESS` | Public address of the separately funded treasury |
| `TREASURY_PRIVATE_KEY` | Secret server-side treasury signer; must derive `TREASURY_ADDRESS` |
| `TREASURY_MAX_PAYOUT_USDT` | Maximum amount per payout, decimal USDT with up to six places |
| `TREASURY_DAILY_LIMIT_USDT` | Maximum reserved payout principal per database day |
| `TREASURY_FEE_LIMIT_SUN` | TRON smart-contract fee cap in SUN; not a source of fees |
| `DATABASE_SSL=true` | Optional strict TLS for external PostgreSQL when appropriate |

All required payout settings must be valid before the route is enabled. The treasury must hold actual official USDT and enough TRX or available network resources for execution. Paying network fees on behalf of a sender does not provide the USDT principal.

## Receipt reconciliation

The reconciliation command is read-only with respect to TRON. It never signs, broadcasts, retries, or creates a transaction. It needs `DATABASE_URL` (and `DATABASE_SSL=true` only if required for the database connection) and reads the public Mainnet RPC. It does **not** require `TREASURY_PRIVATE_KEY`.

Run one pass with `npm run treasury:reconcile`. The optional `TREASURY_RECONCILE_BATCH_SIZE` is an integer from 1 to 200 and defaults to 50. To automate it, configure a Render Cron Job using this repository's `main` branch, build command `npm ci`, start command `npm run treasury:reconcile`, and a modest schedule such as every 10 minutes. Add the backend's database connection setting through Render's secure environment UI; never paste it into source control or this conversation. The withdrawal table must already have been initialized by the API.

A row is finalized only after the verifier validates the confirmed transaction and exact official-USDT event. Missing receipt data and provider errors leave the row unresolved so the principal remains conservatively reserved. A request that never received a transaction ID cannot be conclusively reconciled by this worker and requires operator investigation; do not submit a replacement payout while the outcome is unknown.

The owner app now stores only the latest payout's non-secret idempotency reference (owner address plus request key) in device storage so it can be looked up after a reload. The owner must unlock the same wallet and authenticate again before status lookup. This reference is not a bearer credential or proof of success; verification still comes from the backend record and confirmed on-chain receipt. If device storage is unavailable, copy the displayed request key before closing the screen.

## Production cautions and verification

1. Start with test coverage and a small, controlled Mainnet payout only after independent security review.
2. The current `env-hot-wallet` signer is a custody risk and has not been independently audited. Prefer a dedicated signer/custody component with enforced transaction policy before storing material assets.
3. Keep conservative per-transfer and daily limits, database backups, monitoring, alerting, and a documented recovery procedure.
4. Validate the actual transaction on TRON with its sender, recipient, amount, contract and successful solidified receipt. Do not infer success from a node's broadcast acknowledgement.
5. External wallet display and exchange deposit credit are controlled by the receiving platform. On-chain confirmation does not guarantee exchange credit.
6. No transaction can send USDT if the treasury lacks sufficient genuine USDT. The smart-contract compiler cannot create supply in Tether's official token contract.

The automated code checks and APK artifact prove that the current source compiled and tests ran; they do not constitute a live funded Mainnet transfer, a third-party exchange credit, or an independent security audit.
