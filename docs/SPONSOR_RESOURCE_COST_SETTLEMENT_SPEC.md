# Sponsor resource-cost settlement — implementation specification

**Status: runtime groundwork implemented on the draft PR; sponsored submission remains hard-disabled. No transfer or fee budget is enabled by this document.**

## Why this work is required

The existing Shasta/Nile sponsor path separates the asset-principal wallet from the fee/resource sponsor, validates a sponsor-owned wallet signature, checks delegated resource capacity before broadcast, and verifies the eventual transfer from solidified chain state.

The remaining gap is accounting: `observe-chain-costs` records the finalized receipt's `reportedFeeSun`, `energyFeeSun`, `netFeeSun`, `energyUsageTotal`, `energyUsage`, `netUsage`, and `energyPenaltyTotal`, but deliberately returns `sponsorFeeBudgetSettled: false`. A receipt fee observation is not proof that the fee sponsor was debited. When delegated Energy/Bandwidth pays for execution, the transaction's resource consumption is attributable to the delegated resource pool, not necessarily a TRX debit from the delegator.

Do not relabel the current observation as a settled TRX fee.

## Required accounting model

The fee sponsor provides two distinct things that must not be conflated:

1. **TRX fee funding:** TRX actually burned by the transaction owner when resources are insufficient. This is not acceptable under the current external-sponsor-only policy if it causes the asset-principal wallet (or end user) to pay.
2. **Delegated resource capacity:** Energy and Bandwidth made available to the asset-principal account by the fee sponsor's active delegation. A transaction can consume these resources without a corresponding TRX debit from the fee sponsor.

For the current delegated-resource architecture, settle the fee sponsor's ledger in resource units (Energy and Bandwidth) against a separately approved resource allowance. Do not deduct `reportedFeeSun` from a TRX budget and call it sponsor-paid unless independent evidence proves that exact TRX debit was made by the fee sponsor.

## Preconditions before settlement can be implemented

- Persist a versioned fee-sponsor mandate that specifies network, fee sponsor address, asset-principal address, resource types, maximum Energy units, maximum Bandwidth units, validity window, per-transfer ceiling, aggregate ceiling, and stop authority.
- Require the mandate to match the exact active delegation pair and the approved transfer's network and reservation.
- Keep the current no-user-funded-fallback policy. For the selected transfer, require receipt evidence to show no unexpected TRX fee burn from the asset-principal account. If `energy_fee` or `net_fee` is non-zero, do not mark the delegated-resource budget as fully sponsor-covered; classify the outcome for manual review and preserve the principal reservation.
- Use only the stored transaction ID and independently fetched SolidityNode transaction body/receipt. Never accept caller-supplied fee or resource values.
- Validate the exact solidified sender, receiver, asset, token contract, amount, block, execution result, and receipt before any settlement write.
- Reconcile the transaction's receipt-level Energy/Bandwidth consumption against the exact approved delegation scope. The settlement record must retain the raw resource units and the source block/transaction identity.
- Make settlement idempotent on (network, transaction ID, sponsor role, resource type). Conflicting evidence for the same key must fail closed and create an audit event.
- Do not infer the fee sponsor's remaining delegated capacity solely from the recipient's aggregate account-resource counters. Re-read the exact solidified delegation pair and account resources after the transaction; account for concurrent use and recovery windows. If the protocol/provider cannot attribute a reliable post-transaction balance to the exact delegation, record the receipt observation only and leave settlement pending.
- A failed, reverted, expired, ambiguous, or not-yet-solidified transaction must not settle the resource budget or release a reservation based on UI state.

## Proposed persistence contract

Add an append-only `sponsor_resource_cost_settlements` ledger with:

- network, transaction ID, idempotency key, and solidified block number;
- fee sponsor and asset-principal addresses;
- resource type (`ENERGY` or `BANDWIDTH`) and receipt units consumed;
- approved mandate/reference and budget ID;
- evidence source and observation timestamp;
- settlement state (`settled`, `pending-evidence`, `manual-review`, or `conflict`);
- immutable audit metadata.

Use a database transaction and row/advisory locks to ensure the transfer reservation and resource budget cannot be settled twice or exceed their approved ceilings. Never silently overwrite an existing settlement. Preserve raw receipt observations separately from the derived settlement decision.

Do not store a private key, seed phrase, TronLink session secret, provider credential, or admin bearer token in this ledger.

## Acceptance tests required

