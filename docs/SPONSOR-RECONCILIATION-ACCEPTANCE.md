# Sponsor transfer reconciliation — implementation gates

Status: partial implementation, not production-ready. Reservation/idempotency, exact successful-transfer verification, immutable testnet fee observations, evidence-gated failed-principal reconciliation, and a narrow direct-TRX-burn fee settlement ledger are implemented and CI-tested. The direct settlement can debit only an approved active network-fee budget whose wallet is the same wallet as the transaction owner/asset-principal sender; it does not settle a distinct external delegator's Energy/Bandwidth. The generic ledger transition API still refuses new authorized/submitted changes. A separate Shasta/Nile signed-broadcast route exists but is disabled by default; none of these capabilities establishes production authorization, custody, independent third-party resource settlement, or Mainnet withdrawal readiness.

## Non-negotiable separation

Treat these as distinct ledger operations and balances:

1. **Sponsored network fee** — TRX actually consumed by an eligible transaction.
2. **Sponsor-funded TRX principal** — native TRX intentionally transferred to a recipient.
3. **Sponsor-funded TRC-20 principal** — token units transferred from an explicitly allowlisted token contract.
4. **Observed receiver balance** — read from the exact selected network and asset contract; never derived from a sponsor budget or reservation.
5. **Exchange deposit credit** — confirmed only by the receiving exchange, not inferred from a chain receipt.

Never label a reservation, pending grant, submitted transaction, or sponsor budget as a spendable receiver balance.

## Implemented safeguards and remaining gaps

Current source enforces reservation/idempotency and on-chain reconciliation checks. The generic ledger transition API rejects new authorized/submitted status changes until its wallet-signature and provider-submission contracts are integrated. Separately, the Shasta/Nile wallet-signing/broadcast route is present behind SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED=false by default; it is not a production route and has not been proven by an externally witnessed end-to-end run. The failed-principal reconciler accepts only a stored submitted testnet asset-grant, and only when the immutable fee-observation ledger contains a matching solidified FAILED receipt for the exact network, transaction hash, and idempotency key. It releases the unspent principal reservation and writes the audit event atomically; it explicitly does not settle the network-fee budget. PostgreSQL tests seed a prior submitted row only as a controlled test fixture, not as provider or chain evidence.

Still not complete: signed sponsor mandate and legal/account-ownership verification; production funding verified for both sponsor roles; production custody/signing policy and authorized signer setup; a supported provider-backed production transaction submission contract with replay protection and recovery; transaction-specific proof that a distinct external sponsor supplied delegated Energy/Bandwidth; reliable linkage and settlement of pre-reserved fee holds; and an externally witnessed Shasta/Nile end-to-end transfer through recipient balance verification. The narrow direct-burn settlement is not proof that an external fee sponsor paid. A confirmed chain transfer also does not prove an exchange credited the deposit. CI and dependency-audit success validate code/tests only; they are not evidence of sponsor authorization, funding, custody, or live withdrawal capability. None of these should be inferred from a configured environment variable, a test fixture, or a successful Render start.

## Required transaction state machine

Use an explicit state machine with immutable evidence records:

- `draft -> pending-review -> authorized -> submitted`
- `pending-review -> cancelled`
- `submitted -> confirmed` only after exact transaction evidence is verified and persisted.
- `submitted -> failed` only for a Shasta/Nile asset-grant with an immutable FAILED receipt observation matching the stored network, transaction hash, and idempotency key. The transaction status update, principal-reservation release, and audit event are atomic. Fee evidence is retained, but the separate network-fee budget is not settled by this transition.
- If provider evidence is unavailable, conflicting, or non-final, retain the reservation and mark the outcome inconclusive; never release funds based only on a caller-supplied status.

Reject every transition not explicitly allowed. Require idempotency keys and a unique transaction identity scoped to network, transaction hash, asset contract (where applicable), and event/log index.

## Atomic accounting contract

Within a database transaction and appropriate row locks:

1. Load the sponsor budget and reservation for the exact sponsor, network, asset, and request.
2. Validate authorization, consent, expiry, recipient, amount, contract allowlist, network, and per-transfer/per-day limits.
3. Validate persisted provider evidence; do not accept arbitrary request fields as proof.
4. Reconcile principal and fee as separate units and separate ledger entries. Successful asset principal is booked only after exact transfer verification. For a finalized failed testnet receipt, persist the immutable fee observation and release only the unused principal reservation; do not book principal spend or claim the separate fee budget was settled. TRX fees are denominated in SUN/TRX; token principal uses the allowlisted token's integer base units and verified decimals.
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
- a matching finalized FAILED testnet receipt is immutably observed and releases the principal reservation exactly once;
- pending, missing, contradictory, or non-final evidence leaves reservation intact;
- duplicate request, duplicate webhook, repeated reconciliation, and concurrent workers are idempotent;
- wrong network, wrong contract, wrong sender/recipient, wrong amount, and failed execution are rejected;
- a TRX fee cannot be booked as USDT principal and token decimals cannot be guessed;
- database failure rolls back state, ledger, and audit mutations together;
- a positive direct TRX burn settles exactly once only when the approved network-fee budget wallet matches the transaction owner; mismatched sponsor identity, zero burn, insufficient unreserved capacity, or audit failure must never debit the fee budget;
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

The database transition layer checks `purpose` explicitly and refuses to confirm `network-fee` reservations as receiver principal. The immutable `sponsor_chain_fee_observations` ledger stores finalized SUCCESS/FAILED receipt observations. A matching FAILED observation can authorize atomic release of an asset-grant principal reservation, with an audit record containing `feeBudgetSettled=false`. A separate admin-gated testnet route now settles a positive direct TRX burn only when the approved `network-fee` budget address equals the transaction owner/observed fee payer, the budget is active and approved, and unreserved capacity covers the exact receipt fee. Its immutable settlement row, budget spend, and audit event are atomic and idempotent. PostgreSQL integration tests cover missing/mismatched payer, zero-burn resource usage, insufficient unreserved capacity, concurrent duplicates, and audit-write rollback. A distinct external delegator's Energy/Bandwidth remains unsettled because the current receipt does not identify the resource provider.

This remains a safety barrier, not a completed network-fee reconciler. For `asset-grant`, confirmation requires persisted exact-identity on-chain verification evidence and atomically updates the matching principal budget and audit trail. Failed testnet asset-grants require the immutable matching FAILED fee observation before the principal reservation is released. For `network-fee`, the application still lacks transaction-specific proof that the distinct fee sponsor paid a TRX burn or supplied the delegated resources consumed by that transaction, and it has no separate fee-budget settlement path. Never infer fee payment from a configured sponsor address, a reservation amount, or a current delegation snapshot. Keep production/Mainnet submission disabled until the separate fee path, sponsor mandate, custody, funding, and end-to-end gates are independently verified.
