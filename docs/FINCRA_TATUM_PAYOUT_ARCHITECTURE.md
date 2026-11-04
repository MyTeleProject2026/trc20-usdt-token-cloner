# Fincra + Tatum payout architecture

## Default provider policy

- Fincra is the only payout provider for genuine TRON Mainnet USDT withdrawals.
- The payout destination is fixed to crypto_wallet and the payment scheme is fixed to usdt_trc20.
- Tatum is the platform TRON chain data and RPC provider for balances, transaction lookup, receipt/event inspection and finality verification.
- Fireblocks custody, vaults, payout APIs, inventory endpoints, secrets and workflows are excluded from the supported architecture.
- Testnet actions and Mainnet payouts remain explicitly separated. Testnet tokens have no Mainnet USDT value.

## Fincra payout API contract

The server adapter supports Fincra sandbox and production base URLs only. It authenticates with the backend-only api-key header and supplies paymentDestination=crypto_wallet, paymentScheme=usdt_trc20, destinationCurrency=USDT, a unique customerReference, and the beneficiary's TRON address and account-holder name.

When source currency is not USDT, the payout must include a Fincra quote reference. The customer must review and authorize the quote's actual USDT receive amount and fees before the payout is initiated. The adapter exposes quote and lookup operations; the application route must persist the quote and payout reference before considering a retry.

A Fincra API response with success=true or status=processing means the request was accepted/processing. It is not proof that an on-chain transfer settled. Webhook signatures must be verified with the merchant webhook secret, and the provider payout must be re-queried by its stable reference when the callback or request outcome is ambiguous. Never create a new customer reference to work around a timeout.

## Tatum chain verification

Tatum's TRON Mainnet gateway is the canonical chain-data route. A payout can only be shown as chain-confirmed after independent Mainnet verification of:

1. The official Tether TRC20 contract TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t.
2. The exact transaction hash returned or referenced by Fincra.
3. A successful, solidified transaction/receipt.
4. The expected recipient and exact USDT transfer amount (six decimals).

A Fincra payout status alone must not be promoted to confirmed. An exchange's internal deposit credit is outside the scope of a chain receipt and must be checked separately with the receiving exchange.

## Credentials and go-live gates

Backend-only configuration names:

- FINCRA_API_BASE (https://sandboxapi.fincra.com by default; https://api.fincra.com for production)
- FINCRA_API_KEY
- FINCRA_BUSINESS_ID
- FINCRA_WEBHOOK_SECRET
- FINCRA_SOURCE_CURRENCY
- FINCRA_PAYOUTS_ENABLED (must remain false until provider activation, funding, routing, webhook, reconciliation and security reviews are complete)
- TATUM_API_KEY for backend-only Tatum API access.

Do not place secrets in frontend variables, source files, GitHub, browser storage or chat. Fincra must enable live stablecoin payouts for the merchant business and fund the source-currency payout wallet or approve a formal credit facility. Source-code integration cannot supply USDT principal.

## Test coverage

tests/fincra-client.test.mjs covers URL allowlisting, fixed TRC20 scheme, amount validation, cross-currency quote requirements, ambiguous request errors, status lookups and webhook HMAC verification. These adapter tests do not establish live Fincra approval, funding, settlement or successful exchange credit.
