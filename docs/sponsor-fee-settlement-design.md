# Sponsor fee observation and settlement design

## Status

The testnet fee-observation layer and a narrow direct-TRX-burn settlement path are implemented; delegated-resource settlement remains design-only. The append-only `sponsor_chain_fee_observations` table records immutable Nile/Shasta receipt evidence, including finalized FAILED executions. The new `sponsor_chain_fee_settlements` table books a positive observed TRX burn only when the approved `network-fee` budget wallet is exactly the transaction owner/observed payer. In this current transfer model that is also the asset-principal sender wallet; it does not settle a distinct external wallet's delegated Energy/Bandwidth contribution. The existing `sponsor_chain_cost_observations` table remains a successful-asset-transfer cost observation log. No Mainnet settlement or withdrawal is enabled.

## Accounting identities that must remain separate

1. **Asset principal provider** — the wallet that owns and sends the USDT principal.
2. **Transaction owner** — the address in the transaction contract's `owner_address`; this is the transaction submitter.
3. **TRX-burn fee payer** — when the finalized receipt reports a positive TRX fee, the transaction owner is the address charged for that burn. A zero fee means no TRX-burn payer should be recorded.
4. **Contract-creator Energy** — `receipt.origin_energy_usage`; this is the creator/deployer contribution, not proof that a separately configured fee sponsor paid.
5. **Caller Energy and Bandwidth** — receipt usage totals do not identify which delegated account supplied the resources. A current delegation snapshot is not transaction-specific consumption evidence.

The configured `SPONSOR_FEE_*_ADDRESS` is a role setting only. It must never be treated as proof of payment.

## Implemented fee-only observation record

The implemented append-only `sponsor_chain_fee_observations` record is independent of the asset-principal confirmation ledger and contains:

- Explicit testnet network and transaction hash (unique together).
- Stored sponsor-transfer idempotency key, if the transaction originated from a stored sponsor intent.
- Transaction owner address (normalized TRON hex) and, only when reported TRX burn is positive, the same address as TRX-burn payer.
- Finalized block number and execution outcome (`SUCCESS` or `FAILED`).
- Receipt `fee`, `energy_fee`, `net_fee`, `energy_usage_total`, `energy_usage`, `origin_energy_usage`, `net_usage`, and `energy_penalty_total`, each preserved as nullable integer strings.
- Evidence source and observation timestamp.
- A derived accounting classification, never a caller-supplied classification.

Do not persist raw provider payloads, API credentials, private keys, or signing material.

## Observation eligibility and current behavior

- The admin-gated POST `/sponsorship/transfers/:idempotencyKey/observe-chain-fees` accepts an empty request body and derives the transaction identity only from the stored transfer; caller-supplied txids, fees, payer addresses, and outcomes are rejected.
- The reader fetches the transaction body and receipt from the fixed selected Shasta/Nile SolidityNode and requires matching transaction identity and solidified block evidence.
- Require a finalized block number and a parseable receipt. Do not discard a finalized failed execution merely because the asset transfer itself failed: its network fee may still be real.
- For a successful TRC-20 transfer, require the exact verified Transfer event in addition to matching stored contract, sender, canonical recipient calldata, and integer amount. Fee observation itself never confirms principal delivery.
- For a finalized FAILED execution, record only the immutable fee observation first. A separate admin-gated `reconcile-failed` endpoint may then mark the matching submitted testnet asset-grant failed and release its principal reservation only when network, stored transaction hash, and idempotency key match the immutable FAILED observation. Reservation release, status update, and audit event are atomic. This does not settle the separate network-fee budget; the audit records `feeBudgetSettled=false`.
- Duplicate identical observations are idempotent under the unique (network, transaction hash) identity. Conflicting observations are rejected. PostgreSQL UPDATE/DELETE is blocked by an immutability trigger.

## Permitted fee accounting classifications

| Evidence | Classification | Budget action |
|---|---|---|
| Positive finalized `fee`; receipt reports a transaction owner | `trx-burn-payer-observed` | Record the observed owner as the TRX-burn payer; do not infer a separate sponsor debit |
| Zero finalized `fee` | `no-trx-cost-observed` | No TRX-burn debit observed |
| Positive delegated/creator Energy or Bandwidth usage without transaction-specific delegator debit evidence | `resource-source-unattributed` | No resource-budget debit; attribution remains unresolved |
| Creator Energy reported without transaction-specific sponsor debit evidence | `resource-source-unattributed` | No separate fee-sponsor debit |
| No fee or resource use reported | `no-trx-cost-observed` | No TRX/resource debit recorded |
| Provider statement with authoritative transaction-specific resource debit and verified sponsor identity | `provider-resource-debit-verified` | Eligible for separate resource-budget settlement after reconciliation |

The fee payer is not automatically the asset principal provider or the configured fee sponsor. Never infer one from another.

## Implemented direct TRX-burn settlement scope

