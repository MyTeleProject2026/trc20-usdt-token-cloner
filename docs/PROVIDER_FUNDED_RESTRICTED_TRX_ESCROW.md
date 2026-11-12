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

## Immutable on-chain funding limits and beneficiary index

The escrow constructor now requires `maxPositionSun` and `maxDailyPrincipalSun` (both in SUN). `fundPosition` rejects a position above the per-position maximum and rejects cumulative provider principal for the current UTC day above the daily maximum. Both limits are immutable for the deployed contract and cannot be raised through the owner dashboard. Changing them requires a new reviewed contract deployment. The contract also indexes request IDs per beneficiary with `getBeneficiaryPositionCount(address)` and `getBeneficiaryPositionRequestId(address,uint256)`, enabling the owner panel to discover positions from solidified contract state before entering the transaction ID for full proof verification.

## Fixed beneficiary binding

The escrow contract now pins `restrictedBeneficiary` as a constructor-supplied immutable address. `fundPosition` rejects every beneficiary other than this exact address. For this deployment plan, set it to the confirmed Bitpie address `TLBWTZHjjRMwbFgKgqmLwjp4ZKjxt5a2GT`. The owner verifier independently reads the immutable `restrictedBeneficiary()` getter and rejects evidence if the configured beneficiary does not match. The constructor therefore requires the provider address, operator address, restricted beneficiary address, minimum and maximum lock duration, maximum position principal (SUN), and maximum UTC daily principal (SUN).

## Alternative Bitpie-visible restricted balance path

Bitpie's official support article describes its multisignature feature and lists TRX among supported assets, although its detailed payment-currency list is inconsistent. It describes a new multisig address, an on-chain 100 TRX creation fee, and warns against 2-of-2/3-of-3 due to key-loss lockout. See [BITPIE_MULTISIG_RESTRICTED_TRX_ROUTE.md](./BITPIE_MULTISIG_RESTRICTED_TRX_ROUTE.md).

This may be a better fit than contract escrow if the current Bitpie app confirms native TRX receive/display for the multisig wallet. A provider can send actual TRX to the resulting multisig address. The real TRX balance appears at that address, while account permission thresholds prevent one key from spending alone. The multisig address may differ from the user's existing ordinary Bitpie address.

Tron Transfer now reads and audits owner/active permission thresholds in the solidified account response. It does not change permissions, create a multisig, or sign. The generated multisig account must be configured by trusted Bitpie participants and verified on-chain. Real TRX principal and network fees remain required; public APIs do not supply them.


## Verified Ripple capability boundary (research update, 2026-11-13)

Ripple's current public documentation confirms TRON Mainnet native TRX support in Ripple Custody (Wallet), including native asset transfers, fee estimation, and TRX sweeping. This establishes technical chain/asset compatibility only. Ripple describes the product as institutional custody infrastructure with customer-controlled organization keys/governance; the public documentation does not promise an unsecured TRX principal grant, a credit line, or fee sponsorship for this private project. No provider account, organization invitation, credit agreement, or API credential is connected in this repository.

Official references:
- Supported chains/assets: https://docs.ripple.com/products/wallet/vaults-and-wallets/supported-blockchains-and-tokens
- Native TRX sweep availability and requirement to contact a Ripple representative: https://docs.ripple.com/products/wallet/changelogs/eth-trx-xrp-native-sweeping
- Ripple Custody Wallet is institutional wallet infrastructure with organization-controlled keys and governance: https://docs.ripple.com/products/wallet
- Ripple Custody balance states (available, frozen, pending) describe funds already held in the customer's wallet; they are not an external credit facility: https://docs.ripple.com/products/wallet/vaults-and-wallets/wallets/understanding-balances

Ripple also documents that native TRX deposits created as internal transfers from smart contracts are not detected in the normal transaction history and may require a balance refresh. The escrow integration must not assume a contract call credits a Ripple wallet's displayed balance; use direct native TRX transfers to a Ripple deposit address if Ripple is the source wallet, and independently verify the chain transaction.

## Bitpie native TRX multisignature compatibility caveat

Bitpie's official article introduction lists TRX among currencies for which multisignature can be enabled, and describes a 100 TRX TRON network creation fee. However, its detailed Supported Currencies list in the enablement steps lists BTC, ETH, BNB and selected USDT token standards but omits native TRX; its worked example is USDT-TRC20. Consequently the article is internally inconsistent. The application must not mark a Bitpie address as a confirmed native-TRX multisig destination until the current Bitpie app visibly offers native TRX for multisig, shows the resulting address, and demonstrates a small native TRX receive and balance display. Do not pay the 100 TRX creation fee or send principal until that is confirmed with Bitpie.

Official article: https://bitpie.zendesk.com/hc/en-001/articles/10142742328591-Bitpie-Multisignature-Usage-Tutorial

## Native TRX provider readiness policy

The server/native-trx-escrow-provider-readiness.mjs module is a separate fail-closed policy for TRX, not a reuse of the older USDT-TRC20 payout readiness policy. It requires authenticated provider API evidence, explicit provider authorization, TRON Mainnet native TRX support, verified provider-owned liquidity or an executed approved credit facility, separate fee coverage, support for the payable escrow contract call, destination/purpose authorization, limits/compliance approval, and live payout approval. A public API balance or a UI/environment flag cannot satisfy these checks. Its regression tests are in tests/native-trx-escrow-provider-readiness.test.mjs.

