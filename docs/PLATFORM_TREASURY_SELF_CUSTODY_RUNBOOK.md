# Platform treasury self-custody runbook

**Scope:** owner-operated TRON Mainnet USDT withdrawals using a separate TronLink treasury wallet.  
**Provider dependency:** TronLink plus a TRON read/broadcast node. Fireblocks and a third-party sponsor are not required by this path.

## 1. Understand the two wallets

- **Owner identity wallet:** used for the existing TRON Token Studio login. It may hold zero TRX and zero USDT. Its signature proves login identity only.
- **Platform treasury wallet:** the separately controlled wallet configured in `PLATFORM_TREASURY_ADDRESS`. It must hold the real USDT principal and sufficient TRX for fees. Each withdrawal is signed through TronLink.

Do not paste a private key or seed phrase into the backend, Render environment, GitHub, chat, browser form, or database. Do not assume the login wallet is the treasury wallet.

## 2. Backend environment

Set values on the existing Render backend service only:

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | Persistent PostgreSQL for intents/reservations and status |
| `OWNER_WALLET_ADDRESS` | Existing owner identity wallet address |
| `TREASURY_OWNER_ADDRESS` | Must exactly match `OWNER_WALLET_ADDRESS` |
| `PLATFORM_TREASURY_ADDRESS` | Separate platform-owned TRON Mainnet treasury address |
| `PLATFORM_TREASURY_MAX_PAYOUT_USDT` | Maximum USDT principal per payout |
| `PLATFORM_TREASURY_DAILY_LIMIT_USDT` | Maximum total USDT principal within rolling 24 hours |
| `PLATFORM_TREASURY_MAX_FEE_SUN` | Maximum permitted estimated fee in SUN (1 TRX = 1,000,000 SUN); accepted configuration range is 1–100 TRX |
| `PLATFORM_TREASURY_SELF_CUSTODY_ENABLED` | Keep literal `false` until tests, review, and controlled acceptance are complete |

The frontend origin allowlist and normal backend database configuration also remain required. No private key or signing secret is configured for this self-custody path.

## 3. Fund the treasury

Use the owner’s independently controlled wallet or another documented, authorized source to send genuine official TRON USDT and TRX to the exact `PLATFORM_TREASURY_ADDRESS`. Verify the address in the wallet before funding.

The application checks:
- Official USDT contract `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`.
- USDT decimals = 6.
- Live TRX balance.
- Existing prepared/broadcast reservations.
- Per-payout and rolling 24-hour principal limits.
- Transaction-specific energy/fee estimate against the configured maximum.

An app setting cannot create USDT or TRX. A zero balance cannot fund a payout.

## 4. Use the frontend

1. Open TRON Token Studio and sign in through the existing owner identity flow.
2. Open the Treasury section.
3. Choose **Connect treasury wallet**. TronLink prompts you to authorize the application.
4. Ensure TronLink is on TRON Mainnet and the connected address equals the configured `PLATFORM_TREASURY_ADDRESS`.
5. Refresh treasury balances and inspect readiness blockers.
6. Enter the recipient's TRON address and USDT amount.
7. Choose **Prepare USDT withdrawal**. The backend creates an unsigned transaction and an expiring database reservation. This does not send funds.
8. Review the source, destination, amount, contract, and fee in the panel, then choose **Sign in TronLink & submit**. TronLink displays its own transaction-signing prompt. Approve only if every detail is correct.
9. The backend checks the signed transaction against the stored intent and checks TRON permission weight before broadcasting. Each prepare request uses a UUIDv4 request key; if a network retry occurs, resend the same key with the same destination and amount to retrieve the existing intent rather than create another. Reusing a key with changed details is rejected.
10. Use **Refresh status** until the solidified-chain verifier reports confirmed or failed. A node's broadcast acceptance is not final confirmation.
11. After a browser refresh or reconnect, use **Recent withdrawals**. Choose **Resume prepared request** to restore the same unexpired unsigned intent, or **Reconcile original transfer** for a request that has entered a broadcast state. Do not create a replacement request while an earlier request is outstanding.
11. For exchange destinations, check the exchange's own deposit records. TRON Token Studio reports exchange credit as unverified.

If the browser reports an ambiguous broadcast result, do not submit a new payout. Refresh the original intent status and investigate the original transaction ID.

## 5. API contract

- `GET /api/treasury/self-custody/readiness`
- `POST /api/treasury/self-custody/prepare` with `recipientAddress` and `amountUsdt`
- `POST /api/treasury/self-custody/submit` with `intentId` and the TronLink-signed transaction
- `GET /api/treasury/self-custody/withdrawals?limit=20` returns recent owner-scoped history. Prepared, unexpired intents include the original unsigned transaction so the browser can resume the same intent after refresh; the response also reports whether any outstanding intent exists.
- `GET /api/treasury/self-custody/withdrawals/:intentId`

All routes require the existing owner identity session. The submission route does not accept private keys.

## 6. Current implementation caveats

- The self-custody API is Mainnet-only in this initial implementation.
- PostgreSQL integration coverage for same-key replay, changed-detail rejection, concurrent same-key prepare, and refresh/restart recovery has been added to CI; check the current PR CI result before treating it as passed.
- The feature flag defaults to false. Do not enable it just to make the UI proceed.
- No self-custody testnet end-to-end path, independent security review, or real Mainnet acceptance transaction has yet been evidenced by this source change.
- The older Fireblocks-backed route remains separate and hard-disabled in the current build.
- A real transfer cannot be made until actual funds and an authorized treasury wallet are available.

## 7. Production release checklist

- [ ] Code review and security review complete.
- [ ] Full Node test suite and Vite production build pass.
- [ ] TronLink account/network/signing lifecycle validated with a controlled wallet.
- [ ] Signed transaction permission threshold is checked successfully.
- [ ] Tests cover changed recipient/amount, altered raw data, invalid signature, insufficient permission, request-key replay and concurrent same-key prepare, expiry, insufficient USDT/TRX, and ambiguous broadcast.
- [ ] Database persistence, restart behavior, and reconciliation reviewed.
- [ ] Real treasury address and official-token identity independently confirmed.
- [ ] Treasury has enough USDT and TRX for the controlled acceptance transaction.
- [ ] Owner explicitly approves the release.
- [ ] Controlled, small Mainnet acceptance transaction is independently verified after all preceding gates pass.

Do not send private keys or seed phrases to support personnel or application servers. Keep the execution feature off until the entire checklist is satisfied.
