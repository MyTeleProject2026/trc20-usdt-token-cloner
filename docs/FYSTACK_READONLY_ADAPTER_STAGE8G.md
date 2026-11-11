# Stage 8G — FYStack read-only adapter boundary

Parent HEAD: 75825097162ad8816f2648aa09ee830de0c1f1b7.

This stage adds a server-side adapter interface, not a live FYStack integration. Repository inspection found no confirmed FYStack API contract/client. Therefore no endpoint, authentication scheme, credential name, or response shape is invented.

The adapter accepts an injected client exposing only getWalletUsdtSnapshot(). Its output is normalized against TRON_MAINNET, the official TRC20 USDT contract, six decimals, valid TRON wallet address, integer base-unit balance, snapshot time, and optional expected workspace/wallet identity.

Missing client, thrown errors, sandbox network, wrong token, malformed values, or identity mismatches fail closed. No raw provider data is treated as cryptographic proof.

No database, route, UI, migration, history, minimum policy, signer, broadcaster, or transfer path is changed. The adapter exposes only a read method and always reports verified=false, no spendable-balance impact, no credit approval, no payout authorization, and execution disabled.

Next prerequisite: obtain FYStack's official API contract and supported read-only wallet/asset balance endpoint, then implement an authenticated client separately and test against documented response fixtures.