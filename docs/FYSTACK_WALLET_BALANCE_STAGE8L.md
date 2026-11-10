# Stage 8L — FYStack wallet inventory and balance-contract audit

## Verified official API

FYStack documents `GET /workspaces/:workspace_id/wallets` with optional `wallet_type`, `limit`, and `offset`. Its example response includes `id`, `name`, `role`, `wallet_type`, `value_usd`, `top_assets`, and `wallet_purpose`.

Source: https://docs.fystack.io/wallets (List all wallets, API response).

FYStack's changelog for v0.1.16 says wallet balance and overview endpoints were added, but the public wallet API page currently linked in the docs does not specify the exact endpoint path or response fields for wallet-level available/held token balances.

Source: https://docs.fystack.io/changelog

## Implemented

`server/fystack-wallet-list-reader.mjs` adds a read-only, signed GET client for the documented wallet inventory endpoint. It can match the configured wallet UUID and return its type, role, displayed USD value and top-assets metadata.

It explicitly does not treat `value_usd` as USDT, available balance, or spendable funds.

## Remaining verification gate

No wallet-specific USDT available/held balance reader is implemented because the exact endpoint path and response contract are not exposed in the current public API reference. The existing `fystack-readonly-adapter.mjs` accepts a strictly validated snapshot from a future verified provider client, but there is not yet a documented API client that can populate it.

Before implementing that connector, obtain the precise endpoint and response schema from FYStack's official API docs or a redacted API response captured by the workspace owner. Do not send API keys, API secrets, session cookies, recovery codes, or private keys in chat.

## Safety and invariants

- Read-only GET only; no wallet mutation or withdrawal request.
- No balance or credit is added to Tron Transfer.
- No workspace display valuation is treated as spendable.
- No signing, broadcasting, transfers, or payout authorization.
- Existing withdrawal records and the 1,000 USDT minimum are untouched.
