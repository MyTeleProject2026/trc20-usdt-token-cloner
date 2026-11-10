# Stage 8J — FYStack snapshot freshness and identity hardening

Parent HEAD at start: `e969dbc63f3e500d8a4057089529013dceb7a3a6`.

The read-only snapshot normalizer now requires authenticated=true (caller assertion, not cryptographic proof), TRON_MAINNET, official TRC20 USDT contract, six decimals, integer base-unit balance, valid TRON address, non-empty workspace/wallet IDs, and a timestamp no more than 120 seconds old and not in the future. Optional expected identities are compared exactly.

Only getUsdtSnapshot() is exposed. Normalized data remains explicitly unverified and cannot affect spendable balance or payout authorization. No live FYStack API call is made; getWalletUsdtSnapshot remains an injected placeholder contract.

Tests cover freshness, future timestamps, missing IDs, wrong network/contract, malformed balance, identity mismatch, absent client and provider errors.

No credentials, SDK dependency, route, UI, ledger, migration, historical record, minimum policy, signer, broadcaster or transfer path changed. The 1,000 USDT minimum remains unchanged. No merge or deployment.
