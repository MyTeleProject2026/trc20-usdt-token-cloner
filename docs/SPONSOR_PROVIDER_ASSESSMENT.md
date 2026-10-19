# TRON sponsor provider assessment

**Review date:** 2026-10-19  
**Decision:** Do not connect a paid provider or enable mainnet transfers yet. No provider has agreed to sponsor this project's costs, and no sponsor account or budget has been authorized.

## Findings

### 1. TronEnergy / TronNRG
- Docs: https://support.tronnrg.com/en/
- Published flow: a wallet sends TRX to the provider, then proves ownership by signing a message and claims delegated Energy.
- Published terms in the docs describe a minimum 4 TRX payment for 65,000 Energy and higher amounts for more Energy.
- Assessment: this is a resource-rental route, not a no-cost sponsor. Do not advertise it as free or silently charge users. It would require a deliberate product decision and provider due diligence before integration.

### 2. TronTransfer
- Docs: https://doc.trontransfer.com/
- Published flow: two signed transactions, a TRX fee payment and a USDT transfer; the provider delays transfer broadcast until Energy is delegated.
- The published docs describe mainnet-only support, a real fee paid up front, and 6-decimal USDT amount units.
- Assessment: not a sponsor that pays the fee for this project. It would not be appropriate to wire this into the app as zero-cost sponsorship.

### 3. TronEnergyRent
- Docs: https://tronenergyrent.com/en/overview-api
- Published API offers energy price calculation and rental durations; API key registration is required.
- Assessment: a paid rental option, not evidence of a third party agreeing to fund our transfers. Obtain written pricing, supported network details, terms, limits, refund/error handling, and API credentials from the provider before considering integration.

### 4. Native TRON resource delegation
- Official docs: https://developers.tron.network/docs/delegation
- Official docs: https://developers.tron.network/docs/paying-for-resources
- A project can delegate resources from its own funded/staked account or configure eligible contract-deployer energy sharing for a contract it deploys. Those approaches spend the project's own resources; they do not authorize transfers from a holder's wallet and do not automatically subsidize calls to official Tether's existing contract.

## Decision and safe next steps

1. Keep `GET /api/tron/sponsorship/status` fail-closed until a real sponsor account/provider and budget are verified.
2. Do not store any provider or sponsor secret in the repository or frontend. Put secrets only in a secret manager/Render environment and keep them out of logs/responses.
3. Before integrating a provider, confirm legal terms, pricing, supported network, transaction lifecycle, signature model, idempotency, failure/refund behavior, rate limits, and independent on-chain verification.
4. For an actual sponsor-paid flow, the project owner must explicitly authorize and fund the sponsor account or sign a provider agreement. No provider found in this review promises to pay this project's fees for free.
5. Test the adapter and ledger on a supported testnet when the provider supports one. If a provider only supports mainnet, do not use real funds until an independent security review, spending caps, monitoring, emergency pause, and user consent are in place.
6. Receiver UI must show real token balances and confirmed transfers only from the exact verified contract address. A demo balance must remain clearly marked as simulated and non-spendable.

## Sources

- TRON resource model: https://developers.tron.network/docs/bandwidth-and-energy
- TRON delegation: https://developers.tron.network/docs/delegation
- TronEnergy docs: https://support.tronnrg.com/en/
- TronTransfer docs: https://doc.trontransfer.com/
- TronEnergyRent API overview: https://tronenergyrent.com/en/overview-api
