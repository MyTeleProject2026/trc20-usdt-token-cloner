# Stage 10C — External recipient delivery assurance

## Scope

This stage adds explicit recipient-network acknowledgement and persistent evidence for a successfully verified solidified Mainnet transfer. It does not enable signing or broadcasting.

## Recipient assurance

New withdrawal preparation requests must declare `recipientNetwork: TRON_MAINNET_TRC20` and `recipientNetworkConfirmed: true`. The server validates that the destination is a valid, non-self TRON address and records the acknowledgement. This records the sender's network selection only; it cannot prove that an exchange controls the address or will credit its internal account.

## Solidified evidence

When the existing verifier returns an exact successful solidified official-USDT transfer, the withdrawal row records the solidified block number, event index, and verification timestamp. The API and history UI expose these fields separately from exchange-credit status.

## Status semantics

- `confirmed`: the exact official USDT transfer is present in the solidified Mainnet receipt.
- `exchangeCreditStatus: not-verifiable`: no exchange-side account credit has been independently confirmed.
- An on-chain confirmation is not a guarantee of exchange account credit.

## Migration

`server/migrations/20261108_owner_withdrawal_recipient_assurance_stage10c.sql` adds the required columns. It is a manual migration and is not executed by application startup. It has not been run against any production database.

## Safety boundaries

- The owner Mainnet broadcast gate remains hard-disabled.
- No signing, broadcasting, real payout, production database migration, merge, or deployment is performed.
- The 1,000 USDT minimum and existing owner authorization and idempotency checks are preserved.
