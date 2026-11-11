# Stage 10B — two-address read-only TRON Mainnet USDT monitoring

## Scope

This stage adds an owner-authenticated, read-only observation endpoint for these two public TRON addresses:

- `TU3kjFuhtEo42tsCBtfYUAZxoqQ4yuSLQ5`
- `THPvaUhoh2Qn2y9THCZML3H815hhFhn5YC`

Both are explicitly classified as `ownershipStatus: not-verified`. Monitoring visibility is not ownership, custody, signer authority, or permission to spend.

## Endpoint

`GET /api/treasury/owner/funding-ledger/watch-addresses?network=mainnet`

The endpoint uses the existing owner-session boundary and existing provider configuration. It queries the bounded recent TRC20 history endpoint for the official TRON Mainnet USDT contract, then checks each candidate against the existing solidified transaction/receipt verifier.

The observer:
- fixes the network to TRON Mainnet;
- fixes the token contract to official USDT `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`;
- requires six decimals and exact integer base-unit values;
- accepts only incoming events whose destination exactly matches the watched address;
- bounds provider response size, event count, and per-address solidified verification count;
- reports pending or mismatched evidence as unverified;
- does not create or update database records.

## Accounting and execution boundary

The response always states:
- `ownershipVerified: false`
- `ledgerMutationPerformed: false`
- `spendableBalanceImpact: none`
- `payoutSubmissionEnabled: false`

Observed transfers are not added to the owner treasury funding ledger, sponsor balances, available balances, reservations, or withdrawal capacity. The endpoint does not call the deposit-credit POST route. It does not sign, prepare, or broadcast transactions.

The 1,000 USDT withdrawal minimum and existing hard-disabled payout execution controls are unchanged.

## Operational limitations

The endpoint inspects a bounded recent history page, not a complete historical archive. The indexer is a candidate-discovery source; a candidate is marked observed only after the existing solidified transaction/receipt verifier matches transaction ID, official token contract, sender, recipient, exact amount, block, and event index. A successful observation still does not establish beneficial ownership, source-of-funds compliance, exchange deposit credit, or spending authority.
