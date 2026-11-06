# Verified Mainnet Treasury Funding Ledger

This feature adds an owner-only, evidence-backed ledger for genuine incoming Tether USDT TRC20 transfers to the configured TRON Mainnet treasury address.

## What it does

- Exposes `GET /api/treasury/owner/funding-ledger?network=mainnet` to the authenticated owner.
- Exposes `POST /api/treasury/owner/funding-ledger/deposits/verify` to verify and record an incoming transfer.
- Requires the configured Mainnet owner wallet session, exact treasury recipient, official Tether TRON USDT contract, exact sender, exact amount, transaction hash, solidified block receipt, and matching Transfer event.
- Uses `(transaction_hash, log_index)` as the unique event key so a repeated verification cannot create a second ledger credit.
- Displays recent verified inflows, total inflows recorded by this ledger, current on-chain USDT, active sponsor-direct payout reservations, the unreserved on-chain balance, and the observed TRX balance.
- Calculates unreserved capacity as the verified current Mainnet USDT balance minus pending/prepared/submitted/reconciling/manual-review sponsor payout reservations. It never treats historical inflows as additional funds after they have been spent.

## What it does not do

- It does not mint, create, borrow, or manufacture USDT or TRX.
- It does not count an unconfirmed/indexer-only transfer as a deposit.
- It does not prove the sender's identity, service revenue, donor intent, lawful source of funds, or compliance status.
- It does not sign, authorize, build, broadcast, or enable an outgoing payout.
- It does not guarantee that an exchange credits a deposit.
- It does not replace the existing sponsor wallet approval and exact transaction signing process.

A verified incoming transfer is an accounting record of an on-chain event, not proof of commercial revenue or source-of-funds compliance. Keep the treasury under appropriate control and comply with relevant legal, tax, provider, and exchange requirements.

## Runtime requirements

The implementation reuses the existing backend configuration; it adds no new secret:

- `TREASURY_OWNER_ADDRESS` (or the existing `OWNER_WALLET_ADDRESS` fallback): owner wallet address used for the Mainnet signed-session check.
- `TREASURY_MAINNET_ADDRESS` (or the existing treasury/sponsor fallback): the exact address that receives and is monitored for real USDT.
- `DATABASE_URL`: persistent PostgreSQL storage for the immutable-by-API verified-inflow ledger and payout reservations.
- `TATUM_MAINNET_API_KEY` or `TATUM_API_KEY`: server-side Tatum credential used to query SolidityNode transaction and receipt evidence.
- The exact deployed frontend origin must remain in the existing backend CORS/session origin allowlist.

Do not put credentials, wallet private keys, recovery phrases, or signing material in frontend variables, source files, or chat.

## Owner workflow

1. Configure a dedicated TRON Mainnet treasury address that you are authorized to use. It can receive funds without the owner's identity wallet holding USDT or TRX.
2. Have a legitimate payer transfer official USDT TRC20 to that exact address. The payer's transaction must be real and solidified; this application does not create the payment.
3. In Wallet Vault → Mainnet → Treasury, complete the owner wallet identity check.
4. Enter the incoming transaction hash, sender address, and exact received USDT amount. Select **Verify and record incoming USDT**.
5. The backend independently checks the transaction body and exact official USDT Transfer event before recording it. Refresh the ledger to read the current on-chain balance and payout reservations.
6. To use the treasury as an outgoing sponsor, its wallet must separately be registered and owner-approved in the sponsor-direct workflow, meet fresh on-chain USDT and TRON fee/resource requirements, and sign each exact payout. This ledger alone cannot spend those funds.

## Data and deployment notes

The backend creates `trc20_token_clone.owner_treasury_verified_inflows` idempotently on first use. Each row stores only the transaction/event identity, public addresses, amount, block, owner address that verified it, verification source, and timestamps. It does not store keys or raw provider responses.

The API fails closed when database storage, the exact configured treasury address, a solidified Mainnet receipt, or a matching on-chain event cannot be verified. A failed or pending verification creates no ledger entry. A transaction/log pair already present is returned as an existing record, not credited again.

This feature can track actual incoming funding and show the unreserved balance. It cannot make a private owner-only platform self-financing without legitimate payers or other real inflows.
