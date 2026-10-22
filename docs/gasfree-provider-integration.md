# GasFree provider integration status

Last reviewed: 2026-10-22

## Verified provider model

GasFree documents a TRON-only gas-relay flow for authorized TRC-20 transfers. A user signs a TIP-712 authorization; a service provider validates and submits it on-chain and pays the TRON network resources. GasFree may charge an activation fee on first use and a transfer fee afterward, both denominated in the transferred token. This is gas abstraction, not a grant of the transfer principal and not evidence of a zero-fee public sponsor.

Official sources:
- https://docs.gasfree.io/
- https://developer.gasfree.io/
- https://wdk.tether.io/blog/gasless-transactions-in-wdk
- https://tronprotocol.github.io/documentation-en/clients/wallet-cli/typescript/commands/gasfree/

The published API environments are:
- Mainnet: https://open.gasfree.io/tron/
- Nile testnet: https://open-test.gasfree.io/nile/

The published documentation does not list Shasta as a supported GasFree environment. This adapter intentionally rejects Shasta instead of silently sending a Mainnet/Nile request to a different chain.

## Network-isolated server credentials

Use separate API key/secret pairs as documented for Mainnet and Nile:

| Render backend environment variable | Use |
|---|---|
| `GASFREE_MAINNET_API_KEY` | Mainnet discovery credential |
| `GASFREE_MAINNET_API_SECRET` | Mainnet HMAC secret |
| `GASFREE_NILE_API_KEY` | Nile testnet discovery credential |
| `GASFREE_NILE_API_SECRET` | Nile HMAC secret |

Never use `VITE_*` variables for these credentials. Do not put credentials in GitHub, frontend source, response bodies, query strings, or logs. The adapter intentionally does not fall back from one network's credentials to the other.

## Implemented in this pull request

- Fixed-host, HMAC-SHA256-authenticated read-only provider and supported-token discovery.
- Separate credentials per network; Mainnet keys cannot accidentally be used for Nile, or vice versa.
- Normalization and validation of provider/token records and token-denominated activation/transfer fees.
- Explicit disabled status for transfer submission and unverified sponsor funding.
- UI for current provider inventory and fees, with warnings that provider discovery is not proof of funding or free service.

## Not yet implemented or verified

- No signed authorization submission or trace-status route is enabled by this change.
- No live GasFree credentials have been provided/configured for this project, and no live provider response has been verified by this application.
- No end-to-end Nile transfer has been performed.
- No separate sponsor has been verified as agreeing to fund the transferred USDT/TRX principal.
- No exchange can be forced by this app to credit a deposit or list an unsupported asset. Exchange credit requires that exchange's own deposit rules and confirmation.
- Receiver notification means this app's own notification only; it is not a notification from the recipient wallet/exchange.

## Required before enabling transfers

1. Configure the separate Nile credentials in the backend secret store and verify read-only discovery.
2. Implement a wallet-side typed-data signing flow that shows network, token contract, receiver, amount, maximum token fee, nonce, and expiry before the user signs.
3. Query the GasFree account, verify token support, available/frozen balance, nonce and `allowSubmit`; reject stale or mismatched values.
4. Submit only the exact user-signed authorization to the fixed provider host. Never collect a seed phrase/private key or sign for the user.
5. Persist an idempotent local request/trace record, poll the provider trace endpoint, and separately verify the final solidified on-chain transaction, exact token contract, Transfer event, amount, receiver and fee.
6. Test duplicate requests, timeout/retry behavior, stale nonce, expired signatures, unsupported tokens, insufficient balance, provider outage, rate limits and secret redaction.
7. Keep Mainnet submission disabled until the Nile test, security review, operator approval and emergency pause are complete.

A transaction-fee relay is not a source of free token principal. The app must never display pending sponsor budgets or UI-only credits as spendable wallet balances, and must never charge the user as an automatic fallback when an external sponsor is unavailable.