1. Exact solidified TRX transfer with matching receipt and zero unexpected fee burn settles only the approved delegated resource budget.
2. Exact solidified TRC-20 transfer with matching Transfer event, successful receipt, and zero unexpected fee burn settles only the approved delegated resource budget.
3. Non-zero `energy_fee` or `net_fee` is not reported as fully sponsor-funded; it enters manual review and cannot charge the user or receiver.
4. Missing receipt fields, non-solidified transaction, mismatched block/txid, wrong sender/receiver/token/amount, or unsupported network does not settle.
5. Duplicate reconciliation is idempotent and cannot debit twice.
6. Conflicting receipt evidence for the same transaction is rejected and audited.
7. Concurrent settlements cannot exceed per-transfer or aggregate Energy/Bandwidth ceilings.
8. A pause/revocation of the sponsor mandate blocks new reservations and signing; it does not rewrite historical settlements.
9. Resource recovery/undelegation and concurrent recipient transactions do not cause the system to overstate remaining sponsor capacity.
10. Mainnet and user-funded fallback remain disabled in every test.

## Release gate

This work must remain separate from Mainnet. The existing testnet signing/broadcast flag must not be enabled merely because this ledger exists. A real Nile/Shasta pilot still requires sponsor ownership and written mandate review, two distinct funded sponsor roles, an independently verified delegation, an authorized wallet signature, a real broadcast, solidified transaction/receipt/event evidence, receiver balance re-read, and independently reviewed resource settlement.

## Protocol references

- TRON account resource query and delegated-resource APIs: https://developers.tron.network/reference/account-resources
- GetAccountResource fields and remaining-resource calculation: https://developers.tron.network/reference/getaccountresource
- Stake 2.0 delegation constraints and resource ownership: https://developers.tron.network/docs/delegation
- Bandwidth/Energy metering and resource payment order: https://developers.tron.network/docs/bandwidth-and-energy
- Sign/broadcast and solidified receipt verification: https://developers.tron.network/docs/api-signature-and-broadcast-flow


## Runtime groundwork now present on the draft branch

The branch now includes:
- Separate PostgreSQL resource-mandate budgets, Energy/Bandwidth reservation rows, and append-only receipt resource observations.
- Pending-review mandate creation and activation only when the exact mandate, network, fee sponsor, principal sponsor, resource ceilings, per-transfer limits and expiry are allowlisted in `SPONSOR_APPROVED_RESOURCE_MANDATES`.
- Row-locked reservation against the exact pending Shasta/Nile asset-principal transfer and configured `SPONSOR_FEE_<NETWORK>_ADDRESS`.
- Reservation expiry tied to the prepared transaction expiry. Only never-broadcast pending-review/authorized reservations are released by the expiry sweep.
- Solidified receipt resource observations are recorded as `pending-evidence` or `manual-review`; they do not decrement the budget's spent counters.
- An operator pause operation for a resource mandate.
- PostgreSQL schema initialization now holds a session-level advisory lock for the full migration sequence, serializing startup migrations across app instances and parallel integration-test workers.
- Isolated PostgreSQL CI tests cover settled/duplicate reconciliation, delayed attribution proof, fee-burn and over-reservation manual review, conflicting cost evidence, and concurrent reconciliation without double charging.
- Pilot readiness requires both Energy and Bandwidth delegation above the verifier's 1,000,000 SUN-equivalent minimum, independently verified and persisted delegation transaction records for both resource types from the exact configured fee sponsor to the exact principal sponsor, a valid network-specific USDT test-token allowlist, and a verified positive six-decimal balance of that exact contract at the asset-principal sponsor. A missing, mismatched, unavailable, or truncated delegation audit history blocks readiness.
- The branch must not convert a current delegation snapshot alone into transaction audit proof; the audit verifier requires persisted independently verified ENERGY and BANDWIDTH delegation transactions for the exact configured sponsor pair. Each recorded transaction amount must also be no greater than the corresponding currently active delegated allocation; missing, mismatched, invalid, duplicate, truncated, or stale audit evidence blocks readiness.
- A source-code gate on both signing-intent and signed-submit remains hard-coded closed.

A block-bounded, two-provider history adapter is now implemented on the draft branch. Preflight account/delegation reads are bracketed by a stable SolidityNode head and persist that exact block anchor. Post-transfer reconciliation scans each solidified block from the anchor through the transfer block, compares Tatum and TRONGrid block IDs, parent hashes, timestamps and ordered transaction-ID lists, compares their decoded transaction payloads, verifies each transaction's raw-data hash against its txID, requires the exact transfer in its reported block, and rejects relevant delegation/staking mutations.

