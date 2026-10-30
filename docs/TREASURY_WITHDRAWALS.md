# Owner-only managed-provider USDT withdrawals

## Scope and non-negotiable requirements

This is a single-owner, treasury-funded TRON Mainnet payout workflow. It does not mint USDT, generate a local balance that can be spent on-chain, forge transaction hashes, or guarantee a receiving exchange's deposit credit.

A successful payout must move genuine USDT from the configured Fireblocks vault to the exact recipient by calling Fireblocks' managed signing API, then independently verify the confirmed TRON transaction, successful receipt, official Tether TRC-20 contract and matching `Transfer` event. A provider request ID or broadcast hash alone is not confirmation.

The owner’s local Wallet Vault identity wallet does not need to hold the USDT principal. The authorized Fireblocks vault must hold the real USDT, the matching on-chain address must hold that USDT, and actual TRX must cover the configured `TREASURY_FEE_LIMIT_SUN` reserve unless a separately verified fee sponsor is integrated. This repository currently does **not** assume a sponsored-fee path.

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
| `TREASURY_FEE_LIMIT_SUN` | Positive integer fee-estimate threshold and conservative per-request TRX reserve in SUN; actual TRX must cover the reserve. It is not a Fireblocks-enforced hard transaction fee limit. |
| `FIREBLOCKS_API_BASE` | Normally `https://api.fireblocks.io`; only known production API origins are accepted |
| `FIREBLOCKS_API_KEY` | Provider-issued API key ID |
| `FIREBLOCKS_SECRET_KEY_PATH` | Absolute path to a mounted secret file containing the Fireblocks **API authentication** RSA key, not a blockchain signing key |
| `FIREBLOCKS_VAULT_ACCOUNT_ID` | Existing provider vault account ID (numeric) |
| `FIREBLOCKS_USDT_ASSET_ID` | Existing provider asset ID whose metadata must resolve to official TRON USDT |
| `FIREBLOCKS_TRX_ASSET_ID` | Existing provider asset ID for native TRX; required by both payout routes to verify provider-available fee funds and independently validate native-TRX metadata |
| `TRONGRID_API_KEY` | Optional server-side read-provider key; never required as a wallet signing secret |
| `DATABASE_SSL` | Optional strict TLS for external PostgreSQL where appropriate |

Do not set `TREASURY_PRIVATE_KEY` for either Fireblocks payout path. Both the USDT and native-TRX routes use the Fireblocks vault as the source and let Fireblocks custody perform transaction signing; neither should load a blockchain private key into the application. `FIREBLOCKS_TRX_ASSET_ID` is required for both routes: provider metadata must confirm native TRX with six decimals and no token contract, and the asset address must match `TREASURY_ADDRESS`. USDT withdrawals also verify the provider-available TRX balance, then reserve one maximum fee cap for every unresolved USDT/TRX request plus the new payout. Both provider-available and chain-observed TRX must cover the complete reserve. Keep `TREASURY_WITHDRAWALS_ENABLED=false` and `TREASURY_TRX_WITHDRAWALS_ENABLED=false` until the actual provider asset IDs, authorized vault, exact treasury address, provider-available balances, on-chain balances, fee reservations, limits and a controlled end-to-end test are verified. No payout route should fall back to an application-held key.

## Request flow and fail-closed behavior

1. The owner signs into the single-owner console and signs a short-lived message that binds the exact origin, treasury, official token contract, recipient, amount, idempotency key and expiry.
2. The backend checks the authenticated session and fresh owner signature.
3. It queries Fireblocks for the configured asset metadata, available balance and vault addresses. It verifies the asset's contract address and checks the provider's available balance.
4. It independently queries the configured TRON address for actual official-USDT and TRX balances, verifies Fireblocks' native-TRX asset metadata and matching vault address, and reads provider-available TRX. Both USDT ledgers must cover the principal, while chain and provider TRX must cover the configured per-request fee reserve for every unresolved payout plus the new request. A current Fireblocks estimate is checked against the configured threshold before the provider transfer request is created; the estimate does not guarantee a hard upper bound on the final fee.
5. A shared PostgreSQL advisory lock serializes USDT and native-TRX reservations. Existing pending, provider-pending, accepted or ambiguous requests remain reserved, including a cross-asset per-request fee-reserve reservation. Per-transfer and daily limits are checked before calling the provider.
6. The backend requests a transfer via Fireblocks with the same idempotency key as `externalTxId`. Fireblocks' own approval policy remains in force. On a timeout, the service looks up that same external ID; it does not blindly create a replacement transfer.
7. While Fireblocks has no chain transaction hash, the request remains `provider-pending` or `broadcast-unknown`, and the funds remain reserved. Once a transaction ID is available, the verifier checks the transaction from a public read-only TRON connection.
8. **Provider-side terminal failure is not chain-verified failure.** The status endpoint must not label a Fireblocks `FAILED` response as an independently verified TRON receipt unless the solidified-chain verifier itself recorded the failure evidence. A provider-side failure without that evidence is returned as `provider-failed` with `verification.verified=false`.
9. Only a confirmed/solidified transaction with matching sender, recipient, amount, official contract, successful execution receipt, and exact official-USDT `Transfer` event is labelled `confirmed`.
10. Exchange deposit credit is separate. The recipient exchange must report its own deposit status through an authorized source.

