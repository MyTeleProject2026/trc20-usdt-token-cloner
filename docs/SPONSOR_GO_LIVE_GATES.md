# Sponsor integration go-live gates

This checklist is a release gate, not a claim that sponsorship is currently enabled.

## Current verified contract

- The backend sponsorship status is fail-closed.
- The generic sponsor ledger transition API remains fail-closed for caller-supplied authorized/submitted changes. A separate Shasta/Nile-only sponsor-wallet path now persists one unsigned transaction, validates the exact signed bytes against that persisted intent, checks TRON signature permission and current resource capacity, atomically binds the transaction ID before broadcast, and only then marks the row submitted when the selected node accepts that exact ID.
- The sponsor resource-accounting implementation includes reviewed-scope mandates, row-locked Energy/Bandwidth reservations, transaction-bound broadcast claims, receipt-based settlement, manual-review handling, and a block-bounded Tatum/TRONGrid delegation-history cross-check. The source-code gate in `server/routes/sponsor-fee-settlement-gate.mjs` remains hard-coded closed; the environment flag cannot override it. No Mainnet sponsor submission path is present. The two-provider history check is not cryptographic block-header or transaction-Merkle proof.
- Settlement logic is tested separately from submission. PostgreSQL reconciliation tests seed a prior `submitted` row only as a test fixture, then check exact persisted chain evidence; that fixture is not real provider-broadcast evidence or a live Nile end-to-end test.
- GasFree routes are read-only for capability, account and trace lookup; `POST /api/gasfree/submit` returns HTTP 503 without calling the provider.
- Fee sponsor and asset-principal sponsor are separate roles and are read independently.
- Sponsor account balances and resource snapshots are diagnostics only. They are not an approved budget, an authorization to spend, or a receiver balance.
- Receiver spendability is derived from verified on-chain assets. A normal transfer to an external wallet cannot impose app-defined restrictions after receipt.
- GasFree network support in this integration is Mainnet and Nile. Shasta must not be treated as Nile.
- Tatum KMS is not part of the current web/API runtime. Any future KMS use must be a separately operated sponsor-wallet signer with encrypted persistent storage, managed secrets, mandatory four-eye approval, and a dedicated testnet pilot; see [the Tatum KMS integration audit](./TATUM_KMS_INTEGRATION_AUDIT.md).
- The locked dependency tree now overrides TronWeb's transitive protobuf runtime to `google-protobuf@4.0.3`, and the local transaction encode/decode/sign regression test plus current CI and dependency audit passed. This mitigates the tracked protobuf runtime advisory at the lockfile level; it is not a formal security certification or approval to enable sponsored transfers. See [dependency security triage](./DEPENDENCY_SECURITY_TRIAGE.md) and [issue #49](https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/issues/49).

## Required evidence before any sponsored submission can be considered

- [ ] Written sponsor consent, legal/account ownership confirmation, and an actual funded sponsor account for each role.
- [ ] Provider contract and fee model independently verified against the desired external-sponsor-only policy. Token-denominated fees paid from the transfer amount do not meet a requirement that the receiver receive the full requested amount.
- [ ] Provider-specific signing authorization, transaction allowlists, recipient and token restrictions, maximum amount/fee limits, expiry, replay protection, and idempotency.
- [x] Code-level separate fee-resource budget and asset-principal budget with atomic reservation, expiry/release for never-broadcast intents, receipt-based settlement and manual review are implemented and covered by isolated PostgreSQL tests. This checkbox is implementation-only; it is not proof of a funded sponsor or a live transfer.
- [ ] Production database migration, backup and restore rehearsal, including the new resource tables. Isolated PostgreSQL CI tests cover duplicate/concurrent reservation and settlement paths, but they do not replace a production restore rehearsal.
- [ ] A funded Nile/Shasta end-to-end pilot must prove the sender/receiver/token/amount/fee/resource policy, receiver balance delta and settlement from independently reviewed chain data. No live sponsor-funded transfer is recorded. The current two-provider history cross-check is not cryptographic proof and must not be treated as such.
- [ ] Security review of authorization, signing, API authentication, rate limits, secret handling, audit trails, and emergency pause.
- [ ] Browser CORS is configured with the exact deployed frontend origins; empty/invalid configuration fails closed and never reflects arbitrary browser origins. See [CORS origin policy](./CORS_ORIGIN_POLICY.md).
- [ ] Explicit operator approval for any production launch after all prior gates pass.

## Release rule

Do not enable submission based solely on environment variables, a successful provider API request, a configured address, a displayed balance, or a pending ledger row. Until every applicable gate is evidenced and reviewed, keep sponsored submission disabled and do not fall back to charging user funds.

## Exchange deposits

A solidified on-chain transaction is not proof that an exchange credited a deposit. Exchange credit requires the receiving exchange's own confirmation/status or supported API, correct network and token contract, any required memo/tag, confirmation count, minimum deposit, and account eligibility.

- The Tatum/TRONGrid historical scanner now independently reconstructs the TRON protobuf block-header bytes, verifies the composite block ID from SHA-256(header raw_data), recovers and checks the Super Representative ECDSA signer against `witness_address`, reconstructs each full protobuf transaction from `raw_data_hex`, signatures and supported result fields, and recomputes the java-tron transaction Merkle root against `txTrieRoot`. Unsupported transaction result fields fail closed rather than being silently omitted.
- The scanner now fetches both providers' `/walletsolidity/listwitnesses` snapshots, requires the same 27 active SR addresses, takes the lower `latestBlockNum` for each SR across providers, and recomputes the java-tron 70% solidification threshold. The target block is rejected unless at least 19 active SRs (for the current 27-SR set) have each produced a block at or above the target.
- This DPoS quorum result is reconstructed from provider-reported SolidityNode witness state; the witness state itself is not accompanied by an independently verified state-trie proof. Block signatures and transaction roots are verified locally, but provider state authenticity, canonical-chain selection, network governance parameter review, and independent node/operator validation remain external trust assumptions.
