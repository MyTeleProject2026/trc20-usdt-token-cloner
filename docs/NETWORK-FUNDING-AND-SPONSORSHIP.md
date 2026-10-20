# Mainnet funding, testnet balances, and sponsored fees

## Important network boundary

Shasta and Nile are TRON test networks. Their TRX and TRC-20 test tokens have no automatic redemption value and cannot be bridged into Mainnet by changing an RPC URL, contract address, or API provider. A transaction on a test network is never evidence that Mainnet funds were received.

The application must keep each operation bound to one explicit network:
- `shasta`: test-only assets and transactions.
- `nile`: test-only assets and transactions.
- `mainnet`: real TRON assets and fees.

Do not add a conversion endpoint that reports testnet balances as Mainnet funds. Do not create internal balances or exchange-deposit confirmations from a transaction hash alone.

## Legitimate paths to Mainnet assets

1. **Acquire Mainnet assets.** Use a regulated/legitimate exchange or fiat on-ramp that explicitly supports the user's region, payment method, asset, and TRON network. The provider may require identity verification and payment. Verify the live asset/network availability and provider terms before enabling it.
2. **Receive a real Mainnet transfer.** The sender must already control the actual Mainnet asset and must authorize the transfer with their wallet.
3. **Sponsor transaction fees (separate from token funding).** A sponsorship service may provide Energy/Bandwidth or pay eligible network costs. It does not supply the TRC-20 tokens being transferred and does not convert testnet assets into Mainnet assets.

## Sponsorship integration gate

The current `GET /api/tron/sponsorship/status` response intentionally remains fail-closed:
- `enabled: false`
- `mainnetEnabled: false`
- `canSubmitSponsoredTransfer: false`
- `provider: null`
- `status: not-integrated`

Do not change these values merely because an API key or environment variable exists. Before implementing a provider adapter, confirm all of the following from the provider's current official documentation and account:
- Supported network is TRON Mainnet, not only Shasta/Nile.
- Exact supported transaction type and TRC-20 contract requirements.
- Complete fee schedule, including any fee-payment transaction, minimums, limits, and refund behavior.
- Authentication/signature scheme, request/response schemas, rate limits, and error handling.
- Whether the user must still pay a service fee or provide Energy/Bandwidth.
- Provider terms, operational support, and production credentials.
- Successful end-to-end tests using dedicated wallets and a low-value Mainnet transaction before enabling production.

Never collect a wallet seed phrase or private key on the server. The user's wallet should review and sign its own transfer. Keep provider credentials only in backend environment variables or a managed secret store.

## Required transfer lifecycle

1. Connect the user's wallet and verify its selected network.
2. Read the sender's actual balance for the exact token contract on that network.
3. Verify the receiver address and that the receiver supports that asset/network.
4. Show the network, contract, token symbol, exact amount, receiver, and any provider/service fee before asking for wallet approval.
5. Have the wallet sign the transaction; broadcast only to the explicitly selected network.
6. Verify the transaction body, successful execution result, expected Transfer event, and solidified receipt on the same network.
7. Read the receiver's balance from that same network and contract.
8. Keep exchange deposit status separate. Mark an exchange deposit as credited only from the exchange's authorized API or confirmed deposit history, not from a chain transaction or wallet balance.

Persist exact integer base units and the network/contract/address/transaction identifiers. Never use floating-point arithmetic for token amounts. Treat provider outages, missing receipts, mismatched event fields, and database failures as inconclusive; do not claim success.

## Provider notes

- TRONGrid's Mainnet, Shasta, and Nile endpoints are separate networks. A provider request must never silently fall back between them.
- A fee-sponsorship API is not a testnet-to-Mainnet bridge.
- A fiat on-ramp is a purchase/funding path, not redemption of testnet tokens.
- Before listing a provider in the product UI, verify current support and pricing directly against its official documentation and account; do not infer support from a token ticker alone.

## Deployment and secret hygiene

- Keep API keys and provider credentials server-side only.
- The database connection credential previously exposed during project work should be rotated in Render, and the backend's `DATABASE_URL` updated to the new internal connection URL.
- The configured database is scheduled to expire on 2026-11-17; back up and migrate its project schema before that date.
- Run the repository test suite and build, then verify backend health and the actual deployed frontend/backend before claiming a feature is live.
