# Fincra-funded USDT withdrawals

This project uses Fincra as the sole payout provider for official TRON Mainnet USDT TRC20. Tatum is the TRON chain-data and RPC provider used by the application to read balances, inspect transaction state and verify solidified transfer receipts.

The owner's local wallet is an identity and authorization wallet. It does not have to hold the USDT principal for a Fincra payout. The principal must exist in the authorized Fincra business payout account, or Fincra must have formally approved a credit arrangement. This is not a free or unfunded payout model: code cannot create USDT principal, borrow funds without approval, or make an exchange credit a transfer.

The Fincra integration uses the fixed TRC20 payout scheme. It persists a unique customer reference, applies configured per-payout/daily limits, requires an owner signature for the exact recipient/name/amount, and reconciles the provider status by the same reference. Provider success is not chain confirmation; Tatum must verify the exact solidified official-USDT transfer event.

## Disabled-by-default controls

- `FINCRA_PAYOUTS_ENABLED=false` until authorized provider setup and controlled testing.
- `REAL_VALUE_PAYOUT_EXECUTION_DISABLED` remains true in this build.
- The sandbox and live API bases are allowlisted.
- Provider secrets remain server-side.
- Unknown API outcomes remain unresolved and must be reconciled, never retried with a new reference.
- Mainnet confirmation requires the official Tether TRC20 contract, exact destination and six-decimal amount.
- An exchange's internal deposit-credit decision is outside this project's chain verification.

See [FINCRA_TATUM_PAYOUT_ARCHITECTURE.md](FINCRA_TATUM_PAYOUT_ARCHITECTURE.md) for details.
