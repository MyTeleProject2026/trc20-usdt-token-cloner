# Stage 8E — incoming TRON Mainnet USDT deposit evidence boundary

## Purpose

Add a pure, fail-closed classification layer for incoming deposits as a potential additional funding source. This stage does not activate deposit crediting, automatic sweeping, custody transfers, or payout execution.

## Existing repository capability

PR #151 already contains:
- a read-only watch-address observer for two addresses whose ownership is explicitly unverified;
- an owner-treasury funding ledger with a separate verified-inflow record;
- solidified TRON transaction/receipt verification.

The two watch addresses are not automatically the designated treasury. An incoming transfer to either watch address must not be counted as owner treasury funds or withdrawal capacity.

## Evidence requirements

The new helper requires all of the following to match:
- TRON Mainnet;
- designated treasury destination exactly;
- official USDT TRC20 contract `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`;
- six decimals and positive integer base units;
- transaction hash, block number and log index;
- solidified finality;
- independent proof matching transaction, contract, sender, recipient, amount, block and log index.

This is an evidence classifier, not a provider or chain verifier. Callers must obtain proof from the existing trusted server-side verifier. Browser-supplied fields are not authority.

## Non-operational boundary

Even a matching result always returns:
- `ledgerCreditAuthorized: false`
- `automaticSweepAuthorized: false`
- `spendableBalanceImpact: none`
- `payoutAuthorizationGranted: false`
- `executionEnabled: false`

No database writes, migrations, balance aggregation, reservations, sweeps, signing, broadcasts, or transfers are introduced. No historical records are modified. The 1,000 USDT minimum is unchanged.

## Future work required before operational deposit collection

A separate reviewed stage would need to define ownership/control of the designated treasury address, provider custody reconciliation, event idempotency using transaction hash plus log index, source-of-funds and reversal handling, ledger posting rules, and independent reconciliation. Only after those controls are approved could a distinct operational authorization review be considered.
