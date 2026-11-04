# Sponsor transfer reconciliation — implementation gates

Status: partial implementation, not production-ready. Reservation and evidence-gated settlement logic exist, but sponsor execution must remain disabled until every gate below has been implemented and verified. New ledger transitions to authorized and submitted currently fail closed because wallet-signature verification and provider submission are not integrated.

## Non-negotiable separation

Treat these as distinct ledger operations and balances:

1. **Sponsored network fee** — TRX actually consumed by an eligible transaction.
2. **Sponsor-funded TRX principal** — native TRX intentionally transferred to a recipient.
3. **Sponsor-funded TRC-20 principal** — token units transferred from an explicitly allowlisted token contract.
4. **Observed receiver balance** — read from the exact selected network and asset contract; never derived from a sponsor budget or reservation.
5. **Exchange deposit credit** — confirmed only by the receiving exchange, not inferred from a chain receipt.

Never label a reservation, pending grant, submitted transaction, or sponsor budget as a spendable receiver balance.

## Implemented safeguards and remaining gaps

Current source enforces reservation/idempotency and on-chain reconciliation checks. New authorized status requests are refused until a wallet signature is cryptographically verified against server-reconstructed intent and protected against nonce replay. New submitted status requests are refused until a provider adapter can prove its own accepted broadcast result. A test-only seeded submitted row is used only to exercise settlement rollback and idempotency; it is not provider or chain evidence.

Still not complete: signed legal sponsor consent and account-ownership verification; live two-role sponsor funding verified for the actual operator-controlled wallets; a wallet-side permit flow with durable nonce-use storage; a real provider broadcast adapter and idempotency/retry contract; fee-aware finalized failure reconciliation; and an externally witnessed Nile end-to-end transfer. CI and the dependency audit pass on branch head `0f93dc5691f8df7424fd80b0c2cf28b55042b441`; this is a code-validation result, not evidence of production authorization, funding, custody, or transfer capability. Any previously reported protobuf advisory must be checked against the current full audit report before claiming it is closed. None of these should be inferred from a configured environment variable, a test fixture, or a successful Render start.

## Required transaction state machine

Use an explicit state machine with immutable evidence records:

- `draft -> pending-review -> authorized -> submitted`
- `pending-review -> cancelled`
- `submitted -> confirmed` only after exact transaction evidence is verified and persisted.
- `submitted -> failed` only after a trusted provider establishes terminal failure/finality and the reconciler accounts for any consumed network fee.
- If provider evidence is unavailable, conflicting, or non-final, retain the reservation and mark the outcome inconclusive; never release funds based only on a caller-supplied status.

Reject every transition not explicitly allowed. Require idempotency keys and a unique transaction identity scoped to network, transaction hash, asset contract (where applicable), and event/log index.

## Atomic accounting contract

Within a database transaction and appropriate row locks:

1. Load the sponsor budget and reservation for the exact sponsor, network, asset, and request.
2. Validate authorization, consent, expiry, recipient, amount, contract allowlist, network, and per-transfer/per-day limits.
3. Validate persisted provider evidence; do not accept arbitrary request fields as proof.
4. Reconcile principal and fee as separate units and separate ledger entries. TRX fees are denominated in SUN/TRX; token principal uses the allowlisted token's integer base units and verified decimals.
5. Apply the state transition, ledger entries, reservation adjustments, and audit event atomically.
6. Enforce uniqueness/idempotency so retries cannot debit twice or release a reservation twice.
7. On any error, roll back all accounting mutations. Preserve an inconclusive reservation until evidence permits safe reconciliation.

Do not assume a failed TRON transaction had zero cost. Fee accounting must use verified transaction/receipt data and a reviewed policy for energy/bandwidth, burn, and any provider-specific fee reporting.

## Evidence requirements

A successful transfer verification must bind all of the following to the same intended network:

- canonical transaction hash and solidified/finalized receipt;
- successful execution result;
- exact sender and recipient;
- exact native asset or allowlisted token contract;
- exact integer amount and token decimals;
- matching transaction/event data, including event/log index for TRC-20;
- persisted verification record that the reconciler can retrieve independently.

An indexer candidate, HTTP 200, provider reachability check, submitted hash, wallet screenshot, or local database budget is not sufficient evidence by itself.

## Required automated tests before enabling any sponsor path

- valid confirmed transfer debits principal once;
- valid failed finalized transfer accounts for actual fee and releases only unused reservation;
- pending, missing, contradictory, or non-final evidence leaves reservation intact;
- duplicate request, duplicate webhook, repeated reconciliation, and concurrent workers are idempotent;
- wrong network, wrong contract, wrong sender/recipient, wrong amount, and failed execution are rejected;
- a TRX fee cannot be booked as USDT principal and token decimals cannot be guessed;
- database failure rolls back state, ledger, and audit mutations together;
- unauthorized callers cannot authorize, broadcast, reconcile, or alter sponsor budgets;
- kill switch blocks new sponsor submissions while allowing safe read-only status and reconciliation;
- testnet end-to-end test confirms real wallet signatures/provider broadcast/finality without using mainnet funds.

## Enablement gates

Keep `enabled=false`, `mainnetEnabled=false`, and `canSubmitSponsoredTransfer=false` until all of these are independently evidenced:

- a real provider adapter supports the exact network and operation (read, estimate, sign/broadcast, receipt, and finality capabilities documented separately);
- sponsor consent, signer/custody model, funded balance, fee reserve, and operational ownership are verified;
- server-side authorization, token/network allowlists, limits, rate limits, idempotency, audit trail, and emergency pause are implemented;
- behavioral integration tests and a security review pass;
- a low-value testnet end-to-end run passes; mainnet requires separate explicit operator approval and a reviewed low-value mainnet test.

A provider account or API key alone does not prove funding or transfer capability. No funding or live transaction is authorized by this specification.

## Current code-review result: purpose-specific confirmation remains fail-closed

The database transition layer now checks `purpose` explicitly. It refuses to confirm `network-fee` reservations with `purpose-specific-fee-evidence-and-reconciliation-required`; a fee/resource reservation cannot be settled as receiver principal. It also refuses unsupported purposes and blocks Mainnet confirmation before evidence or budget settlement queries. Regression tests cover these guards.

This is a safety barrier, not a completed fee reconciler. For `asset-grant`, confirmation still requires persisted exact-identity on-chain verification evidence and atomically updates the matching budget and audit trail. For `network-fee`, a provider-specific finalized fee/resource evidence model, fee ledger, and reconciliation path still need implementation. Do not infer actual fee consumption from the reservation amount or invent a receiver principal transfer. Keep all sponsor submission flags disabled until that purpose-specific fee path and the other enablement gates are independently verified.
