# Owner-only treasury-funded USDT withdrawals

This feature lets the single configured owner request a withdrawal from a separate, funded TRON Mainnet treasury. It does not mint USDT, create a synthetic balance, or guarantee that an exchange credits a deposit.

## Current behavior

- Route prefix: `/api/treasury`
- `GET /withdrawals/readiness`: owner-authenticated configuration and on-chain funding check.
- `POST /withdrawals`: owner-authenticated treasury payout.
- `POST /withdrawals/:idempotencyKey/verify`: independently verify the saved transaction against a confirmed TRON transaction and explicit contract execution receipt.
- `GET /withdrawals/:idempotencyKey`: retrieve a previously recorded request.
- Only the official TRON Mainnet USDT contract is accepted: `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`.
- The existing wallet-auth signed challenge/session must identify the exact `TREASURY_OWNER_ADDRESS` on Mainnet and match the request Origin.
- The treasury signing key is server-side only. The client never submits a private key.
- The treasury signer key must derive `TREASURY_ADDRESS`. That address must hold actual USDT.
- Per-transfer, daily, and minimum native-TRX reserve limits are mandatory. Pending or ambiguous requests reserve principal until reconciled; idempotency keys are bound to the exact owner, treasury, recipient, token contract, and amount.
- The exact unsigned/signed transaction intent is validated before broadcast, and the locally calculated transaction ID is persisted before network submission. An uncertain broadcast is recorded as `broadcast-unknown`; do not retry with a new key. Reconcile the saved transaction hash first.
- `broadcast-accepted` means the node accepted the broadcast response, not that the transaction is confirmed. The verify endpoint requires the exact official token contract, sender, recipient, amount, transaction ID, and a successful confirmed receipt before setting `confirmed`. Exchange credit is controlled by the receiving exchange.

## Required backend environment variables

Set these only in the backend service's secret/environment settings, never in `VITE_*` variables, frontend files, APK resources, or Git:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Persistent PostgreSQL database for idempotency and audit state |
| `TREASURY_WITHDRAWALS_ENABLED=true` | Explicit opt-in to allow payouts |
| `TREASURY_SIGNER_MODE=env-hot-wallet` | Explicit opt-in to the current environment-key signer |
| `TREASURY_OWNER_ADDRESS` | The one owner wallet address allowed to request payouts |
| `TREASURY_ADDRESS` | Public address of the separate treasury wallet |
| `TREASURY_PRIVATE_KEY` | Treasury private key; high-risk secret, never expose to clients |
| `TREASURY_MAX_PAYOUT_USDT` | Maximum amount per withdrawal, decimal USDT (up to 6 decimals) |
| `TREASURY_DAILY_LIMIT_USDT` | Maximum aggregate reserved amount per UTC database day |
| `TREASURY_FEE_LIMIT_SUN` | Explicit TRON smart-contract fee limit in SUN; positive integer, at most `100000000` SUN (100 TRX) |
| `TREASURY_MIN_TRX_RESERVE` | Minimum TRX reserve in decimal TRX (up to 6 decimals). The treasury must hold this reserve plus the configured fee cap before sending. |

The feature stays disabled unless all required values are configured and valid. The private key must correspond to `TREASURY_ADDRESS`; the owner wallet and treasury wallet are intentionally separate.

## Security and rollout requirements

1. Use a dedicated, low-balance treasury and fund it with genuine USDT and enough TRX for fees. Set `TREASURY_MIN_TRX_RESERVE` to a conservative minimum. The configured reserve plus the transaction fee cap must be available in TRX; fee sponsorship cannot supply the USDT principal.
2. The current `env-hot-wallet` signer is a simple server-side custody integration, not an HSM/KMS. Do not put significant assets at risk before an independent security review. Prefer a custody provider or isolated signer with transaction-policy enforcement before production use.
3. Set a small per-withdrawal cap and daily cap first. Restrict backend access, protect Render environment access, rotate credentials, and monitor all withdrawal records.
4. Deploy only after CI passes, database persistence is verified, and the owner session origin is configured in the backend allowlist.
5. Start with a small, controlled Mainnet transfer to an address you control. Independently verify the transaction hash, contract, sender, recipient, amount, and successful solidified receipt in TRON tooling.
6. An exchange deposit address must be correct for TRON/TRC-20 USDT. Exchange credit and withdrawal availability are controlled by the receiving exchange; this service cannot force acceptance.

## API request

`POST /api/treasury/withdrawals`

Headers: `Authorization: Bearer <wallet-auth-session>`, `Origin: <configured owner app origin>`

Body:

```json
{
  "recipientAddress": "T...",
  "amountUsdt": "1.25",
  "idempotencyKey": "withdrawal-unique-key-at-least-24-chars"
}
```

The idempotency key must be reused to query an uncertain request. A duplicate key never initiates a second broadcast.

## Known limitations

- Receipt verification is request-driven through `POST /withdrawals/:idempotencyKey/verify`; there is no independent background confirmation worker yet.
- The Wallet Vault owner panel invokes the treasury readiness, withdrawal, and receipt-verification routes. It still requires the backend's allowed Origin list, owner session, and secret environment variables to be configured.
- Environment-key custody requires hardening before significant Mainnet use.
- Deployment and end-to-end Mainnet behavior must be validated separately; adding this code does not prove it is live or funded.
