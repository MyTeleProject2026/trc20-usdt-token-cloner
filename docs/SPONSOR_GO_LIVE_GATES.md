# Sponsor integration go-live gates

This checklist is a release gate, not a claim that sponsorship is currently enabled.

## Current verified contract

- The backend sponsorship status is fail-closed.
- The generic sponsor ledger transition API remains fail-closed for caller-supplied authorized/submitted changes. A separate Shasta/Nile-only sponsor-wallet path now persists one unsigned transaction, validates the exact signed bytes against that persisted intent, checks TRON signature permission and current resource capacity, atomically binds the transaction ID before broadcast, and only then marks the row submitted when the selected node accepts that exact ID.
- The testnet signing/broadcast route is disabled by default via `SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED=false`. No Mainnet path is present. The path is not production-ready: resource preflight is not final fee settlement, and accepted broadcast is not proof of solidification or recipient credit.
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
- [ ] Separate fee-resource/fee budget and asset-principal budget with atomic reservation, release on failure, and reconciliation against final chain evidence. The current testnet route checks observed delegation and point-in-time capacity but does not yet settle a distinct fee-resource budget after a confirmed transaction.
- [ ] Database migration and integration tests covering duplicate requests, concurrent reservations, insufficient funds, provider timeouts, failed transactions, chain reorg/finality, and reconciliation drift.
- [ ] Testnet end-to-end tests prove the sender/receiver/token/amount/fee policy from independently verified chain data; no test may depend on UI-only balances. The new transaction path has unit-level adapter/route guards, but no supported live Shasta/Nile end-to-end run is yet recorded.
- [ ] Security review of authorization, signing, API authentication, rate limits, secret handling, audit trails, and emergency pause.
- [ ] Browser CORS is configured with the exact deployed frontend origins; empty/invalid configuration fails closed and never reflects arbitrary browser origins. See [CORS origin policy](./CORS_ORIGIN_POLICY.md).
- [ ] Explicit operator approval for any production launch after all prior gates pass.

## Release rule

Do not enable submission based solely on environment variables, a successful provider API request, a configured address, a displayed balance, or a pending ledger row. Until every applicable gate is evidenced and reviewed, keep sponsored submission disabled and do not fall back to charging user funds.

## Exchange deposits

A solidified on-chain transaction is not proof that an exchange credited a deposit. Exchange credit requires the receiving exchange's own confirmation/status or supported API, correct network and token contract, any required memo/tag, confirmation count, minimum deposit, and account eligibility.
