# Sponsor provider selection and integration decision

**Decision date:** 2026-10-24  
**Project:** TRON Token Studio / TRC-20 transfer application

## Product requirement

The requested sponsored-transfer mode must deliver the exact approved asset principal to a receiver and cover network fees without charging the sender's wallet. It must never credit a UI-only balance, use unapproved third-party funds, misrepresent a project token as official USDT, or infer exchange deposit credit from an on-chain transaction.

## Provider research

### GasFree — useful for user-authorized gas abstraction, not full principal sponsorship

Official docs: https://docs.gasfree.io/

The documented flow requires the user's wallet to sign a token-transfer authorization. A service provider submits that authorization and pays the native network gas. The authorization contains maxFee, with activation and transfer fees denominated in the transferred token. The docs list Mainnet and Nile endpoints and describe server-side provider authentication.

**Fit:** Not sufficient for the selected no-user-cost policy. The user still supplies the transferred token principal, and the documented transfer/activation fee is charged in that token. This cannot be presented as a free grant of USDT/TRX principal. A fee-token charged GasFree flow must remain a separately consented product, if ever enabled.

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
