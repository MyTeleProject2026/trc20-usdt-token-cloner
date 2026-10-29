# Owner-only managed-provider USDT withdrawals

## Scope and non-negotiable requirements

This is a single-owner, treasury-funded TRON Mainnet payout workflow. It does not mint USDT, generate a local balance that can be spent on-chain, forge transaction hashes, or guarantee a receiving exchange's deposit credit.

A successful payout must move genuine USDT from the configured Fireblocks vault to the exact recipient by calling Fireblocks' managed signing API, then independently verify the confirmed TRON transaction, successful receipt, official Tether TRC-20 contract and matching `Transfer` event. A provider request ID or broadcast hash alone is not confirmation.

The owner’s local Wallet Vault identity wallet does not need to hold the USDT principal. The authorized Fireblocks vault must hold the real USDT, the matching on-chain address must hold that USDT, and actual TRX must cover `TREASURY_FEE_LIMIT_SUN` unless a separately verified fee sponsor is integrated. This repository currently does **not** assume a sponsored-fee path.

## Provider integration

The feature branch uses Fireblocks' production REST API. The API-user RSA key is used only to authenticate requests to Fireblocks and is read from a mounted secret file on the backend. The blockchain signing key is not loaded into Tron Token Studio: the provider's custody system signs according to its configured transaction policy.

