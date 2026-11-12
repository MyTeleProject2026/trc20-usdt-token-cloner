# Provider-funded restricted native TRX escrow (Bitpie-linked view)

## Decision and product truth

The selected recipient presentation is **Bitpie address linked to a restricted escrow position**, and the selected evidence source is the public TRON explorer / solidified TRON chain state.

This is **not** a Bitpie wallet deposit. A normal Bitpie TRX balance is the native TRX balance of the address controlled by that wallet's private key. A third-party sender cannot mark a normal TRX transfer as visible-but-nonwithdrawable. Therefore the UI must say:

- Destination wallet: Bitpie
- Destination address: the allowlisted Bitpie address
- Restricted custody position: amount held by the named escrow contract
- Status: locked / releasable under the published escrow rules
- Verification: explorer link to the contract, funding transaction, and escrow event/state

Never call the escrow position "Bitpie wallet balance", "Bitpie deposit credited", or "received TRX in Bitpie". Do not fabricate a Bitpie notification or transaction record. The Bitpie app itself will show only the address's actual on-chain spendable balance; it may not display contract-held funds.

## Existing repository boundary

The current managed-provider treasury route in `server/routes/treasury-withdrawals.mjs` has a deliberate hard gate:

```js
const REAL_VALUE_PAYOUT_EXECUTION_DISABLED = true
```

Keep this gate in place. Legacy treasury-provider code and readiness checks are not proof that Ripple has agreed to custody restricted TRX, sponsor contract-call fees, or provide credit. No environment variable or UI toggle may override this code-level release gate.

The existing treasury route is a payout workflow, not an escrow ledger. Build the escrow feature as a separate subsystem; do not reinterpret a normal payout row as an escrow balance.

## Proposed architecture

1. **Provider principal adapter** — server-only adapter for a contracted custody/liquidity provider. It must report provider identity, supported TRON network, native-TRX asset identifier, available principal, fee budget, source account, and provider request status. The adapter must distinguish prefunded provider liquidity from a loan/credit facility. Do not infer principal from a dashboard value.
2. **Provider signing / transaction adapter** — provider-authorized signing for the escrow contract's payable deposit method. It must support a contract-call transaction with native TRX attached (`call_value`), or explicitly declare that it cannot fund this escrow design. A plain `TransferContract` to the contract address only increases the contract's TRX account balance and does not execute Solidity `receive()` / `fallback()`; it cannot safely allocate a beneficiary position by itself.
3. **Restricted TRX escrow contract** — holds real TRX and records each position on-chain. A deposit call binds a unique request ID, beneficiary Bitpie address, amount in SUN, provider/source identity, and policy version. Contract emits a deposit event and exposes read-only position getters. Release is possible only through explicit policy (e.g. expiry plus beneficiary claim, or authorized release); the exact policy must be selected and independently audited before deployment.
4. **Escrow ledger** — PostgreSQL mirror of contract positions, provider requests, transaction IDs, event indexes, finality, and reconciliation state. The chain is authoritative; the database is an index/cache and must be repairable from chain events.
5. **Explorer verifier** — verify Mainnet network, contract address, transaction ID, solidified receipt success, contract-call target, attached TRX value, event signature/index, request ID, beneficiary, amount, and current contract position. Re-read solidified contract state and contract account TRX balance before marking funded.
6. **Bitpie-linked recipient view** — read-only display keyed by the allowlisted Bitpie address. Show escrow-held amount separately from the Bitpie address's spendable TRX balance. Include explorer links and explicit "not held in Bitpie; not spendable from Bitpie" disclosure.
7. **Restricted payout / release engine** — executes only the contract's published release rules. The contract, not a database flag or frontend condition, enforces the restriction. Every release requires replay protection, policy checks, and a verified transaction.

## Suggested lifecycle

`draft → provider-preflight → authorized → provider-submitted → chain-confirming → escrow-funded → locked → release-eligible → released`

