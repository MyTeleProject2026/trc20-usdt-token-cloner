# Stage 8F — provider/chain balance reconciliation boundary

## Verified repository context at parent HEAD

Parent PR HEAD: `e5f5a08c551f280261ea54173cd19a30c084e3b6`.

The existing owner treasury funding ledger:
- reads an on-chain TRON Mainnet balance and official USDT contract balance through the existing Tatum SolidityNode reader;
- records owner-verified deposit events with a unique database key on `(transaction_hash, log_index)`;
- detects duplicate events and rejects conflicting event contents;
- subtracts active sponsor-direct reservations when calculating available balance;
- keeps payout submission disabled.

The watch-address observer remains read-only and ownership-unverified. Its observations do not affect spendable balances.

## Added in this stage

A pure comparison helper accepts independent authenticated provider and chain snapshots and requires:
- TRON Mainnet on both sources;
- the official TRC20 USDT contract and six decimals;
- identical wallet addresses;
- verified status from both sources;
- valid, fresh timestamps (default maximum age: 120 seconds);
- exact equality of integer base-unit balances.

A matching result is only a reconciliation observation. It does not authorize ledger credit, credit drawdown, withdrawal, signing, or broadcast.

## Explicit limitations

This helper is not a FYStack API adapter and does not call FYStack. No FYStack authenticated balance snapshot is currently wired into the application. It cannot be used with browser-supplied data as authority. A future server-side provider adapter must independently authenticate FYStack responses and normalize the wallet identity, network, official token contract, decimals, base-unit balance and checked-at timestamp.

No existing route, dashboard, database schema, historical record, minimum-withdrawal rule, or execution gate is changed by this additive helper. No migrations, ledger writes, sweeping, signing, broadcasting or transfers are introduced.
