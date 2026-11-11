# Stage 8J — FYStack balance snapshot validation hardening

Parent HEAD: `e969dbc63f3e500d8a4057089529013dceb7a3a6`.

This stage hardens only the existing injected read-only adapter contract. It does not claim to connect to FYStack: the official SDK audit found no documented balance getter or balance field in the wallet-asset type.

The canonical internal snapshot now fails closed unless it includes non-empty workspace and wallet IDs, an expected wallet identity when configured, TRON_MAINNET, the official TRC20 USDT contract, six decimals, an explicitly `available` balance semantic, a non-negative integer base-unit amount, and a timestamp no more than 120 seconds old and not in the future.

The 120-second freshness window is a conservative local validation rule, not an FYStack API guarantee. The `authenticated` flag is metadata from the injected trusted client boundary, not independent proof produced by this normalizer. The snapshot remains `verified: false` and has no spendable-balance or ledger impact.

Tests cover stale/future timestamps, missing identities, ambiguous total/held balances, wrong network/contract, malformed amounts, provider absence, and provider exceptions.

No provider request, dependency install, credential, route, database change, migration, historical-record mutation, or withdrawal request was made. The 1,000 USDT minimum and all signing/broadcast/transfer safeguards remain unchanged.