Exceptional states: `provider-pending`, `submission-unknown`, `chain-failed`, `reconciliation-required`, `cancelled-before-submission`.

A request must be idempotent. A provider timeout is not permission to create a second deposit. Query the original provider request / transaction before retrying. Do not release provider or escrow reservations until the original request is conclusively resolved.

## Funding and fee requirements

- Provider must contractually authorize principal funding and network-fee funding for this exact contract-call workflow.
- Principal and fees are separate budgets and reservations. The amount credited to escrow must equal the requested principal exactly; fees are not silently deducted from it.
- Preflight checks provider-available TRX, source account, contract allowlist, network, per-request limit, daily limit, and outstanding reservations.
- The contract must reject zero amounts, invalid beneficiary, duplicate request IDs, unauthorized depositors (if applicable), and invalid release transitions.
- Do not implement unsecured provider credit as a balance field. Credit availability must come from a real executed provider agreement and authenticated provider API.
- No personal wallet private key, seed phrase, or TRX fallback is permitted.

## Verification rules

Explorer links are evidence navigation, not verification by themselves. The backend must independently query a solidified TRON node/provider and validate the receipt and contract state. A broadcast hash, provider status, pending transaction, or unverified explorer page is not "funded".

For native TRX contract funding, verify:
- transaction is on TRON Mainnet;
- transaction is a successful smart-contract call to the configured escrow contract;
- `call_value` equals the exact expected amount in SUN;
- the expected deposit event contains the exact request ID, beneficiary, and amount;
- the contract's read-only position getter returns the same beneficiary and amount;
- the contract's actual TRX balance covers all outstanding locked liabilities;
- the transaction is solidified before UI status changes to `escrow-funded`.

Also account for direct system transfers to the contract address. Such transfers can increase the contract's native balance without executing contract code or creating a beneficiary position; they must be classified as unallocated surplus, never automatically assigned to a user.

## Data model proposal

- `restricted_trx_escrow_requests`: UUID, idempotency key, owner, beneficiary, network, escrow contract, amount_sun, provider ID, provider request ID, provider state, txid, event index, status, policy version, created/updated timestamps.
- `restricted_trx_escrow_reconciliations`: request ID, observed contract position, observed contract balance, observed locked liabilities, solidified block/hash, verifier version, result, checked_at.
- `restricted_trx_escrow_audit`: append-only actor/action/reason, before/after state, provider reference, txid, and timestamps. Never store signing secrets.

All amounts are integer SUN strings / NUMERIC(78,0), never floating-point TRX. Enforce unique idempotency keys and unique (network, txid, event_index).

## API/UI proposal

- `GET /api/owner/restricted-trx-escrow/readiness` — read-only provider, contract, chain, allowlist, and fee readiness.
- `POST /api/owner/restricted-trx-escrow/requests` — create a request after owner authentication, short-lived authorization, idempotency, and limit checks.
- `GET /api/owner/restricted-trx-escrow/requests/:id` — request/provider/chain state with explorer URLs.
- `GET /api/recipient/restricted-trx-escrow/:address` — public or token-protected read-only positions for the exact allowlisted beneficiary; disclose that this is contract escrow, not a Bitpie wallet deposit.
- `POST /api/owner/restricted-trx-escrow/requests/:id/release` — only after the on-chain release policy and provider authorization are implemented; disabled until audit and release criteria pass.

Do not expose provider credentials, internal custody account identifiers, owner session details, or unredacted provider payloads to recipient endpoints.

## Release gates (all required)

1. A real provider contract and API documentation covering native TRX principal, payable contract calls, fee sponsorship, limits, reversals, settlement, and failure handling.
2. Provider test environment and authenticated test account; verified asset metadata and source address.
3. Audited Solidity escrow contract with documented lock/release rules, reentrancy protection, access control, events, pause mechanism, and tests.
4. Testnet integration with replay, duplicate-submit, timeout, wrong-chain, wrong-contract, fee-exhaustion, and reconciliation tests.
5. Independent review of provider authorization, key management, database concurrency, and contract code.
6. Mainnet deployment address and bytecode verification; contract allowlist and explorer verifier pinned to that deployment.
7. Explicit operator approval after the above evidence is recorded.