This policy is a readiness gate, not a Ripple adapter or a live connection. It intentionally remains blocked until real provider credentials, account evidence, and written funding terms exist. It does not create funds or bypass onboarding.


## Bitpie internal-credit integration decision (2026-11-13)

The requested Bitpie-native internal credit is **not available through a documented public Bitpie API** in the official documentation reviewed for this implementation. Bitpie describes its wallet as a self-custody HD wallet: sending and receiving modify the relevant blockchain ledger using the user's private-key signatures, and wallet transaction history is copied from blockchain records. Its FAQ explicitly distinguishes this model from traditional custodial trading platforms and states that Bitpie does not hold user assets as a centralized account balance. Do not infer an undocumented endpoint, reverse-engineer private app APIs, or submit fabricated credit/deposit records.

Official sources:
- https://bitpie.com/en/term/ (sections 2.1–2.4 and 8)
- https://docs.bitpie.com/en/latest/FAQ/index.html
- https://docs.bitpie.com/en/latest/

### Implemented internal ledger (separate from Bitpie and TRON)

Tron Transfer now has a separate owner-authenticated, PostgreSQL-backed internal restricted-credit ledger:
- `GET /api/owner/bitpie-internal-credits?address=<TRON address>`
- `POST /api/owner/bitpie-internal-credits`

Each record is typed `display_only_non_asset` and `restricted_internal_only`, uses integer SUN strings, is idempotent, and is append-only. The owner UI labels the records as Tron Transfer bookkeeping only. The ledger is not sent to Bitpie, does not change the Bitpie app balance, does not change TRON chain state, and has no withdrawal, transfer, redemption, or payout capability. It must never be described as a Bitpie deposit or actual TRX.

The existing on-chain escrow viewer remains a separate section and continues to show only independently verified contract positions and public-chain balances. Neither source is merged into the other.

### Future Bitpie adapter gate

A Bitpie adapter must remain unconfigured and disabled until Bitpie itself publishes or provides an authorized integration contract that specifies the official endpoint, authentication/signature scheme, account/wallet identity model, permission to create restricted credits, balance-display semantics, and reversal/audit rules. No API key, arbitrary URL, third-party proxy, private app endpoint, or environment toggle can substitute for that authorization. Until then, `bitpieApiConnected` is false and the internal ledger is not a Bitpie integration.


### Owner UI configuration

The restricted-credit panel is mounted inside the existing owner-only **Restricted TRX escrow** workspace. It defaults to the previously confirmed Bitpie TRON address `TLBWTZHjjRMwbFgKgqmLwjp4ZKjxt5a2GT`; deployments may override this with the frontend build variable `VITE_RESTRICTED_TRX_BENEFICIARY_ADDRESS`. This only selects the address associated with internal records. It does not establish ownership of that address or connect to Bitpie.

Before deploying, configure the existing owner-authentication and PostgreSQL environment in the backend. The ledger creates its own schema/table/index/immutable trigger on first authorized access. Run the repository test suite and frontend production build against a non-production database first. Do not create production credits until the owner has reviewed the recipient address and understands that the entry is only an internal record.


## Restricted TRC20 alternative — implemented contract source (not deployed)

A separate TRC20-compatible contract is now included at `contracts/RestrictedTRC20.sol` and added to `scripts/compile-contract.mjs`. It is deliberately named **Tron Transfer Restricted Credit (TTRC)**, not TRX:
- fixed 6 decimal places and a constructor-defined hard supply cap;
- owner-issued token units;
- transfers and delegated transfers require both sender and receiver to be allowlisted;
- owner can pause transfers and change the allowlist;
- owner cannot seize or arbitrarily burn a holder's balance;
- standard TRC20-compatible `Transfer`, `Approval`, `balanceOf`, `allowance`, `approve`, `transfer`, and `transferFrom` methods.

**Status:** source and build-artifact generation are committed; contract is not yet compiler-verified in CI, independently audited, deployed to TRON, or imported into Bitpie. A deployed token is not native TRX and must never be represented as TRX. Bitpie may not automatically discover arbitrary TRC20 contracts; recipient visibility requires Bitpie to support custom-token import for that contract/network and the user to add it if the app requires that step. Do not assume this support.

## Native TRX transfers and actual Bitpie balance

A successful TRX transfer to the supplied Bitpie address will increase the address's on-chain TRX balance and should be reflected by a wallet that tracks that address. The recipient controls those native TRX and the sender cannot impose a restriction on their ability to transfer or withdraw. The sender also needs sufficient real TRX for the principal and transaction/network costs. A transfer cannot be made active by code alone without an authorized funded signer.

The existing treasury route's `REAL_VALUE_PAYOUT_EXECUTION_DISABLED = true` hard gate remains in place. Do not remove it merely to show an "active" status. The app must continue to show native TRX payout as disabled until a real owner/provider signer is explicitly authorized, funding and fee balance are verified, destination is confirmed, and testnet + security checks pass.

## Deployment and configuration truth

No backend secret or private key has been added, guessed, generated as if valid, or embedded in source. The restricted token contract can be compiled into a browser artifact; deployment still requires an explicit wallet signature and real TRON network fees. The native transfer also requires an explicit authorized signer and real TRX. The recipient address default is prefilled in the escrow viewer but is not proof of address ownership. These requirements cannot safely be bypassed or completed by fabricating environment variables.
