# Sponsor transfer reconciliation — implementation gates

Status: specification only. Sponsor execution must remain disabled until the gates below are implemented and verified.

## Non-negotiable separation

Treat these as distinct ledger operations and balances:

1. **Sponsored network fee** — TRX actually consumed by an eligible transaction.
2. **Sponsor-funded TRX principal** — native TRX intentionally transferred to a recipient.
3. **Sponsor-funded TRC-20 principal** — token units transferred from an explicitly allowlisted token contract.
4. **Observed receiver balance** — read from the exact selected network and asset contract; never derived from a sponsor budget or reservation.
5. **Exchange deposit credit** — confirmed only by the receiving exchange, not inferred from a chain receipt.

Never label a reservation, pending grant, submitted transaction, or sponsor budget as a spendable receiver balance.

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

## Current code-review blocker: purpose-specific evidence

The existing database transition implementation must not be treated as a completed reconciler. Before any sponsor path is enabled, review `transitionSponsorTransfer` against `purpose` explicitly. A `network-fee` reservation is not the same operation as an `asset-grant`: fee sponsorship may delegate Energy/Bandwidth or pay an eligible provider cost without sending the reserved amount as a native TRX principal transfer to the receiver. Confirmation evidence and ledger booking must therefore be purpose-specific.

For `asset-grant`, verify the actual principal transfer and book the asset principal only once. For `network-fee`, verify the supported sponsor/provider operation and its actual fee/resource consumption using provider-specific evidence; do not require or invent a receiver principal transfer, and do not infer the fee from the reservation amount. Until this distinction is implemented and tested, keep all sponsor submission flags disabled.
