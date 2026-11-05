# Sponsor provider selection and integration decision

**Decision date:** 2026-10-24  
**Project:** TRON Token Studio / TRC-20 transfer application

## Product requirement

The requested sponsored-transfer mode must deliver the exact approved asset principal to a receiver and cover network fees without charging the sender's wallet. It must never credit a UI-only balance, use unapproved third-party funds, misrepresent a project token as official USDT, or infer exchange deposit credit from an on-chain transaction.

## Provider research

### GasFree — useful for user-authorized gas abstraction, not full principal sponsorship

Official docs: https://docs.gasfree.io/

The documented flow uses a wallet-signed token-transfer authorization. A service provider submits that authorization and pays native network gas, while activation and transfer handling fees are denominated in the transferred token. The docs list Mainnet and Nile endpoints and describe server-side provider authentication.

**Fit:** GasFree alone is not an asset-principal grant: some account must first own and fund the token being transferred. A sponsor-controlled GasFree account could be evaluated as one part of a combined design only if that sponsor explicitly funds the full receiver principal plus a separate token-fee allowance, authorizes the exact transfer, and consents to the provider terms. This combined design is not connected or verified in this application; provider fees, eligibility, sponsor account flow, and transaction settlement all require testnet evidence before activation.

### TRONTransfer — published Energy-sponsored flow charges a separate sender fee

Published API docs: https://doc.trontransfer.com/

The documented transfer request includes a separately signed fee transaction and a signed USDT transaction, with a stated TRX fee. Its own receipt endpoint can report transaction/resource usage, but it does not provide free asset principal and its request contract indicates an explicit fee transaction.

**Fit:** Does not meet the requirement that the sender pays nothing. Treat as an unverified third-party service until its legal entity, service terms, security, credentials, network/asset support, and sponsor funding obligations have been reviewed. Do not configure or route production funds to it based solely on public API docs.

### Native TRON Stake 2.0 resource delegation — infrastructure primitive, not a principal grant

Official docs: https://developers.tron.network/docs/delegation and https://developers.tron.network/docs/bandwidth-and-energy

An organization can stake TRX and delegate eligible Bandwidth or Energy to a receiver account. This requires sponsor-controlled stake and a signed delegation transaction, and the available resources change with chain state and consumption.

**Fit:** Potentially appropriate for separately approved fee/resource coverage, provided the platform proves active delegation and verifies actual transaction fees. It does not fund the transfer's USDT/TRX principal, and it is not a public pool anyone can freely spend.

## Selection

No reviewed provider is verified to satisfy both (1) arbitrary asset-principal funding and (2) complete network-fee coverage for this application. Do not claim that a public third-party sponsor exists or enable mainnet submission based on provider availability alone.

Use two independent sponsorship roles:

1. **Asset-principal sponsor organization:** legal/operational identity approved by an operator; explicit program mandate and per-transfer authorization; funded, network-specific asset treasury; allowlisted assets, destinations, limits, expiry and reconciliation.
2. **Network-fee sponsor/provider:** explicit consent and independently verified on-chain funds or active, sufficient resource delegation; separate fee cap and budget; transaction-specific coverage evidence.

A single organization can perform both roles only if its mandate, budgets, accounting, signing controls and authorization explicitly cover both roles; the ledger and checks should still keep principal and fees distinct.

## Receiver/exchange handling

- Validate the exact network, asset identifier and allowlisted token contract. A token symbol such as USDT is not proof of token identity.
- Require the exchange's correct deposit network, address, minimum amount and any required memo/tag from an authoritative exchange source before submission.
- After sending, verify the transaction against solidified chain state, including successful execution and the exact token Transfer event/contract for TRC-20.
- Report exchange-credit-unverified until the exchange's own authenticated status source confirms credit. Never simulate exchange credit.
- A project token such as VTRC must be labelled as a separate project token, not official Tether USDT.

## Required before production activation

- Signed sponsor agreement/mandate and proof of funding for each role.
- Concrete provider/API contract and supported network/asset scope.
- Server-side secrets set in the deployment secret manager, never in browser code or repository files.
- Provider adapter with strict schema validation, rate/timeout handling, request idempotency and ambiguous-submit reconciliation.
- Sponsor-controlled secure signer/MPC/HSM or provider's audited authorization mechanism; no private keys in this application database or logs.
- Atomically reserved principal and fee ledgers, per-transfer limits, operator approval, emergency pause and auditable state transitions.
- Real Nile end-to-end transfer tests, independent solidified-chain verification, duplicate/replay tests and settlement reconciliation.
- Independent security review and explicit mainnet operator approval.
- An exchange integration if the product promises exchange deposit-credit status.

Until these items are evidenced, runtime status must remain enabled: false, canSubmitSponsoredTransfer: false, submissionEnabled: false, and user-funded fallback must remain prohibited.


## Fincra/Tatum implementation path (2026-11)

The repository now uses Fincra as the provider-managed payout rail for an authorized, funded Fincra business account and Tatum as the TRON Mainnet RPC/recipient-verification layer. Fincra documents `usdt_trc20` as a stablecoin payout scheme; this is a provider payout capability, not a public or free asset sponsor. A live business account must be approved and enabled for stablecoin payouts by Fincra. Available USDT must exist in the configured account before the API is called.

The no-per-withdrawal-prompt mode is a **standing authorization**, not an authorization bypass. A sponsor signs the exact Fincra business ID, agreement digest, Mainnet USDT purpose, limits, and validity. The platform independently reviews that evidence; the server matches the mandate's business ID to the configured account; the requester is allowlisted; and the backend enforces the per-payout and daily limits. A sponsor signature per payout is not required only inside that pre-authorized provider scope. Keep automatic mode off until the real business account and sponsor arrangement are operationally verified.

Official provider documentation: https://docs.fincra.com/reference/initiate-payout-2


### Fincra stablecoin payout API versus restricted MCY account product

Fincra's current stablecoin payout reference explicitly lists `USDT` with `usdt_trc20`, requires a Fincra business ID and funded source wallet, and says live stablecoin payouts must be enabled for the business. A successful API response means the request was accepted for processing, not that the payout settled. The integration must continue status/webhook reconciliation. References:
- https://docs.fincra.com/reference/initiate-payout-2
- https://docs.fincra.com/reference/get-balances
- https://docs.fincra.com/di/reference/fetch-payout-by-customer-reference

Fincra's separate prohibited-countries page explicitly labels its geographic restriction as applying to the **Multicurrency (MCY) Account Product**, and lists Myanmar. Do not assume that page alone conclusively prohibits or permits the distinct stablecoin payout API. Fincra must confirm in writing whether the exact legal entity, beneficial owner/residency, source-of-funds arrangement, crypto-wallet payout use case and any platform/aggregator model are eligible. The same page also lists crypto-exchange/nesting business activity among prohibited MCY activities; get product-specific clarification rather than trying to route around it. Reference: https://docs.fincra.com/docs/fcy-prohibited-activities-and-countries

No false address, nominee, borrowed business ID, or another organization's account may be used to bypass eligibility. Do not configure production credentials or enable live payouts until Fincra confirms eligibility and enables live USDT TRC20 payouts for the actual sponsor business.
