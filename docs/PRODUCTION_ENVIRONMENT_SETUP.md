# Backend production environment setup

Tron Token Studio's default payout architecture is Fincra + Tatum. Do not configure a Fireblocks organization, vault, API key, API-user key file, or Fireblocks signer mode.

## Backend provider settings

| Variable | Purpose |
|---|---|
| `TATUM_API_KEY` | Server-side Tatum access for TRON Mainnet and supported testnet RPC/history endpoints |
| `FINCRA_API_BASE` | Exact Fincra origin: sandbox by default; production only after business approval |
| `FINCRA_API_KEY` | Backend-only Fincra API credential |
| `FINCRA_BUSINESS_ID` | Fincra merchant/business identifier |
| `FINCRA_WEBHOOK_SECRET` | Backend-only secret used to verify provider webhook signatures |
| `FINCRA_SOURCE_CURRENCY` | `USDT` for the implemented USDT-funded payout route |
| `FINCRA_PAYOUTS_ENABLED` | Must remain `false` until the provider and security release gates pass |
| `FINCRA_MAX_PAYOUT_USDT` | Positive per-payout ceiling, up to six decimals |
| `FINCRA_DAILY_LIMIT_USDT` | Positive daily aggregate payout ceiling, up to six decimals |
| `DATABASE_URL` | Backend PostgreSQL database for idempotency and payout reconciliation |
| `FRONTEND_ORIGIN` | Exact frontend origin permitted by the backend CORS policy |
| `OWNER_WALLET_ADDRESS` | Owner's address for the single-owner console |
| `TREASURY_OWNER_ADDRESS` | Must exactly match the configured owner address |

Provider credentials must never be added to frontend variables, browser storage, committed files or chat. The frontend uses the backend Tatum RPC proxy; it must not contain the Tatum key.

## Before a controlled sandbox test

1. Obtain Fincra business onboarding and sandbox credentials directly from Fincra.
2. Configure the backend-only sandbox API key, business identifier and webhook secret.
3. Set valid positive limits and keep `FINCRA_PAYOUTS_ENABLED=false` until the sandbox contract is verified.
4. Verify Tatum connectivity, DB readiness, owner-signature flow, webhook signature handling and customer-reference reconciliation.
5. Verify every result against an actual Fincra sandbox response; a mocked test is not provider approval.

## Before any real Mainnet payout

Fincra must approve the merchant for live USDT TRC20 payouts and the business payout account must hold enough USDT, or have a written/approved credit facility. Confirm Fincra's source wallet funding, account limits, fees, beneficiary eligibility, geographic restrictions and IP allowlisting. Then pass independent security review and controlled transfer verification. Live-value execution is disabled in the current build; changing environment flags alone does not authorize a release.
