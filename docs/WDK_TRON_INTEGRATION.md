# WDK TRON integration (safe, read-only phase)

## What is integrated

The backend uses the two focused WDK TRON wallet modules:

- `@tetherto/wdk-wallet-tron` — standard TRON read-only account for native TRX and TRC20 balance reads, plus an optional standard network-fee quote.
- `@tetherto/wdk-wallet-tron-gasfree` — GasFree read-only account for TRX/TRC20 balance reads and an optional provider fee quote.

Only the read-only account classes are instantiated. The backend does not accept, generate, derive, store, log, or return a mnemonic, seed phrase, private key, or signer object. The GasFree API key/secret pair, if configured, remains server-side.

## Endpoint

`GET /api/wdk/tron/readiness?network=mainnet&address=<TRON_ADDRESS>`

Optional fee quote fields must be supplied together:

- `recipientAddress`
- `amountBaseUnits` (positive decimal integer string)

For Mainnet, the token is pinned to official Tether TRC20 USDT:
`TR7NHqj...SzgjLj6t` (full contract: `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`).

For Nile, provide a testnet token contract explicitly. Nile token balances are test assets and are never represented as genuine Mainnet USDT.

For the GasFree path, first read the existing authenticated discovery endpoint:
`GET /api/gasfree/capabilities?network=mainnet`
Then pass a `serviceProvider` address exactly matching one of the returned providers. The adapter refuses an arbitrary provider address.

## Important operational boundary

This is an integration of WDK read-only account and fee-quote APIs, not a payout signer or broadcaster. The route returns explicit false values for transfer signing, submission, and broadcast. It does not use the WDK `transfer()` methods.

The existing owner-approved sponsor-direct payout flow remains the only active payout architecture: live genuine Mainnet USDT and TRON resource checks, explicit sponsor approval, sponsor TronLink signature for the exact transaction, backend signature/fee revalidation, Tatum broadcast, and solidified official-USDT Transfer-event verification.

GasFree's provider-backed flow is separate. It may pay TRX network costs for eligible TRC20 transfers, but it can charge activation/transfer fees in the transferred token. It does not supply the USDT principal. The current GasFree `/submit` route remains disabled until a separately reviewed wallet-authorization adapter, funded sponsor agreement, fee policy, replay/nonce protection, and independent solidified-chain reconciliation are implemented and tested.

## Deployment and test gates

1. Install via the updated root lockfile; do not add any wallet secret to Render environment variables.
2. Keep GasFree API credentials optional and server-only. Configure both key and secret together only if the selected provider requires authenticated requests.
3. Keep the PR draft. Run CI and review the dependency/security audit.
4. Validate the read-only endpoint against a known address on Mainnet and Nile.
5. Do not enable transfer signing, GasFree submission, Tatum broadcast, merge, or production deployment based on a successful read-only check.
6. A real Mainnet test still requires a willing, funded sponsor and explicit approval of the exact destination, amount, and fees. Verify the solidified transaction and exchange-side deposit separately.

WDK modules are beta releases. Their official docs advise thorough testing before production use.
