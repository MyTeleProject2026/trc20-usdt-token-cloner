# Production Environment Setup and Release Checklist

This runbook applies to the backend service for **TRON Token Studio**. It separates verified public constants from account-specific settings and secrets. It is not a credentials generator and does not authorize spending real assets.

## 1. Confirmed public values

| Setting | Value | Notes |
|---|---|---|
| Frontend origin | `https://trc20-usdt-token-cloner.onrender.com` | Exact origin only; no path. |
| Backend API origin | `https://trc20-usdt-token-cloner-api.onrender.com` | Current production API base used by frontend code. `VITE_API_BASE_URL` is optional and public. |
| Tatum API base | `https://api.tatum.io` | A separate `TATUM_API_KEY` must be issued by Tatum. |
| Fireblocks API base | `https://api.fireblocks.io` | Default production origin; use a region-specific host only when correct for your Fireblocks workspace and supported by code. |
| Official TRON USDT contract | `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` | Confirmed by Tether’s supported-protocols reference. Six decimals. Mainnet only. |
| TRON Mainnet RPC | `https://api.trongrid.io` | Officially documented TRON endpoint. |
| TRON Shasta RPC | `https://api.shasta.trongrid.io` | Testnet only. |
| TRON Nile RPC | `https://nile.trongrid.io` | Testnet only. |
| GasFree Mainnet origin | `https://open.gasfree.io` | Provider key/secret required for authenticated access. |
| GasFree Nile origin | `https://open-test.gasfree.io` | Separate testnet credentials required. |
| Fireblocks API key secret file | `/etc/secrets/fireblocks_api_private_key.pem` | Render Secret File containing the Fireblocks API-user RSA auth key, not a TRON signing key. |

## 2. Wallet addresses are account-specific

There is **no universal or “usual” sponsor/treasury wallet address** that can safely be copied from public research. Each address must come from the relevant authorized account and be checked on the matching network.

- `OWNER_WALLET_ADDRESS`: the single owner-controlled TRON Mainnet address.
- `TREASURY_OWNER_ADDRESS`: must exactly match `OWNER_WALLET_ADDRESS`.
- `TREASURY_ADDRESS`: must match the sole TRON address returned by the configured Fireblocks USDT asset **and** native TRX asset. The current payout code checks both.
- `TREASURY_MAINNET_ADDRESS`: verified Mainnet address to monitor read-only; this setting does not grant spending authority.
- `SPONSOR_MAINNET_ADDRESS`, `SPONSOR_SHASTA_ADDRESS`, `SPONSOR_NILE_ADDRESS`: set only to the correct sponsor address on that network and only with permission to monitor it.
- `SPONSOR_FEE_<NETWORK>_ADDRESS`: fee/resource monitor address.
- `SPONSOR_ASSET_<NETWORK>_ADDRESS`: source of the actual transfer principal. Do not confuse fee coverage with USDT/TRX principal funding.
- Testnet USDT/VTRC contract allowlists must contain the correct contract for that exact network. Mainnet USDT is fixed in the backend; VTRC is not official USDT.

Earlier environment notes contained conflicting owner/treasury address candidates. Do not designate any previously typed address as correct without reconciling it against the actual wallet and provider vault.

## 3. Backend baseline

Configure these in the **backend Render Web Service**, not in the Static Site.

| Variable | Configuration |
|---|---|
| `DATABASE_URL` | Copy the PostgreSQL **Internal Database URL** from Render’s Connect page when API and DB are in the same workspace and region. Treat it as a secret. |
| `DATABASE_SSL` | Typically `false` for the current same-region internal Render URL; confirm the code/database TLS mode before changing it. External database connections require TLS. |
| `FRONTEND_ORIGIN` | `https://trc20-usdt-token-cloner.onrender.com` |
| `TATUM_API_KEY` | Enter a valid key issued by Tatum. |
| `TATUM_API_BASE` | `https://api.tatum.io` |
| `TRONGRID_API_KEY` | Recommended production backend key from TronGrid; it is not a wallet signer. |
| `TRONSCAN_PRO_API_KEY` | Optional key for Mainnet source/risk metadata. |
| `TRON_VERIFIED_TOKEN_CONTRACTS` | Leave blank unless adding independently reviewed additional contracts. |
| `PACKAGED_APP_ORIGINS` | Only if the reviewed packaged app is used: `https://localhost,tronstudio://app`. |
| `OKX_UI_ORIGIN` | `https://trc20-usdt-token-cloner.onrender.com` if enabling the OKX status page. |

