# Ripple Custody: principal-credit and restricted TRX escrow assessment

**Assessment date:** 2026-11-13  
**Selected diligence provider:** Ripple Custody  
**Required funding model:** actual TRX principal credit (not prefunded custody balance)  
**Destination:** audited TRON escrow contract, with a Bitpie-address-linked read-only view  
**Excluded:** Fireblocks and Volet  
**Live execution:** hard-disabled

## Executive finding

Ripple is a technically relevant custody candidate because its published documentation lists TRON native TRX and TRC-20 support. However, the public material reviewed does **not** publish a TRX principal-credit facility for this application, unsecured credit limits, drawdown terms, repayment tenor, interest/pricing, collateral requirements, credit underwriting, or an entitlement for a private Myanmar-based operator.

Ripple's Gas Station is not a substitute for principal credit. The published Gas Station overview says its current scope is fee funding for non-native-asset transactions on selected ledgers including Tron. A sponsor account holds native tokens and sends native-token funding to sponsored accounts; the sponsor account must itself be funded. This does not prove fee coverage for a native-TRX payable escrow deposit, and it is not a credit facility.

Ripple Wallet documentation separately describes just-in-time fee funding for certain asset-sweep workflows on Tron. That feature is scoped to sweeping and cannot be assumed to sponsor arbitrary escrow deposit calls.

**Decision:** select Ripple for technical/commercial diligence only. Do not represent it as an approved principal-credit provider. No production provider adapter or live escrow submission path is enabled.

## Published evidence

| Requirement | Publicly documented position | Result |
|---|---|---|
| Native TRX on TRON | Ripple Wallet support matrix lists Tron mainnet and native TRX | Supported as a custody asset |
| API integration | Ripple Wallet API guide documents sandbox/production API usage, wallet management, transaction initiation, policies, and webhooks | API exists; account credentials required |
| Principal credit | No public facility terms, limit, drawdown, repayment, pricing, or collateral terms found | Not documented |
| Gas Station | Native-token sponsor account; current scope is fees for non-native-asset transactions on selected chains including Tron | Not evidence of native-TRX escrow-call fee credit |
| Native TRX sweep fee funding | JIT funding is described for native asset sweeps on Tron | Sweep-only workflow; not general escrow sponsorship |
| Payable TRON contract call | General custody documentation discusses smart-contract management, but no public Ripple Wallet API proof of this exact TriggerSmartContract + attached call_value workflow was found | Must be confirmed and tested with Ripple |
| Myanmar eligibility | No public definitive eligibility statement found | Unconfirmed; do not assume available |
| Restricted escrow | Ripple does not publish this application's beneficiary-locked TRX escrow product | Must be implemented as a separately audited TRON contract |

## Official Ripple documentation

