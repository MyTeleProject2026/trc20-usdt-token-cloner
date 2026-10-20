# Multi-provider chain integration assessment

Status: planning and review only. Provider links are not proof that a production account, network, asset, or feature is enabled.

## Integration boundaries

| Provider | Candidate scope | Not a substitute for |
| --- | --- | --- |
| Tatum | TRON HTTP/Solidity/JSON-RPC gateway and blockchain data; current receiver balance adapter uses network-specific Solidity HTTP endpoints. | Asset funding, exchange deposit acceptance, or cross-chain conversion. |
| ChainGateway | Candidate TRON API adapter for supported queries/transfers after current API schema, custody/signing model, pricing, and production account access are reviewed. | Universal exchange compatibility. |
| TON API | Separate TON chain adapter for TON-native assets and Jettons. | TRON/TRC-20 transfer execution. |
| Bank of AI x402 | Candidate payment acceptance for services that implement the x402 protocol, subject to exact supported chain/token and seller configuration. | A general-purpose wallet balance bridge. |
| Kiln DeFi | Supported staking/DeFi contract integration where product and network are explicitly supported. | Generic transfers to any exchange address. |
| Bitaps forwarding | Candidate Bitcoin payment-forwarding workflow. | TRON USDT or TON transfer routing. |

## Required provider adapter contract

Every provider adapter should declare:
- Supported chain/network identifiers and whether they are production or testnet.
- Read, estimate, broadcast, receipt, and webhook capabilities separately.
- Custody/signing model and whether users retain control of keys.
- Authentication, rate limits, timeouts, retry rules, and provider status mapping.
- Asset identity by chain + contract/mint, not ticker alone.
- Transaction finality and receipt-verification method.
- Fees, limits, terms, and operational escalation path.

Never silently fail over between networks. Failover between providers is acceptable only when the chain/network and requested operation are unchanged and the second provider's response is independently validated.

## Transfer and receiver status model

Use distinct statuses:
- `draft`: not submitted.
- `awaiting-wallet-signature`: awaiting user approval.
- `submitted`: transaction hash received, not yet confirmed.
- `awaiting-finality`: chain receipt/finality not yet established.
- `verified-on-chain`: exact chain, contract, sender, receiver, amount, successful execution and finality verified.
- `receiver-balance-observed`: balance read from the receiver address on the same chain/contract.
- `exchange-credit-confirmed`: only after an authorized exchange API or authenticated deposit history confirms credit.
- `failed` / `inconclusive`: failed or insufficient evidence; never report success.

A wallet address and successful chain transaction do not establish that an exchange account credited a deposit. Exchanges may require a supported network/token, memo/tag, minimum amount, confirmations, and compliance checks.

## Security and rollout gates

1. Keep API keys in backend environment/secret storage; never expose them to frontend bundles, logs, responses, or source control.
2. Never request or store seed phrases or private keys on the server.
3. Validate all address, contract, amount, chain and network inputs; use integer base units.
4. Verify receipts and expected transfer events against the exact requested network and allowlisted token contract.
5. Add mocked adapter tests, negative tests, and provider outage tests.
6. Test a low-value transaction with dedicated wallets on the intended Mainnet before enabling production.
7. Keep sponsorship disabled until provider support, funding, limits, and full end-to-end tests are verified.

## Official documentation supplied for review

- TON API overview: https://docs.ton.org/api/overview
- ChainGateway TRON API: https://chaingateway.io/tron-api/
- Bank of AI x402 seller quickstart: https://docs.bankofai.io/x402/getting-started/quickstart-for-sellers/#running-on-mainnet
- Kiln DeFi integration: https://docs.api.kiln.fi/docs/kiln-defi-integrate
- Bitaps forwarding: https://developer.bitaps.com/forwarding
- Tatum TRON RPC gateway: https://docs.tatum.io/reference/rpc-tron
- Tatum authentication: https://docs.tatum.io/oa/docs/authentication

Before enabling any provider, re-check its current official documentation and the actual account's supported networks, methods, pricing, permissions and terms. No integration can turn testnet assets into Mainnet assets or force an exchange to credit unsupported deposits.