Until every gate passes, real-value execution remains disabled. The app may show configuration/readiness and testnet evidence only; it must never manufacture a restricted balance.

## Official TRON technical references

- Accounts and keys: https://developers.tron.network/docs/account
- TRX transfers from smart contracts: https://developers.tron.network/docs/trx-transfer-in-smart-contract
- Smart-contract introduction: https://developers.tron.network/docs/smart-contracts-introduction
- Internal transactions: https://developers.tron.network/docs/internal-transactions
- Transaction lifecycle and solidification: https://developers.tron.network/docs/tron-protocol-transaction
- Sign, broadcast, and verify: https://developers.tron.network/docs/api-signature-and-broadcast-flow


## Provider integration compatibility warning

Do not assume that an institution's support for TRX transfers means it can fund a TRON TVM smart-contract call. The escrow's `fundPosition` method requires a signed TRON `TriggerSmartContract` transaction with native TRX attached as `call_value`. A plain TRX `TransferContract` to the escrow address is rejected by the contract's `receive()` handler and does not create a position.

Do not substitute an EVM-only contract-call API for a TRON TVM transaction. The selected provider must demonstrate a TRON-native `TriggerSmartContract` workflow with the exact attached TRX `call_value`. Fireblocks is excluded from this project integration.

TRON's official developer documentation distinguishes read-only calls from state-changing calls, and documents that writes require a signature and consume Energy. The provider adapter must therefore demonstrate a TRON-native unsigned transaction construction / signing / broadcast or a documented provider-supported equivalent.

References:
- https://developers.tron.network/docs/smart-contract-interaction
- https://developers.tron.network/docs/api-signature-and-broadcast-flow


## Provider comparison and credit adapter implementation

The current selected provider for due diligence is Ripple. Fireblocks and Volet are excluded from this implementation.

| Provider | Native TRX | Payable escrow call | Principal credit | Native-TRX escrow fee credit |
|---|---|---|---|---|
| Ripple Custody | Documented | Not verified for this exact TriggerSmartContract + call_value workflow | Not publicly documented | Not established |

Ripple's public Gas Station documentation describes a funded native-token sponsor account and fee funding for non-native-asset transactions on selected chains including Tron. It does not establish unsecured TRX principal credit or fee coverage for this native-TRX escrow deposit. Ripple Wallet's separate just-in-time fee funding is documented for sweep workflows and must not be generalized to arbitrary contract calls.

Myanmar customer eligibility is not publicly confirmed. Obtain written confirmation from Ripple for the contracting customer's actual jurisdiction and use case. A public API reference, custody account, or Gas Station configuration is not an executed credit facility.

See [RIPPLE_CUSTODY_RESEARCH.md](./RIPPLE_CUSTODY_RESEARCH.md) for published evidence, the exact commercial questions, and release gates.

The backend's Ripple credit authorization validator requires an authenticated server-to-server facility response, TRX on TRON Mainnet, approved credit, an agreement reference, a provider authorization ID, an unexpired credit limit, escrow destination permission, TriggerSmartContract permission, and credit-funded fee coverage. This is an evidence-shape/scope validator, not a provider API client and not proof that Ripple has approved the customer.

**Execution remains disabled.** The repository does not contain a Ripple-specific authenticated API client, provider-issued credit agreement, approved provider account, verified credit-facility response, or proof that Ripple can submit the exact TRON TVM payable escrow call. Comparison/readiness endpoints are informational and cannot move funds. Do not enable production execution from environment flags, credentials, a displayed balance, or a manual agreement checkbox.
