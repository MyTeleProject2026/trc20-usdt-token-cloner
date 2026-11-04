# Provider-independent sponsor system

## Purpose

The sponsor ledger and sponsor-wallet pilot must not depend on Fireblocks. A sponsor organization controls its own TRON wallet and authorizes the exact sponsor transaction through its wallet provider. The platform stores public addresses, approved agreement scopes, budgets, reservations, transaction intents, transaction IDs, chain evidence and reconciliation records; it never stores sponsor private keys or seed phrases.

This is separate from the existing owner-only Mainnet treasury payout integration. That route currently uses Fireblocks. Fireblocks configuration is optional while that Mainnet route remains disabled, and this change does not silently replace its signer or enable Mainnet withdrawals.

## Sponsor roles and accounting

Each sponsor program has two separately authorized roles:

1. **Asset-principal sponsor** — supplies the actual TRX or allowlisted TRC-20 principal sent to the recipient.
2. **Network-fee sponsor** — supplies the TRX burn or authorized Energy/Bandwidth resource coverage required by the transfer.

One organization may perform both roles only when its written mandate explicitly covers both. The ledger still separates role, sponsor reference, network, purpose, asset, token contract, budget cap, reservation and settlement. A fee budget cannot be consumed as principal or vice versa.

A sponsor's public address and on-chain balance are diagnostic evidence only. They do not establish ownership, mandate, available unreserved budget, or permission to spend. A sponsor must explicitly approve the exact intent, recipient, asset, amount, fee/resource cap and expiry.

## Provider-independent signing boundary

- The sponsor connects its own wallet (currently TronLink in the Shasta/Nile pilot).
- The backend persists one unsigned transaction intent before returning it for signature.
- The wallet signs the exact persisted transaction; the backend does not receive a private key.
- The backend validates the signed bytes against the stored intent, checks network/signature permission and current sponsor resources, binds one transaction ID atomically, and broadcasts only that transaction to the fixed supported testnet node.
- Ambiguous broadcast outcomes retain the same transaction ID and reservation for reconciliation; the application must not create a replacement transaction to hide uncertainty.
- Node acceptance is not confirmation. Final settlement requires independently verified solidified transaction/receipt/event evidence, receiver balance, and sponsor cost/resource accounting.

The currently implemented wallet-signing/broadcast path is **Shasta/Nile testnet only** and remains behind `SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED=false` by default. It is not a Mainnet signer. A wallet signature is not a sponsor mandate; agreement scope, sponsor ownership and spending authority still require independent review.

## Fireblocks optionality

The production environment preflight now checks Fireblocks credentials, vault metadata, treasury address and payout limits only when either Mainnet treasury payout switch is explicitly true. When both switches are false, these fields report `not-required-disabled` and do not block the independent sponsor-ledger/testnet-wallet workflow.

If an operator later enables the existing Mainnet treasury payout route, its current Fireblocks signer requirements remain mandatory. The testnet TronLink path is not an approved Mainnet replacement. Do not set a Mainnet switch to true merely to make preflight pass.

## What this stage does and does not establish

Implemented in the current codebase:

- sponsor references and separate principal/fee budget purposes;
- reservation/idempotency and immutable audit/reconciliation records;
- read-only sponsor-role balance/resource diagnostics;
- Shasta/Nile sponsor-wallet signing intent and exact signed-transaction validation;
- transaction-ID binding before broadcast and fail-closed handling of ambiguous outcomes;
- conditional Fireblocks preflight so disabled Mainnet payouts do not require Fireblocks credentials.

Not yet complete or independently evidenced:

- an actual sponsor organization's identity, account ownership, signed mandate and funding;
- a full live Shasta/Nile end-to-end run through solidification, recipient balance and sponsor fee/resource settlement;
- transaction-specific attribution and atomic settlement when a *different* wallet supplies delegated Energy/Bandwidth;
- a production-grade Mainnet provider/signer adapter that is independent of Fireblocks;
- independent security review and explicit Mainnet release approval;
- exchange-side deposit-credit verification.

Therefore the global sponsorship status and Mainnet submission gates must remain fail-closed. No dashboard amount may be labelled withdrawable unless it is backed by fresh chain data, approved unreserved sponsor budget and a valid authorization path. A real USDT transfer requires real USDT principal; GasFree or Energy delegation cannot create that principal. Never represent a chain-confirmed transfer as an exchange credit without exchange-side evidence.