## API endpoints

- `GET /api/treasury/withdrawals/readiness` — owner-authenticated configuration, provider authorization credentials, asset identity, provider balance, on-chain balance and fee budget checks.

### Readiness checks while payout gates are off

The readiness endpoints are diagnostics, not transfer-submission endpoints. For USDT, when Fireblocks provider credentials, the configured USDT/TRX asset IDs and a syntactically valid `TREASURY_ADDRESS` are present, the API probes provider metadata, vault addresses, provider-available balances, and public-chain balances even when `TREASURY_WITHDRAWALS_ENABLED=false`. The response separates `configurationComplete` and `featureFlagEnabled`; `withdrawalsEnabled` and `preflightChecksPassed` describe the configured preflight state only. The native-TRX readiness route follows the same distinction for its own gate.

**Current-build execution gate:** both readiness endpoints return `executionEnabled: false` and `executionBlocker: "real-value-payout-execution-disabled-in-this-build"`. The blocker is enforced in backend code, not controlled by Render environment variables. The same reason is included in `payoutBlockers`, and both POST submission endpoints return HTTP 503 before owner-session or Fireblocks calls. The UI must treat `executionEnabled` as the execution status; a successful preflight or a true `withdrawalsEnabled` value is not permission or proof that a payout can be submitted.

Do not enable a payout switch to make readiness diagnostics run. The probe is read-only and must never create, sign or broadcast a transaction. A successful read-only snapshot still does not authorize spending or prove that a controlled transfer has settled.
- `POST /api/treasury/withdrawals` — transaction-specific owner-signed transfer request and database reservation.
- `GET /api/treasury/withdrawals/:idempotencyKey` — lookup and refresh provider transaction status without resubmitting.
- `POST /api/treasury/withdrawals/:idempotencyKey/verify` — reconcile provider state and independently verify a returned on-chain transaction.
- `GET /api/treasury/trx-withdrawals/readiness` — owner-authenticated native-TRX provider, vault address, balances, fee reservations and limit checks.
- `POST /api/treasury/trx-withdrawals` — owner-authorized native-TRX request through Fireblocks, with database idempotency and provider external ID.
- `GET /api/treasury/trx-withdrawals/:idempotencyKey` and `POST /api/treasury/trx-withdrawals/:idempotencyKey/verify` — lookup and independently reconcile native-TRX chain receipt evidence.

## Production readiness checklist

- [ ] Eligible provider account and vault exist; access is authorized for the operator.
- [ ] Provider API user has minimal read/transaction permissions and is protected by provider-side approvals.
- [ ] API authentication RSA key is installed via a Render secret file, never in Git, APK or chat.
- [ ] Fireblocks asset metadata maps to the exact official TRON USDT contract.
- [ ] Exactly one provider address matches `TREASURY_ADDRESS`.
- [ ] The treasury holds actual official USDT; both the TRON chain and Fireblocks provider report enough available TRX for the configured reserve per unresolved payout plus the proposed request.
- [ ] Current Fireblocks low/medium/high transaction fee estimates are complete and below the configured threshold; actual costs are reconciled after settlement.
- [ ] Owner wallet matches the owner console identity and approves every request with a fresh signature.
- [ ] Per-payout and daily limits, database idempotency, conservative pending reservations, alerts and pause/recovery procedures are reviewed.
- [ ] Mock tests and the full Node/build CI pass.
- [ ] Conduct a small, controlled end-to-end payout with the provider and verify its confirmed transaction on TRON before meaningful value.
- [ ] Obtain an independent security review before production use.

The repository code alone cannot create provider access, configure the provider's vault or policy, upload credentials to Render, fund the treasury, or prove a successful Mainnet transfer. This integration must remain disabled until those independent setup tasks are complete.