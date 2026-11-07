# Stage 8B — Institutional signer adapter (simulation only)

## Scope

This stage adds a provider-neutral, offline adapter contract for reviewing a proposed institutional treasury transfer. It is not a Fireblocks integration and does not create a provider signing request.

Implementation: `server/institutional-signer-adapter.mjs`.

The adapter can:
- validate a bounded TRON Mainnet / official USDT TRC-20 transfer intent;
- normalize the six-decimal amount to base units;
- require opaque references for mandate, funding, custody policy and two distinct reviewer decisions;
- enforce a short-lived request expiry;
- produce a deterministic SHA-256 digest over the normalized intent.

The adapter cannot:
- load API credentials, private keys, or signing material;
- contact Fireblocks or any other provider;
- create a provider transaction or signing request;
- produce a transaction signature;
- broadcast a transaction;
- verify that supplied evidence references are authentic or that funding exists;
- authorize a payout or enable Mainnet execution.

Every accepted result is labelled `simulation-only`. Evidence-reference presence is a schema check only; it is explicitly not represented as independent verification, organizational approval, or proof of spendable funds.

## Existing Fireblocks boundary

The existing `server/fireblocks-client.mjs` includes read-only vault/asset inspection methods and separate Fireblocks transaction-estimate / transaction-creation methods. The latter are capable of submitting a transaction request to a configured Fireblocks workspace; they must not be mistaken for the new simulation adapter.

The treasury USDT and TRX POST routes in `server/routes/treasury-withdrawals.mjs` are protected by the source-level constant `REAL_VALUE_PAYOUT_EXECUTION_DISABLED = true`. Each route returns HTTP 503 before owner authentication, configuration checks, reservations, fee estimation, or calls to `createUsdtTransfer` / `createTrxTransfer`. The flag is not controlled by Render environment variables. Regression tests pin this ordering and disabled state.

Do not remove or make this hard gate configurable as part of Stage 8B. The simulation adapter is intentionally not imported into the live treasury routes.

## Request contract

A future, separately approved integration would need to bind all of the following in a canonical request:
- organization and pre-existing custody-vault reference;
- TRON network and official Tether TRC-20 contract;
- sponsor and recipient addresses;
- exact USDT amount in six-decimal base units;
- short-lived request identifier;
- mandate, funding, custody-policy and independent reviewer evidence references.

Before any provider integration is considered, the organization's authorized adult representatives and independent technical/security reviewers must establish the authenticity and authority of those records outside this simulation adapter. Provider policy approval must remain enforced by the provider's own custody controls.

## Verification

`tests/institutional-signer-adapter.test.mjs` covers amount parsing, asset/network/identity binding, evidence-reference completeness, expiry, digest integrity, explicit non-authorization results, and the absence of provider/network/signing capabilities. It also verifies the production treasury POST routes remain hard-disabled ahead of any provider transaction creation.

## Release boundary

No provider credentials were read, no provider API was contacted, no Fireblocks transaction request was created, no wallet signature was produced, no transaction was broadcast, no Render configuration or deployment was changed, and no funds were moved. This stage does not establish that a sponsor organization, vault, funding balance, or signing authority exists.
