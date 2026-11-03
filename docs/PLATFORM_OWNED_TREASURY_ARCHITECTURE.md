# Platform-owned self-custody treasury architecture

**Status:** selected architecture with an initial source implementation on the feature branch  
**Product scope:** single-owner TRON Token Studio  
**Default funding model:** platform-owned treasury; no external sponsor required  
**Default signing model:** owner-controlled wallet-provider signing; no Fireblocks vault required

## 1. Decision

Use a platform-owned self-custody TRON treasury. The platform owner controls a dedicated TRON Mainnet wallet and funds it with genuine official USDT and enough TRX for network costs. The existing owner identity wallet remains separate and may have zero funds.

For each withdrawal, TronLink connects the separate treasury wallet and presents the transaction-signing prompt. The backend creates and reserves an unsigned transaction, validates the signed result against the stored intent, checks TRON permission-signature weight, broadcasts, and independently verifies the solidified transaction.

This is owner-operated, non-custodial signing—not unattended server-side signing. The backend never receives the treasury private key or seed phrase.

## 2. Wallet roles

### Identity wallet

- Signs the existing one-time login challenge.
- Proves control of `OWNER_WALLET_ADDRESS` / `TREASURY_OWNER_ADDRESS`.
- May have zero TRX and zero USDT.
- The login signature is not a transaction signature and is not authority by itself to spend treasury funds.

### Platform treasury wallet

- Is configured as `PLATFORM_TREASURY_ADDRESS`.
- Is separately connected through TronLink on TRON Mainnet.
- Must match the server-configured treasury address exactly.
- Holds the actual official USDT principal and enough TRX for the network fee reserve.
- Signs each transaction through TronLink. The browser does not submit its private key to the backend.

## 3. Initial source implementation

The feature branch adds:

- `src/PlatformTreasuryPanel.tsx`: modern TronLink provider discovery, authorization, account/network-change handling, readiness display, prepare/sign/submit/status UI.
- `server/routes/platform-treasury-withdrawals.mjs`: Mainnet-only readiness, prepare, submit, and withdrawal-status routes.
- `server/index.mjs`: route mounting under `/api/treasury`.
- `src/WalletVault.tsx`: mounts the self-custody panel in the Treasury view while preserving the legacy Fireblocks panel.
- `tests/platform-treasury-withdrawals.test.mjs`: initial unit/route tests.
- `.env.example`: documents the new settings.

### Endpoints currently implemented in source

- `GET /api/treasury/self-custody/readiness`
- `POST /api/treasury/self-custody/prepare`
- `POST /api/treasury/self-custody/submit`
- `GET /api/treasury/self-custody/withdrawals/:intentId`

These are source-level integrations, not verified live service behavior. The execution flag defaults to false; the route is Mainnet-only, and there is no self-custody testnet e2e route in this initial implementation.

## 4. Security and transaction lifecycle

1. The owner signs in using the existing wallet-auth challenge.
2. The owner connects the separate treasury address via TronLink. The UI checks the account and Mainnet network and clears state on account/network changes.
3. The backend reads the fixed official USDT contract and live TRX balance from TRON Mainnet.
4. The backend estimates fee, constructs an unsigned TRC-20 transfer, checks treasury balance, fee reserve, limits, and outstanding requests, then stores a short-lived prepared intent under an advisory lock.
5. TronLink prompts the owner to sign the exact unsigned transaction.
6. The backend checks that raw transaction data, transaction ID, recipient, amount, and contract are identical to the stored intent. It also calls TRON `getSignWeight` and requires the account permission threshold to be met before broadcast.
7. The backend claims the prepared intent once, broadcasts the already-signed transaction, and records accepted or ambiguous broadcast status. It never blindly retries an ambiguous submission.
8. The status endpoint waits for the solidified transaction, checks the exact sender, recipient, official contract, successful receipt, and exact TRC-20 Transfer event, then records confirmed or failed.
9. A confirmed chain transaction does not mean an exchange credited the deposit. Exchange credit remains unverified until an authorized exchange-side source reports it.

## 5. Funding and fees

- Official TRON USDT contract: `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`.
- Official USDT on TRON has six decimals.
- A token symbol or frontend-displayed number is not evidence of genuine USDT.
- The treasury must have the actual principal before a payout can be sent.
- The treasury also needs enough TRX to cover the fee cap/reservations. Fee sponsorship, if ever integrated, only covers eligible network costs and does not provide USDT principal.
- If the treasury is empty, no positive USDT withdrawal is possible.

## 6. Backend configuration

The new backend settings are:

- `PLATFORM_TREASURY_SELF_CUSTODY_ENABLED=false`
- `PLATFORM_TREASURY_ADDRESS`
- `PLATFORM_TREASURY_MAX_PAYOUT_USDT`
- `PLATFORM_TREASURY_DAILY_LIMIT_USDT`
- `PLATFORM_TREASURY_MAX_FEE_SUN`

The existing identity settings `OWNER_WALLET_ADDRESS` and `TREASURY_OWNER_ADDRESS` must still match. The separate `PLATFORM_TREASURY_ADDRESS` is the wallet connected via TronLink. See [Self-custody treasury runbook](PLATFORM_TREASURY_SELF_CUSTODY_RUNBOOK.md).

## 7. What is not required

| Item | Required? |
|---|---|
| External sponsor organization | No |
| Fireblocks workspace or vault | No |
| Login wallet holding USDT | No |
| Platform treasury holding genuine USDT | Yes |
| Platform treasury having TRX/verified fee coverage | Yes |
| Owner identity session | Yes |
| Separate treasury-wallet signature for every payout | Yes |
| Persistent PostgreSQL | Yes |
| Security and controlled acceptance review | Yes |

## 8. Remaining production work

- Run the full test suite and production build on the branch.
- Add/test a self-custody testnet end-to-end path or an equivalent isolated signing harness.
- Validate TronLink signing with a controlled wallet and permission thresholds.
- Exercise replay, concurrency, expiry, insufficient funds, altered transaction, invalid signatures, broadcast timeout, and post-broadcast reconciliation.
- Complete independent security review and operational pause/recovery procedures.
- Keep the new flag false until all gates pass. No source merge or deployment automatically enables it.
