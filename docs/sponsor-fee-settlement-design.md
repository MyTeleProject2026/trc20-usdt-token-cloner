# Sponsor fee observation and settlement design

## Status

Design specification only. This document does not enable transaction submission, budget settlement, Mainnet withdrawals, signing, or broadcasting. The current `sponsor_chain_cost_observations` table remains a successful-asset-transfer observation log; it is not a fee ledger.

## Accounting identities that must remain separate

1. **Asset principal provider** — the wallet that owns and sends the USDT principal.
2. **Transaction owner** — the address in the transaction contract's `owner_address`; this is the transaction submitter.
3. **TRX-burn fee payer** — when the finalized receipt reports a positive TRX fee, the transaction owner is the address charged for that burn. A zero fee means no TRX-burn payer should be recorded.
4. **Contract-creator Energy** — `receipt.origin_energy_usage`; this is the creator/deployer contribution, not proof that a separately configured fee sponsor paid.
5. **Caller Energy and Bandwidth** — receipt usage totals do not identify which delegated account supplied the resources. A current delegation snapshot is not transaction-specific consumption evidence.

The configured `SPONSOR_FEE_*_ADDRESS` is a role setting only. It must never be treated as proof of payment.

## Required fee-only observation record

A future append-only `sponsor_chain_fee_observations` record should be independent of the asset-principal confirmation ledger and contain:

- Explicit testnet network and transaction hash (unique together).
- Stored sponsor-transfer idempotency key, if the transaction originated from a stored sponsor intent.
- Transaction owner address (normalized TRON hex) and, only when reported TRX burn is positive, the same address as TRX-burn payer.
- Finalized block number and execution outcome (`SUCCESS`, `FAILED`, or a normalized failure result).
- Receipt `fee`, `energy_fee`, `net_fee`, `energy_usage_total`, `energy_usage`, `origin_energy_usage`, `net_usage`, and `energy_penalty_total`, each preserved as nullable integer strings.
- Evidence source and observation timestamp.
- A derived accounting classification, never a caller-supplied classification.

Do not persist raw provider payloads, API credentials, private keys, or signing material.

## Observation eligibility

- Accept only transaction identities already stored by the backend; never accept a caller-replacement txid, fee, payer, or status.
- Require the transaction body and receipt to match the same hash on the fixed selected network's solidified node.
- Require a finalized block number and a parseable receipt. Do not discard a finalized failed execution merely because the asset transfer itself failed: its network fee may still be real.
- For a successful asset transfer, independently retain the existing exact-match asset verification. Fee observation must not confirm the principal transfer.
- For a failed execution, record only the fee observation. Leave principal transfer status and principal budget reservation unchanged until the existing principal reconciliation policy resolves them.
- Duplicate identical observations are idempotent. Any conflicting immutable observation for the same network/hash is rejected and sent for review.

## Permitted fee accounting classifications

| Evidence | Classification | Budget action |
|---|---|---|
| Positive finalized `fee`; transaction owner matches the explicitly authorized fee-budget wallet | `trx-burn-payer-verified` | Eligible for a separate network-fee budget debit after approval/scope checks |
| Positive finalized `fee`; transaction owner does not match the authorized fee-budget wallet | `trx-burn-payer-mismatch` | No fee-sponsor debit; review |
| Zero finalized `fee` | `no-trx-burn-observed` | No TRX-burn debit |
| Creator Energy reported | `creator-energy-observed` | No separate fee-sponsor debit |
| Caller Energy/Bandwidth usage with no authoritative per-transaction delegator debit | `delegated-resource-source-unattributed` | No resource-budget debit |
| Provider statement with authoritative transaction-specific resource debit and verified sponsor identity | `provider-resource-debit-verified` | Eligible for separate resource-budget settlement after reconciliation |

The fee payer is not automatically the asset principal provider or the configured fee sponsor. Never infer one from another.

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

## Required tests before implementing settlement

- Successful receipt with positive fee and matching authorized fee-wallet owner.
- Successful receipt with positive fee and a different transaction owner.
- Failed execution with positive fee; principal remains unconfirmed and reserved.
- Zero-fee receipt; no debit.
- Missing or malformed receipt fee; no observation.
- Duplicate identical observation; one record and at most one settlement.
- Conflicting duplicate receipt; rejected.
- Creator Energy does not become fee-sponsor debit.
- Delegated Energy/Bandwidth with no transaction-specific provider debit remains unattributed.
- Wrong network, wrong budget purpose, inactive approval, insufficient budget, and audit-write failure all prevent settlement.
- Concurrent settlement attempts cannot double-debit.

## Release boundary

The first implementation should be testnet-only and observation-only. Fee-budget settlement should remain disabled until the payer evidence and sponsor mandate can be verified end-to-end. Mainnet enablement additionally requires an authorized sponsor organization, production custody/signing policy, funded treasury, operational controls, and independent production validation.
