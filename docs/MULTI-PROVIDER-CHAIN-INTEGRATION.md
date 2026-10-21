# Multi-provider chain integration and receiver verification

**Status:** implementation plan and integration boundaries, reviewed 2026-10-21.

This project can send supported on-chain assets to a wallet address when the sender has the actual asset, the correct network, and sufficient fees. It cannot force every exchange or wallet to accept a token or credit a deposit. Receiver crediting is controlled by each destination platform's supported networks, asset contracts, memo/tag rules, minimum deposit, confirmations, and account status.

## Provider assessment

| Provider / docs | Suitable use | Not a substitute for |
|---|---|---|
| [Tatum TRON RPC](https://docs.tatum.io/reference/rpc-tron) | Network-specific TRON HTTP/Solidity/JSON-RPC access; balance reads and chain transaction workflows. The balance-read route now uses the Mainnet, Shasta, or Nile Tatum gateway and sends `TATUM_API_KEY` only from the backend as `x-api-key`. | Asset conversion, exchange deposit credit, or a cross-chain bridge. |
| [Chaingateway TRON API](https://chaingateway.io/tron-api/) | Potential second provider for TRX/TRC-20 sends, address operations, and deposit webhooks, subject to account, plan, terms, and security review. | An exchange-wide deposit guarantee or free sponsorship. Provider documentation advertises paid plans; verify signing model and key custody before any production integration. |
| [TRON official API workflow](https://developers.tron.network/docs/api-signature-and-broadcast-flow) | Build unsigned transactions, sign locally with the user's wallet, broadcast signed transactions, and verify solidified receipts. | A shortcut around user signatures or finality checks. |
| [TON API overview](https://docs.ton.org/api/overview) | Separate TON-native balances, Jettons, transactions, and TON Center / liteserver integrations. | TRON USDT transfers. TON is a different blockchain with different assets and addresses; cross-chain movement requires a legitimate bridge or exchange route and its own verification. |
| [Bank of AI x402 seller quickstart](https://docs.bankofai.io/x402/getting-started/quickstart-for-sellers/#running-on-mainnet) | Accept payments for this project's own API/service and verify/settle supported x402 payments on configured networks. Mainnet needs real funded wallets and explicit network/asset configuration. | Sending arbitrary wallet balances to exchanges, generic deposit monitoring, or converting testnet assets into mainnet value. |
| [Kiln DeFi integration](https://docs.api.kiln.fi/docs/kiln-defi-integrate) | Integrate explicitly supported DeFi vaults, display deployment metadata, and offer reviewed deposit/withdrawal flows for supported networks/assets. | A generic token-transfer router or universal exchange integration. Test-only vaults must not be treated as production. |
| [Bitaps forwarding API](https://developer.bitaps.com/forwarding) | Evaluate for Bitcoin address forwarding and related Bitcoin payment workflows, after confirming current API, custody, fees, and operational terms. | TRON/TRC-20, TON, or a universal multi-chain transfer API. |

## Receiver and exchange support model

1. **Resolve the exact chain first.** A TRON address string alone is not enough to prove the network. Keep network as a required, explicit value; never silently switch Mainnet, Shasta, and Nile.
2. **Resolve the exact asset.** Verify chain plus token contract (or native asset), decimals, and expected amount. A user-created TRC-20 token is not official Tether USDT merely because its display name or symbol says so.
3. **Preflight receiver rules.** Where an exchange has an official deposit API, use that platform's documented API and credentials to query deposit availability and any required memo/tag. Otherwise ask the user to confirm the destination's deposit page manually; do not claim the exchange supports a token based only on an address.
4. **Sign safely.** Prefer user-controlled local wallet signing and broadcasting of signed transactions. Never accept seed phrases/private keys in the frontend API, query strings, logs, support tickets, or Git.
5. **Verify finality.** A successful broadcast response is not proof of a completed transfer. Verify the transaction body and successful receipt against the selected network's solidified state. For TRC-20, check the contract, sender, recipient, event amount, and token decimals.
6. **Credit only from trusted evidence.** Internal bookkeeping may mark a transaction as on-chain verified, but it must not claim that an external exchange credited the account. Mark exchange credit only when confirmed by that exchange's authorized deposit API or its own account history.
7. **Handle webhooks defensively.** For any provider webhook, validate signatures/authentication, deduplicate by provider event ID and chain transaction/log identity, verify on-chain independently, handle retries idempotently, and keep secrets server-side.
8. **Sponsorship stays disabled until approved.** A provider's transfer API or paid energy-rental product is not proof that the provider will sponsor fees. Require an explicitly funded sponsor, documented authorization, user consent, limits, monitoring, and an emergency pause.

## Implemented in this change

- The read-only `GET /api/tron/token-balance` endpoint now routes each requested network to its corresponding Tatum TRON Solidity gateway:
  - Mainnet: `https://tron-mainnet.gateway.tatum.io/walletsolidity`
  - Shasta: `https://tron-shasta.gateway.tatum.io/walletsolidity`
  - Nile: `https://tron-nile.gateway.tatum.io/walletsolidity`
- It sends `TATUM_API_KEY` using the documented `x-api-key` header from the backend only, and returns a clear `503 missing-api-key` when the credential is not configured.
- The balance endpoint remains read-only: it does not sign, broadcast, sponsor, bridge, or credit a ledger. Its response explicitly says a token balance does not imply exchange deposit credit.
- Tests assert network-specific gateway routing, backend-only API key use, and no accidental TronGrid routing in this endpoint.

## Remaining production work

- Set a valid `TATUM_API_KEY` in the backend's Render environment; do not put it in Vite/frontend variables or commit it.
- Run CI and test each supported network against known test contracts and known Mainnet contracts, including invalid addresses, missing key, provider timeout, malformed responses, and decimals edge cases.
- If adding Chaingateway or an exchange-specific adapter, create a separate provider module with explicit opt-in configuration and contract tests. Do not make a fallback silently change chain/network or provider signing semantics.
- For each exchange, integrate only its official API where available. A general-purpose platform cannot promise “every exchange and wallet” will accept a token or credit a deposit.
- Keep any mainnet send feature behind explicit user confirmation, local signing, amount/fee preview, and finality verification. Do not run automated real-money transfers until independent review and a small user-authorized test have passed.

## References

- Tatum TRON gateway endpoints and interface discovery: https://docs.tatum.io/reference/rpc-tron
- TRON transaction signing/broadcast lifecycle: https://developers.tron.network/docs/api-signature-and-broadcast-flow
- Chaingateway TRON REST API: https://chaingateway.io/tron-api/
- TON API options and separate Mainnet/testnet endpoints: https://docs.ton.org/api/overview
- Bank of AI x402 seller flow and Mainnet switch: https://docs.bankofai.io/x402/getting-started/quickstart-for-sellers/#running-on-mainnet
- Kiln DeFi integration: https://docs.api.kiln.fi/docs/kiln-defi-integrate
- Bitaps forwarding docs: https://developer.bitaps.com/forwarding
