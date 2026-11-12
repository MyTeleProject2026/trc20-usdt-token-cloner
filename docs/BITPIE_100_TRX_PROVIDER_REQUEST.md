# Bitpie 100 TRX provider-funded withdrawal request

## Request profile

- Network: TRON Mainnet
- Asset: native TRX (not TRC-20 USDT)
- Amount: 100 TRX
- Destination: `TLBWTZHjjRMwbFgKgqmLwjp4ZKjxt5a2GT`
- Funding source: approved provider-owned funds or a provider-approved credit facility only
- Current state: draft; no provider request has been submitted

The Tron Transfer UI exposes this as a fixed request draft. It does not create a provider account, obtain credit, reserve real funds, or submit a blockchain transaction.

## Conditions required before live execution

1. Confirm the destination by opening Bitpie and checking **TRX → Receive** on TRON Mainnet. A syntactically valid TRON address is not proof that it belongs to the intended Bitpie account.
2. Complete the provider's required account onboarding and obtain written authorization for this owner account and TRON Mainnet native TRX payouts.
3. Configure a reviewed provider adapter and server-side credentials. Never put provider secrets, private keys, or recovery phrases in frontend code or this repository.
4. Verify that the provider account has at least 100 TRX of spendable principal plus the required network-fee budget, or has an explicitly approved credit facility covering both.
5. Enforce the exact destination allowlist, fixed 100 TRX amount, per-request and daily limits, idempotency, audit logging, and an emergency stop.
6. Submit only through the provider's documented signing/execution flow. Store the provider transaction reference and actual TRON transaction ID.
7. Keep the request pending until the solidified Mainnet transaction body confirms the exact recipient and amount. A provider acknowledgement or broadcast response is not final confirmation.

## Current repository limitation

The native TRX treasury route in `server/routes/treasury-withdrawals.mjs` is guarded by the constant `REAL_VALUE_PAYOUT_EXECUTION_DISABLED = true`. This hard gate must remain in place until a real provider account, funding authorization, asset balance, fee coverage, adapter behavior, and mainnet reconciliation have been independently tested and reviewed. Environment variables must not override this gate.

The current UI is therefore a transparent request draft only. It must not display “sent”, “paid”, or “credited” and must not claim that the Bitpie wallet has received TRX.

## Security

Never share a Bitpie seed phrase, recovery phrase, private key, or wallet password. Use the receiving address displayed inside the official Bitpie application and verify the network before accepting a payout.
