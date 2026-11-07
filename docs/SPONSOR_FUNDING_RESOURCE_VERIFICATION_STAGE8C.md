# Stage 8C — sponsor funding and TRON resource verification

## Implemented

- `server/sponsor-funding-resource-verifier.mjs` reconciles two separately sourced, read-only observations:
  1. a solidified TRON Mainnet account snapshot containing the official TRC20 USDT contract balance, native TRX balance, and account bandwidth/energy limits and usage;
  2. an authenticated custody-provider vault snapshot containing organization/vault/address binding and available USDT/TRX balances.
- The reconciler binds both observations to the same sponsor address, organization, vault, network and official USDT contract.
- It rejects stale or future-dated observations, non-solidified blocks, malformed amounts, mismatched vault/address/token metadata, sandbox source labels, provider balances exceeding on-chain balances, and insufficient balances, bandwidth or energy.
- Reconciled spendable amounts are the lower of the independently reported chain balance and custody-provider available balance. This prevents a provider ledger from overstating assets visible on-chain.
- The result is readiness evidence only. It never authorizes a payout.

## Trust boundary / not yet provisioned

This commit implements the deterministic verification core and its adapter contract; it does not provision or call a TRON RPC or custody-provider API. Production wiring must supply observations from independently configured read-only clients. Source labels and observation IDs are not cryptographic proof by themselves. The custody reader must authenticate to the provider and bind its response to the configured organization, vault, asset and address; the chain reader must query a trusted TRON Mainnet endpoint and use solidified account/contract/resource data. Those integrations cannot be claimed as operational until configured and independently exercised.

A screenshot, user-entered balance, sandbox ledger, simulated balance, stale response, or opaque evidence reference is not accepted as independent proof. This module does not cryptographically attest provider observations.

## Security boundary

- No private keys, signing methods, provider transaction-creation methods, or broadcast methods are included.
- No provider API was contacted and no external account or configuration was changed.
- The existing treasury USDT/TRX routes retain their hard-coded `REAL_VALUE_PAYOUT_EXECUTION_DISABLED = true` guard.
- No Render changes, production database changes, merge, deployment, transaction signing, Mainnet broadcast, or funds movement occurred.

## Tests

Regression tests cover source and network identity, solidified block metadata, freshness/future timestamps, organization/vault/sponsor/token binding, chain-vs-custody balance reconciliation, sandbox rejection, insufficient USDT/TRX/bandwidth/energy, malformed/missing resource readings, and the absence of execution capabilities.