Official references:
- [Fireblocks request authentication](https://developers.fireblocks.com/docs/api-authentication)
- [Fireblocks create transaction API](https://developers.fireblocks.com/api-reference/transactions/create-a-new-transaction)
- [Fireblocks vault account asset API](https://developers.fireblocks.com/api-reference/vault/get-vault-account-asset)

Before using real funds, the operator must have an eligible Fireblocks workspace and vault account, an API user/key with only the required permissions, the API authentication key installed as a Render secret file, and a Fireblocks asset ID whose provider metadata maps to the official TRON USDT contract `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`. A generic USDT symbol is not sufficient to prove asset identity.

Configure Fireblocks' **own transaction policy** independently. Restrict the source vault, TRON USDT asset, allowed recipients, transaction and daily limits, and required approvals. Do not configure a policy that silently bypasses required approvals. If the provider holds a transfer for approval, the app displays it as pending and retains the reservation; it does not claim it has been paid.

The code deliberately requires exactly one provider-returned address for the configured asset and requires it to match `TREASURY_ADDRESS`. If a workspace contains multiple addresses for that asset, the address/sender mapping must be reconciled before enabling the route; the integration fails closed instead of assuming which address the provider will spend from.

## Backend environment variables

Set these in the **backend Render service only**. Do not send credentials in chat, commit them to GitHub, put them in `VITE_*` variables, or place them in the APK.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Persistent PostgreSQL database for the idempotency ledger and payout reservations |
| `OWNER_WALLET_ADDRESS` | Single owner identity for the private console |
| `TREASURY_OWNER_ADDRESS` | Must exactly match `OWNER_WALLET_ADDRESS` |
| `TREASURY_WITHDRAWALS_ENABLED` | Keep `false` until the provider policy, config, tests, and recovery procedures are reviewed |
| `TREASURY_SIGNER_MODE` | Must be `fireblocks` for this managed USDT signer |
| `TREASURY_ADDRESS` | The single configured TRON address returned for the Fireblocks vault USDT asset |
| `TREASURY_MAX_PAYOUT_USDT` | Positive decimal maximum for one payout (up to six decimal places) |
| `TREASURY_DAILY_LIMIT_USDT` | Positive decimal cap for payouts per database day |
| `TREASURY_FEE_LIMIT_SUN` | Positive integer maximum transaction fee limit in SUN; actual TRX must cover it |
| `FIREBLOCKS_API_BASE` | Normally `https://api.fireblocks.io`; only known production API origins are accepted |
| `FIREBLOCKS_API_KEY` | Provider-issued API key ID |
| `FIREBLOCKS_SECRET_KEY_PATH` | Absolute path to a mounted secret file containing the Fireblocks **API authentication** RSA key, not a blockchain signing key |
| `FIREBLOCKS_VAULT_ACCOUNT_ID` | Existing provider vault account ID (numeric) |
| `FIREBLOCKS_USDT_ASSET_ID` | Existing provider asset ID whose metadata must resolve to official TRON USDT |
| `TRONGRID_API_KEY` | Optional server-side read-provider key; never required as a wallet signing secret |
| `DATABASE_SSL` | Optional strict TLS for external PostgreSQL where appropriate |

Do not set `TREASURY_PRIVATE_KEY` for the Fireblocks USDT path. The route does not accept or derive a blockchain private key from the Render environment. The separate legacy native-TRX payout path is disabled in Fireblocks mode; this integration is specifically for USDT withdrawals.

## Request flow and fail-closed behavior

1. The owner signs into the single-owner console and signs a short-lived message that binds the exact origin, treasury, official token contract, recipient, amount, idempotency key and expiry.
2. The backend checks the authenticated session and fresh owner signature.
3. It queries Fireblocks for the configured asset metadata, available balance and vault addresses. It verifies the asset's contract address and checks the provider's available balance.
4. It independently queries the configured TRON address for the actual official-USDT balance and TRX fee coverage. Both provider-available USDT and chain USDT must cover the payout.
5. A PostgreSQL lock serializes the reservation. Existing pending, provider-pending, accepted or ambiguous requests remain reserved. Per-transfer and daily limits are checked before calling the provider.
6. The backend requests a transfer via Fireblocks with the same idempotency key as `externalTxId`. Fireblocks' own approval policy remains in force. On a timeout, the service looks up that same external ID; it does not blindly create a replacement transfer.
7. While Fireblocks has no chain transaction hash, the request remains `provider-pending` or `broadcast-unknown`, and the funds remain reserved. Once a transaction ID is available, the verifier checks the transaction from a public read-only TRON connection.
8. Only a confirmed/solidified transaction with matching sender, recipient, amount, official contract, successful execution receipt, and exact official-USDT `Transfer` event is labelled `confirmed`.
9. Exchange deposit credit is separate. The recipient exchange must report its own deposit status through an authorized source.

## API endpoints

- `GET /api/treasury/withdrawals/readiness` — owner-authenticated configuration, provider authorization credentials, asset identity, provider balance, on-chain balance and fee budget checks.
- `POST /api/treasury/withdrawals` — transaction-specific owner-signed transfer request and database reservation.
- `GET /api/treasury/withdrawals/:idempotencyKey` — lookup and refresh provider transaction status without resubmitting.
- `POST /api/treasury/withdrawals/:idempotencyKey/verify` — reconcile provider state and independently verify a returned on-chain transaction.

## Production readiness checklist

- [ ] Eligible provider account and vault exist; access is authorized for the operator.
- [ ] Provider API user has minimal read/transaction permissions and is protected by provider-side approvals.
- [ ] API authentication RSA key is installed via a Render secret file, never in Git, APK or chat.
- [ ] Fireblocks asset metadata maps to the exact official TRON USDT contract.
- [ ] Exactly one provider address matches `TREASURY_ADDRESS`.
- [ ] The treasury holds actual official USDT and enough TRX for the configured fee cap.
- [ ] Owner wallet matches the owner console identity and approves every request with a fresh signature.
- [ ] Per-payout and daily limits, database idempotency, conservative pending reservations, alerts and pause/recovery procedures are reviewed.
- [ ] Mock tests and the full Node/build CI pass.
- [ ] Conduct a small, controlled end-to-end payout with the provider and verify its confirmed transaction on TRON before meaningful value.
- [ ] Obtain an independent security review before production use.

The repository code alone cannot create provider access, configure the provider's vault or policy, upload credentials to Render, fund the treasury, or prove a successful Mainnet transfer. This integration must remain disabled until those independent setup tasks are complete.

## Managed native-TRX treasury payouts

The managed-signer path uses the same owner-only console and Fireblocks API-user authentication secret file as the USDT route. Native TRX must be configured as an actual Fireblocks native asset: set FIREBLOCKS_TRX_ASSET_ID to the asset ID returned by the operator's workspace. Readiness verifies the provider asset metadata reports assetClass=NATIVE and the TRX symbol, that the vault returns exactly the configured TREASURY_ADDRESS, and that the provider balance agrees with a live public TRON balance read.

Required backend configuration:
- TREASURY_TRX_WITHDRAWALS_ENABLED=false until independently reviewed; never flip this on merely because the variables exist.
- TREASURY_SIGNER_MODE=fireblocks.
- FIREBLOCKS_TRX_ASSET_ID, validated through the provider asset endpoint. Do not guess the identifier if it is not listed in the workspace.
- TREASURY_TRX_MAX_PAYOUT and TREASURY_TRX_DAILY_LIMIT as exact positive decimal TRX values with up to six fractional digits.
- TREASURY_TRX_FEE_RESERVE_SUN as a positive integer. This reserve and the current configured TREASURY_FEE_LIMIT_SUN multiplied by unresolved USDT payouts are excluded from available native TRX.

The route shares the PostgreSQL advisory lock with USDT payouts, uses a unique per-request owner signature and idempotency key, reserves unresolved requests, and submits through Fireblocks. Provider acceptance does not mean the transfer is confirmed. Only a confirmed transaction whose native TransferContract matches the configured treasury, recipient and exact SUN amount is considered on-chain confirmed.

This capability transfers real TRX held by the managed treasury; it is not a separate external organization promising fee sponsorship. Sponsored submission remains disabled until a sponsor agreement, actual funded resource/fee path, provider permissions and end-to-end evidence are independently verified. Keep withdrawals disabled until all configuration, CI, operational and security gates are complete.
