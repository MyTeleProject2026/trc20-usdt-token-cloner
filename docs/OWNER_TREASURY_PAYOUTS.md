# Owner-only treasury-backed USDT withdrawals

## What this feature does

The Wallet Vault is intended for one configured owner, not a public no-auth wallet service. The owner signs the app's one-time wallet-identity challenge. The API accepts a payout only when that authenticated Mainnet address matches `TREASURY_OWNER_ADDRESS`. The private console login address `OWNER_WALLET_ADDRESS` must also exactly match `TREASURY_OWNER_ADDRESS`; mismatches disable the payout route.

The withdrawal API signs a transfer using a separate server-side treasury key. Therefore, the owner identity wallet does not need to personally hold the USDT principal if the server treasury is funded. **The treasury must hold the genuine USDT being paid out. This service does not mint, generate, clone, or manufacture USDT.** A zero-balance treasury cannot send USDT.

Only the official TRON Mainnet Tether USDT contract is used by this route: `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`. The route does not create a credit in an exchange's internal ledger. The receiving exchange controls whether and when a deposit is credited.

## Render backend environment

Configure these values on the **backend API service only**. Never commit credentials, paste them into the APK, or expose them through any `VITE_*` variable.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Persistent PostgreSQL connection for owner sessions and withdrawal idempotency/reservation records. |
| `OWNER_WALLET_ADDRESS` | The one public address allowed through the password-protected console login; must match `TREASURY_OWNER_ADDRESS` exactly. |
| `TATUM_API_KEY` | Provider credential used by the owner panel's read-only funding check. |
| `FRONTEND_ORIGIN` | Existing hosted frontend origin allowed by the API's CORS policy. Preserve existing entries when changing it. |
| `PACKAGED_APP_ORIGINS` | Optional additional origin allowlist for the packaged application; use the exact configured origins. |
| `TREASURY_OWNER_ADDRESS` | Public Mainnet address permitted to authenticate as the owner. The owner must sign the wallet identity challenge for this address. |
| `TREASURY_ADDRESS` | Public address derived from the server treasury private key; it must match the key and the address reported by the owner funding check. |
| `TREASURY_PRIVATE_KEY` | **Secret.** Private key for a dedicated Mainnet treasury signer. Server environment only; never in source control, browser storage, application logs, or the APK. |
| `TREASURY_MAX_PAYOUT_USDT` | Maximum allowed amount per payout, as a positive decimal with at most six fractional digits. |
| `TREASURY_DAILY_LIMIT_USDT` | Maximum reserved payout principal per UTC/database day, as a positive decimal with at most six fractional digits. |
| `TREASURY_FEE_LIMIT_SUN` | Integer TRON transaction fee limit in SUN. Choose a conservative value after fee/resource testing; the value is not a source of fees or funds. |
| `TREASURY_WITHDRAWALS_ENABLED` | Must be exactly `true` to opt in after reviewing all controls. |
| `TREASURY_SIGNER_MODE` | Must be exactly `env-hot-wallet` for the current implementation. |

The API also requires valid values for all payout configuration fields and checks that the private key derives exactly `TREASURY_ADDRESS`. Readiness also verifies a positive official-USDT principal balance and a treasury TRX balance at least equal to `TREASURY_FEE_LIMIT_SUN`; the actual withdrawal request repeats the TRX check under the database reservation lock. This is a conservative check of the full configured cap, not a claim that the full amount will be spent. A missing setting, zero principal balance, or insufficient fee budget keeps withdrawals disabled. The local frontend is not permitted to enable this route by itself.

## Owner-console environment check

The public read-only endpoint `GET /api/auth/owner/config` reports only whether the owner address, scrypt password hash, database URL, and allowed application origins are configured. It returns missing **variable names** when setup is incomplete; it never returns the owner address, password hash, database URL, private keys, or other credential values. This endpoint is not proof that treasury withdrawals are enabled or funded.

To verify actual payout readiness, sign into the private owner console, unlock the correct local owner wallet, and use **Sign owner check & read treasury** in Wallet Vault on TRON Mainnet. The authenticated **withdrawals readiness** request checks the configured treasury signer/address relationship, the real official-USDT balance, and fee coverage. If any check is missing or ambiguous, the payout remains disabled. Do not share owner passwords, private keys, recovery phrases, or environment secret values to troubleshoot the configuration.

## Real transfer flow

1. Unlock the configured owner wallet and sign the one-time identity challenge. A typed address alone is not authentication.
2. Refresh the owner treasury panel. It must read the actual official-USDT balance and identify the same treasury address as the server signer.
3. Enter a valid TRON recipient, a decimal USDT amount within both configured limits, and type `SEND TREASURY USDT`.
4. The app signs a separate, short-lived owner authorization message with the unlocked local owner wallet. The signed message binds the app origin, owner, treasury, official USDT contract, recipient, exact six-decimal base-unit amount, idempotency key, and expiry. The private key is never sent to the API. This signature is not a blockchain transaction; it authorizes only the listed payout request.
5. The backend verifies the recovered signer equals the authenticated owner and rejects changed, expired, or malformed authorization before reserving funds or broadcasting.
6. The backend serializes payout reservations in PostgreSQL, re-reads the live on-chain balance, and subtracts funds committed to unresolved broadcasts before accepting a new request.
7. Before reserving USDT, the server checks that the treasury's actual TRX balance covers the configured `TREASURY_FEE_LIMIT_SUN` maximum fee cap. This conservative gate can block a wallet that might have sufficient delegated resources, because this endpoint does not yet integrate a verified gas-sponsorship adapter. The server then signs and broadcasts the official USDT transfer from the funded treasury. **This endpoint does not make the transfer gas-free automatically.**
8. Use **Verify receipt & look up saved status** with the same stored idempotency key. The verifier checks the transaction body, sender, official contract, recipient, amount, solidified receipt, and the single matching official-USDT `Transfer` event.

A node's broadcast response is only an accepted submission. It is not a successful transaction receipt. If the outcome is ambiguous, keep the original request key and reconcile it; do not create a new key to repeat the payout. Outstanding ambiguous requests remain reserved conservatively until resolved.

## Operational safety

- Use a dedicated treasury wallet and keep its exposure low. The environment hot-wallet mode places a valuable signing secret on the backend and carries custody risk; it has not been independently audited.
- Do not enable this against a personal wallet or an unreviewed production service. Verify backup/recovery, environment access control, database durability, rate limits, alerting, spend caps, and rollback/reconciliation procedures first.
- First test application logic with mocked providers and TRON testnet assets. This withdrawal endpoint is Mainnet-only and must not be used for testnet simulations.
- No Mainnet payout is considered confirmed until the confirmation endpoint verifies the actual transaction and its event. Exchange credit is a separate status that must be observed from authorized exchange records, where available.
- No amount in this application can make a transaction spendable if real tokens were not transferred to the recipient's address. Do not display fabricated balances as genuine assets.