This is a dual-provider response cross-check, not a trustless proof: it does not independently verify block-header protobuf hashes, witness signatures or transaction Merkle inclusion against txTrieRoot, and the two managed API services may not be independent at the underlying node/operator level. It cannot yet be treated as Mainnet-grade historical proof. The production release gate must remain closed until cryptographic block/transaction inclusion verification or independently controlled nodes are available, the supported stake-changing contract set is independently reviewed, and the adapter passes a funded testnet pilot.


## Protected operator endpoints

The draft branch exposes the resource mandate ledger through the existing server-only `SPONSOR_ADMIN_API_TOKEN` protection:

- `GET /api/sponsorship/resource-budgets?network=nile|shasta`
- `POST /api/sponsorship/resource-budgets` — creates a pending-review draft using server-configured fee and asset sponsor addresses; caller-supplied addresses are rejected.
- `POST /api/sponsorship/resource-budgets/:id/activate` — requires approval and review references plus the exact allowlisted mandate scope.
- `POST /api/sponsorship/resource-budgets/:id/pause` — pauses future reservations.

Activation scopes bind the mandate reference, network, both sponsor addresses, total Energy/Bandwidth allowances, per-transfer ceilings and exact expiry timestamp. These endpoints manage ledger policy only; they do not prove sponsor funding or on-chain delegation and cannot open the signing/broadcast gate.


The broadcast-claim database transaction now locks the exact resource reservation and mandate after locking the transfer row. This serializes a new broadcast claim against concurrent mandate pause and reservation-expiry cleanup. The signed-submit route also performs a read-only active-reservation check before asking the database to claim the transfer.


## Settlement adapter behavior on the draft branch

The reconciliation path runs a source-only verifier after the exact transfer is solidified. It reads the principal account's current resource-source profile and exact fee-sponsor-to-principal Stake 2.0 delegation without depending on the principal's post-transfer USDT balance or re-simulating the executed contract call. This is a latest-state snapshot, not historical state by itself. The separate history scanner joins it to the persisted, stable preflight block anchor and scans the exact intervening solidified block interval.

A resource budget can move from reserved to settled only when all of these hold:
- The transfer and receipt identities match the stored sponsor transfer and the same solidified block.
- The solidified receipt includes a verified block timestamp.
- The post-transfer delegation/source snapshot exactly matches the snapshot captured at signing and signed-submit preflight.
- A separate server-side historical-delegation proof is verified and bound to the exact network, transaction hash, block number, block timestamp, fee sponsor, and asset-principal address.
- The historical proof has a verified starting-state anchor, complete delegation-change history through the transfer block, no intervening change that breaks the exact resource delegation, and the same resource-specific source snapshot captured at preflight.
- The exact delegation expiry was valid at the transfer block timestamp.
- No reported TRX fee, Energy fee, or Bandwidth fee was burned by the transaction owner.
- For TRC-20 calls, the receipt's caller-paid `energy_usage` and contract-creator-paid `origin_energy_usage` are both retained separately, and their sum must exactly equal `energy_usage_total`. Only caller-paid Energy is charged to the asset-principal sponsor's delegated-resource budget; contract-origin Energy is never attributed to the fee sponsor.
- The historical block scan finds no other transaction initiated by the asset-principal account between the preflight anchor and the payout block, avoiding ambiguous concurrent consumption of the same resource pool.
- Receipt caller-side Energy and Bandwidth usage do not exceed the exact per-transfer reservation.
- A single database transaction atomically releases the full reservation, charges only observed resource units to the approved resource budget, records the settlement evidence, and marks the reservation settled.

If any receipt fee burn is present, the resource use exceeds the reservation, the source snapshot differs, the block interval is incomplete, a relevant stake/delegation mutation is found, or the historical proof conflicts with the transfer receipt, the record remains pending or enters manual review. The scanner is bounded to 256 blocks and relies on the configured SolidityNode's reported block bodies and transaction lists; it does not cryptographically validate witness signatures or txTrieRoot inclusion. Therefore it is a testnet engineering milestone, not independent Mainnet release evidence. No user-funded fallback is introduced.

**Release limitation:** isolated PostgreSQL integration and concurrency tests pass in CI, including the migration-initialization race test path. This does not replace a production database backup, migration and restore rehearsal. The code is still behind the hard source-code signing/broadcast gate and has not been proven against funded Nile/Shasta sponsor accounts or a real sponsored transfer. The branch still requires independent review of the block-time delegation attribution assumptions, a production database migration/restore rehearsal, a controlled on-chain pilot, and explicit sponsor/security approval before anyone changes the gate constant.