Generate `OWNER_PASSWORD_HASH` locally with `node scripts/generate-owner-password-hash.mjs`. Use a unique, strong password; copy only the generated hash into Render. The owner address is public, but no private key or recovery phrase belongs in Render, this document, GitHub, an APK, or chat.

Read-only/admin access tokens, if the associated feature is used:
- `TREASURY_ADMIN_API_TOKEN`: random secret at least 32 characters; protects `GET /api/treasury/payout-readiness`, which is read-only.
- `SPONSOR_ADMIN_API_TOKEN`: separate random secret at least 32 characters for privileged sponsor admin endpoints.
- `RECEIVER_WATCHLIST_ADMIN_TOKEN`: optional, only for the protected receiver-watchlist feature.

## 4. Fireblocks payout environment

Set the following only after a legitimate, authorized Fireblocks account/vault exists and has been verified:

| Variable | How to obtain/configure |
|---|---|
| `TREASURY_SIGNER_MODE` | `fireblocks` |
| `FIREBLOCKS_API_BASE` | `https://api.fireblocks.io` unless a supported workspace-specific region applies. |
| `FIREBLOCKS_API_KEY` | Copy provider-issued API key ID from the authorized Fireblocks workspace. |
| `FIREBLOCKS_SECRET_KEY_PATH` | `/etc/secrets/fireblocks_api_private_key.pem`; upload the API-user RSA key PEM via Render Secret Files. |
| `FIREBLOCKS_VAULT_ACCOUNT_ID` | Copy the correct numeric vault account ID from Fireblocks. |
| `FIREBLOCKS_USDT_ASSET_ID` | Copy the exact provider asset ID only after its metadata proves it is the official TRON USDT contract. |
| `FIREBLOCKS_TRX_ASSET_ID` | Copy the exact provider asset ID only after metadata proves it is native TRX (TRX symbol, six decimals, no token contract). Required for both payout routes’ fee-reserve checks. |
| `TREASURY_ADDRESS` | Exact single TRON address returned by both configured Fireblocks assets. |
| `TREASURY_MAX_PAYOUT_USDT`, `TREASURY_DAILY_LIMIT_USDT` | Set only to written, provider-approved limits. |
| `TREASURY_MAX_PAYOUT_TRX`, `TREASURY_DAILY_LIMIT_TRX` | Set only to written, provider-approved limits. |
| `TREASURY_FEE_LIMIT_SUN` | Positive integer fee-estimate threshold and per-request TRX reserve in SUN. Fireblocks estimates are checked before submission, but this is not a provider-enforced hard fee cap; reconcile actual on-chain cost. One TRX equals 1,000,000 SUN. |
| `TREASURY_WITHDRAWALS_ENABLED` | Keep `false` until release gates pass. |
| `TREASURY_TRX_WITHDRAWALS_ENABLED` | Keep `false` until the native-TRX path is separately qualified. |

Do not set `TREASURY_PRIVATE_KEY` and do not create a private-key fallback. The Fireblocks API-user RSA key authenticates API calls; Fireblocks’ custody infrastructure signs blockchain transactions. These are different key types.

## 5. Sponsor and GasFree environment

- Keep `SPONSOR_MAINNET_BUDGET_ACTIVATION_ENABLED=false`.
- Keep `SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED=false` until explicit testnet authorization, supported signing, funding/resource checks, idempotency and end-to-end reconciliation pass.
- `SPONSOR_TESTNET_MAX_FEE_LIMIT_SUN=50000000` is only a testnet transaction fee-cap setting, not proof that sufficient TRX is funded.
- Leave `SPONSOR_APPROVED_AGREEMENT_REFERENCES` blank until a real sponsor agreement/mandate has been signed and its exact scopes reviewed.
- `GASFREE_MAINNET_API_KEY` and `GASFREE_MAINNET_API_SECRET` must come from approved GasFree Mainnet access.
- `GASFREE_NILE_API_KEY` and `GASFREE_NILE_API_SECRET` are separate testnet credentials. Do not interchange them.
- Current GasFree integration is read-only. `POST /api/gasfree/submit` intentionally returns HTTP 503 and does not sign or broadcast. Credentials cannot override this. The published specification describes fees charged in the transferred token, so do not represent it as a zero-cost USDT/TRX principal sponsor.