The admin-gated POST `/sponsorship/transfers/:idempotencyKey/settle-observed-fees` accepts an empty body and derives the network, transaction hash, and transfer identity only from the stored asset-grant plus its immutable fee observation. The route is limited to Nile/Shasta and uses the same server-side sponsor administrator token as the observation route.

Settlement succeeds only when all of the following match:

- The stored transfer is a testnet asset-grant in `submitted`, `confirmed`, or `failed` state and the immutable receipt observation matches its network, transaction hash, and idempotency key.
- The observation reports a positive TRX fee and has `transaction_owner_address_hex = trx_fee_payer_address_hex`.
- The observed transaction owner matches the stored asset-principal sender address.
- A distinct `network-fee` / TRX budget exists under the same sponsor reference, its wallet address exactly matches that transaction owner, its approval scope is allowlisted, and the budget is active.
- Unreserved budget capacity (`budget - reserved - spent`) covers the exact receipt `reported_fee_sun`. Existing fee reservations are not consumed or released because the current schema does not bind a specific fee reservation to this asset transaction.

The fee-budget spend, immutable `sponsor_chain_fee_settlements` row, and audit event are committed in one PostgreSQL transaction. Settlement identity is unique by (network, transaction hash) and observation ID; identical retries are idempotent. A failed execution can still settle its observed direct TRX burn. Zero-burn observations do not create a TRX debit.

This is intentionally narrower than third-party resource sponsorship. If the approved fee sponsor wallet differs from the transaction owner, the request is rejected and no fee budget is debited. Aggregate Energy/Bandwidth receipt values and a current delegation snapshot do not identify which separate delegator's resources were consumed. No resource settlement is claimed or implemented.

## Future delegated-resource settlement

A distinct external fee sponsor needs authoritative transaction-specific evidence tying the exact transfer's consumed Energy/Bandwidth to that sponsor and its approved agreement. Until a supported provider supplies that evidence, delegated resource settlement remains disabled.

## Settlement invariants

A future settlement operation must:

1. Run in one database transaction and lock the fee observation and matching budget row.
2. Require a distinct `network-fee` budget, correct network, asset, sponsor address, active approval scope, and sufficient unreserved budget.
3. Settle only the exact verified amount in sun (TRX base units), never estimate Energy usage into a monetary amount without an approved pricing contract.
4. Be idempotent by observation identity and settlement reference.
5. Reject duplicate/conflicting settlements and prevent the same observation from being charged to two budgets.
6. Keep fee-budget accounting separate from USDT principal accounting.
7. Write an immutable audit event in the same transaction; roll back the budget and status if audit persistence fails.
8. Never enable transfer submission as a side effect of observation or settlement.

## Implemented observation/reconciliation tests and remaining settlement tests

- **Implemented:** finalized SUCCESS/FAILED receipt normalization; positive-fee transaction-owner capture; zero-fee/no-payer behavior; malformed or inconsistent fee rejection; conflicting payer rejection; immutable duplicate/idempotency behavior.
- **Implemented:** failed receipt observation does not itself confirm or fail the principal transfer; the independent observation is immutable and separately auditable.
- **Implemented:** matching FAILED receipt enables testnet principal failure reconciliation; missing evidence retains the reservation; concurrent duplicate requests release it only once; audit-write failure rolls back principal release/status while retaining the fee observation; a separate network-fee budget remains unchanged.
- **Implemented:** zero-fee receipt creates no inferred TRX-burn payer and does not settle any fee budget.
- **Still required for fee settlement:** prove the actual fee-budget owner paid the observed burn, or obtain authoritative transaction-specific provider debit evidence for delegated resources.
- **Still required for fee settlement:** active scoped network-fee budget approval, exact TRX amount debit, immutable settlement reference, replay protection, concurrency and audit rollback tests.
- **Still required:** settlement must reject wrong network, wrong sponsor, wrong budget purpose, inactive approval, insufficient unreserved funds, duplicate/conflicting settlement, and any attempt to book TRX fees as USDT principal.
- **Implemented:** creator Energy and unattributed delegated resource usage are classified as `resource-source-unattributed`, never as a verified separate sponsor debit.
- **Still required:** a provider-backed testnet end-to-end run that independently proves the authorized fee sponsor paid or supplied the resources for the exact transfer.
- Mainnet settlement, production custody, and production sponsor authority remain outside this implementation and require independent review.


## Release boundary

The current implementation is testnet-only for fee observation, failed-principal reconciliation, and the narrow direct-TRX-burn settlement described above. A settled row proves only that the receipt's transaction owner/observed burn payer equals the active approved network-fee budget wallet and that the exact positive burn was booked from unreserved capacity. It does not prove that a distinct external sponsor supplied delegated Energy/Bandwidth. Do not interpret `trx-burn-payer-observed` alone as proof that a separate configured fee sponsor paid. Any delegated-resource settlement still requires transaction-specific provider evidence and a separate atomic, idempotent settlement path. Mainnet enablement additionally requires an authorized sponsor organization, production custody/signing policy, funded treasury, operational controls, and independent production validation.