- [Ripple Custody (Wallet): supported blockchains and tokens](https://docs.ripple.com/products/wallet/vaults-and-wallets/supported-blockchains-and-tokens)
- [Ripple Custody (Wallet): API getting started](https://docs.ripple.com/products/wallet/get-started/use-the-api)
- [Ripple Custody (Vault): Gas Station overview](https://docs.ripple.com/pt-br/products/custody/accounts-and-assets/gas-station/overview)
- [Ripple Custody (Vault): Gas Station API operations](https://docs.ripple.com/products/custody/accounts-and-assets/gas-station/manage-gas-station-api)
- [Ripple Custody (Vault): Gas Station UI operations and funding](https://docs.ripple.com/products/custody/accounts-and-assets/gas-station/manage-gas-station-ui)
- [Ripple Wallet: asset sweeping and just-in-time fee funding](https://docs.ripple.com/products/wallet/vaults-and-wallets/asset-sweeping)
- [Ripple Wallet: native TRX sweeping release note](https://docs.ripple.com/pt-br/products/wallet/changelogs/eth-trx-xrp-native-sweeping)
- [Ripple Custody overview](https://docs.ripple.com/products/custody/overview/what-is-ripple-custody)

## Accounting and escrow semantics

The principal-credit workflow is not a normal Bitpie transfer. The escrow contract must receive real TRX through a payable TRON TVM contract call. It records a unique request ID, beneficiary Bitpie address, exact SUN amount, provider/source identity, and policy version. The contract enforces the lock/release rules.

The recipient page may show:
- Bitpie address label and allowlisted beneficiary address;
- escrow-held TRX position, verified from solidified contract state;
- locked/releasable status from contract state;
- transaction and contract explorer references;
- separate spendable TRX balance of the Bitpie address, read directly from TRON.

It must never label contract-held TRX as a Bitpie wallet balance or pretend the Bitpie app has received spendable TRX. Only the contract can enforce the restriction.

The database is an index/cache, not the source of truth. Before displaying a position as funded, independently verify on TRON Mainnet:
1. confirmed transaction and solidified receipt;
2. successful TriggerSmartContract call to the pinned escrow contract;
3. exact attached call_value in SUN;
4. expected event/request ID, beneficiary, and amount;
5. contract getter position matches the event;
6. contract TRX balance covers all outstanding locked liabilities.

Ripple's Wallet support documentation says it does not detect native-asset deposits sent to a wallet by a smart contract. The independent chain verifier is therefore mandatory; do not use Ripple's wallet balance as the sole escrow ledger.

## Required written provider confirmations

Do not ask Ripple to approve a vague "TRX payout". The exact commercial/technical scope to be confirmed is:

1. Can Ripple onboard the actual contracting customer and beneficial owner resident/operating in Myanmar? Identify the required legal entity, jurisdiction, KYB/KYC, licensing, and compliance documents.
2. Does Ripple offer an executed **TRX-denominated credit facility** for this customer, rather than custody of customer-prefunded assets? If yes, provide the credit limit, available limit, tenor, drawdown mechanics, interest/fees, collateral, repayment, default, suspension, and permitted-use terms.
3. Does the facility permit TRX principal to be deposited into a customer-specified TRON Mainnet payable escrow contract?
4. Does the credit facility cover the TRON network fee for that same native-TRX TriggerSmartContract transaction? State the fee mechanism, limits, and whether the fee is deducted from credit or paid from a separate funded sponsor account.
5. Does the API support constructing/signing/submitting a TRON TriggerSmartContract with attached call_value, idempotency, transaction lookup, and failure/timeout reconciliation? Provide the exact API operations and testnet procedure.
6. Can the provider restrict the source account to the exact approved escrow contract and enforce per-transaction/daily limits?
7. Confirm whether the service is available in Myanmar and whether this use case is permitted by the provider's terms and applicable law.

A public API page or sales statement is not a credit approval. Record the executed agreement reference and an authenticated account-specific facility response before considering the facility verified.

## Implementation state

The repository's `server/restricted-trx-provider.mjs` comparison now selects Ripple only and explicitly records:
- principal credit: not documented;
- Gas Station scope: non-native-asset transactions;
- native-TRX escrow fee credit: not established;
- payable escrow call support: not verified;
- Myanmar eligibility: not publicly confirmed.

The credit authorization validator requires an authenticated server-to-server Ripple response scoped to TRX on TRON Mainnet, approved credit, an agreement reference, an authorization ID, an unexpired limit, the escrow destination, TriggerSmartContract permission, and credit-funded fees. This validator checks evidence shape and scope; it does not authenticate a response by itself.

The readiness endpoint is diagnostic only. Environment variables, credentials, a selected provider, a dashboard number, or a provider balance snapshot cannot enable execution. The live submission path remains hard-disabled in code until a separate reviewed release process explicitly replaces that gate.

## Release gates

All are required before any production funding:
- Ripple's written Myanmar eligibility confirmation and executed credit agreement;
- authenticated Ripple account and production API documentation for this exact transaction type;
- account-specific available principal credit and separately evidenced credit-funded fee budget;
- provider source-account and contract allowlisting;
- audited escrow contract and pinned Mainnet bytecode/address;
- idempotent request/reservation ledger and ambiguity-safe retries;
- independent solidified TRON receipt, event, getter, and contract-liability verification;
- testnet end-to-end tests, security review, emergency pause, operator limits, and explicit production approval.

Until then: no live payouts, no contract funding, no claimed credit, and no simulated balance.

## Escrow contract risk controls

The escrow contract source now includes immutable `maxPositionSun` and `maxDailyPrincipalSun` constructor limits. They are applied on-chain to each provider-funded position using SUN units and UTC-day accounting. These limits cannot be increased by editing a dashboard setting; changing them requires a new reviewed deployment. The contract also indexes request IDs by beneficiary for read-only discovery. The configured provider remains the only account permitted to fund positions, and only the beneficiary can claim after the lock expires.


## Selected combined funding model and implemented API transport (2026-11-13)

The operator selected the combined arrangement:

- **Principal:** provider-approved TRX credit facility, distinct from provider-owned prefunded liquidity.
- **Fees:** provider-paid network fee budget **plus** delegated TRON Energy/Bandwidth where the provider and network support it.
- **Accounting:** principal credit, provider-paid fee budget, and delegated resource quota are separate ledgers/reservations. Delegated Energy/Bandwidth is not TRX principal and does not transfer the staked TRX underlying those resources.
- **Execution:** all funding and payout execution remains disabled until the provider confirms each permission and the chain verifier proves the resulting state.

### Implemented server-side authentication transport

The repository now contains `server/ripple-wallet-api-client.mjs`. It implements the Ripple Custody (Wallet) documented OAuth 2.0 client-credentials token exchange against `/v2/credentials/oauth/token`, with:

- exact allowlisting of Ripple sandbox and production API origins;
- server-only `RIPPLE_WALLET_CLIENT_ID` and `RIPPLE_WALLET_CLIENT_SECRET`;
- in-memory bearer-token caching and expiry handling;
- HTTPS-only requests to versioned `/v2/` paths;
- bounded request timeout and sanitized network/HTTP errors;
- no automatic replay after a 401 response.

Regression tests are in `tests/ripple-wallet-api-client.test.mjs`.

This is the authenticated transport layer only. It is **not** a Ripple credit-facility endpoint, does not claim that Ripple's public API exposes a TRX credit drawdown, and does not submit transactions. No undocumented Ripple endpoint, request schema, credit facility, fee sponsorship, or transaction type has been invented.

### Remaining provider adapter contract

The next provider-specific adapter layer must be implemented only against Ripple's account-specific API documentation and written commercial authorization. It must return authenticated, provider-sourced evidence for:

1. TRX credit facility identity, agreement reference, limit, currently available principal, expiry, and exact permitted escrow destination;
2. provider-paid fee budget, transaction-type permission, fee cap, and settlement attribution;
3. delegated resource source account, recipient/escrow address, resource type (Energy/Bandwidth), exact quota, expiry, and on-chain delegation evidence;
4. idempotent reservation identifiers and transaction lookup for ambiguous timeouts;
5. exact TRON Mainnet `TriggerSmartContract` support with attached native-TRX `call_value`.

The credit authorization validator now supports the selected combined fee mode only when the provider fee budget is authorized and the delegated Energy/Bandwidth evidence is active, unexpired, independently chain-verified, and addressed to the exact escrow contract. This evidence-shape check does not replace the independent verifier or provider settlement reconciliation. An environment variable or owner-entered value cannot satisfy these requirements.

### Exact Ripple documentation used for the transport

- [Ripple Wallet API getting started](https://docs.ripple.com/products/wallet/get-started/use-the-api)
- [Ripple Wallet API credentials](https://docs.ripple.com/products/wallet/organization-and-access/api-credentials/manage-api-credentials)
- [Ripple Wallet API credential best practices](https://docs.ripple.com/products/wallet/organization-and-access/api-credentials/best-practices)