## 6. Optional OKX deposit history

Configure these only for the actual OKX account owner’s read-only deposit history:
- `OKX_API_KEY`
- `OKX_API_SECRET`
- `OKX_API_PASSPHRASE`
- `OKX_STATUS_ACCESS_TOKEN` (separate random secret, at least 32 characters)
- `OKX_UI_ORIGIN=https://trc20-usdt-token-cloner.onrender.com`

Create the exchange API key with **Read permission only**. Do not grant Trade or Withdraw. This integration reads one configured OKX account; it does not create deposits, change balances, or access unrelated users’ accounts.

## 7. Frontend variables

The only likely frontend setting is the optional public override:
`VITE_API_BASE_URL=https://trc20-usdt-token-cloner-api.onrender.com`

Do not add any API keys, database URL/password, provider secrets, admin tokens, wallet private keys or recovery phrases to `VITE_*`. Frontend build variables are visible to browser users.

## 8. Setup sequence

1. In Render, choose the backend Web Service and update settings without deleting other environment values.
2. Open the PostgreSQL database’s Connect page and copy the Internal Database URL if services share region/workspace. Update only `DATABASE_URL`.
3. A database connection string/password was previously pasted into chat. Rotate those database credentials in Render before production use, then update `DATABASE_URL` with the new value; do not reuse or repeat the old string.
4. Add Tatum/TronGrid keys and owner login settings, keeping secrets server-side.
5. Add the Fireblocks Secret File and provider-issued IDs only after reviewing the actual vault, asset metadata, exact addresses and approval policy.
6. Add sponsor addresses only when the correct sponsor has authorized monitoring and any needed spending mandate is documented.
7. Save/deploy, then inspect `GET /health` and `GET /api/readiness`. Check the owner configuration endpoints for missing variable names without exposing any secret values.
8. Confirm test suite/CI and deploy success, perform provider-readiness checks, complete an authorized controlled end-to-end transfer test, and independently verify its solidified chain receipt and token event before requesting any release approval.

## 9. Keep release gates closed

Do **not** switch payout flags to `true` merely because variables have been populated. The current code has not been verified against live provider credentials or a successful real settlement in this run. Production release requires all of:
- verified authority over the wallet/vault and sponsor agreements;
- correct USDT and TRX Fireblocks metadata/addresses;
- provider-available and on-chain asset/fee balances;
- agreed recipient policy, transaction/daily limits and approval workflow;
- PostgreSQL persistence, idempotency and pending-request reconciliation;
- passing tests/CI and independent review;
- controlled authorized test and exact independent confirmation of sender, recipient, amount, contract, successful receipt and USDT `Transfer` event.

A confirmed chain transaction does not guarantee a receiving exchange credits a deposit. Exchange credit must be confirmed from the receiving exchange’s authorized record. Do not misrepresent simulated, unverified or unspendable balances as actual assets.

## Official references

- Tether supported protocols (official TRON USDT contract): https://tether.to/en/supported-protocols/
- TRON network endpoints: https://developers.tron.network/docs/connect-to-the-tron-network
- TronGrid API key guidance: https://developers.tron.network/reference/select-network
- GasFree specification: https://gasfree.io/specification?lang=en-US
- Fireblocks API authentication: https://developers.fireblocks.com/docs/api-authentication
- Fireblocks create transaction API: https://developers.fireblocks.com/api-reference/transactions/create-a-new-transaction
- Fireblocks vault asset API: https://developers.fireblocks.com/api-reference/vault/get-vault-account-asset
- Render environment variables and secret files: https://render.com/docs/configure-environment-variables
- Render PostgreSQL connection URLs: https://render.com/docs/postgresql-creating-connecting
- OKX API v5 permissions and API guidance: https://app.okx.com/docs-v5/en/
- Repository environment template: https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/blob/main/.env.example
- Repository payout guide: https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/blob/main/docs/TREASURY_WITHDRAWALS.md

*Reviewed 30 October 2026. This guide reflects source/configuration review and official documentation; it does not verify current secrets, account ownership, live balances, sponsor consent, or completed Mainnet transactions.*
