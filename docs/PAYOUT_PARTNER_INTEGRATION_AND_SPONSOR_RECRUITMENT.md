# Sponsor recruitment and legitimate payout-partner integration

## Purpose and current boundary

This document defines two independent ways to obtain a real, authorized payout source:

1. **Voluntary self-custody sponsor:** an individual or organization controls its own TRON Mainnet wallet, independently agrees to participate, supplies its own USDT and network resources, and signs each exact payout in its own wallet.
2. **Contracted payout partner:** a legally established payment/treasury operator agrees in writing to provide payout services under a documented commercial and compliance arrangement, using its own authorized custody and signing infrastructure.

Neither route creates USDT. A grant, application, wallet connection, sponsor approval, API key, or successful API response is not proof of available payout funds.

The existing application implements the self-custody sponsor application, owner review, sponsor queue, live sponsor balance/resource checks, exact transaction signing and chain-verification gates. This document does not claim that a third-party payout partner is currently contracted or integrated. No partner API credentials or production partner endpoint are configured by this change.

## 1. Sponsorless withdrawal queue

- Allow an authenticated owner to submit an idempotent request without depositing USDT or TRX.
- Persist the exact requester, recipient, official token contract, amount, request status and timestamps.
- Keep unmatched requests in `requested` / awaiting-sponsor state. Do not allocate an invented balance or label the request funded.
- Show the sponsor as unassigned until an eligible approved sponsor is actually matched.
- Allow cancellation only before a transaction is prepared/broadcast, following the backend's existing state rules.
- Keep request history and reconciliation evidence available to the requester.
- A queued request is a request for service, not a promise of payment, credit, settlement time or exchange-account credit.

## 2. Voluntary sponsor recruitment

The owner dashboard exposes a separate `#/sponsor` portal invitation link. The invitation is intended for a willing wallet owner or a verified organization contact.

Sponsor onboarding sequence:

1. Applicant opens the public sponsor portal and connects their own TronLink wallet on TRON Mainnet.
2. Applicant signs a one-time wallet identity challenge. This message signature proves control of the address only; it does not transfer assets or prove legal identity.
3. Applicant supplies contact details and expressly accepts the displayed voluntary participation terms.
4. Platform owner independently reviews the application and records a review reference and per-payout/daily limits.
5. Sponsor independently refreshes live official USDT, TRX, Energy and Bandwidth readiness.
6. For each request, the backend rechecks sponsor approval, available balance, resources, limits, exact recipient and amount.
7. Sponsor reviews the exact unsigned transaction and explicitly signs it in their own TronLink wallet.
8. Backend validates the signature and transaction intent again before any broadcast; then it verifies the solidified receipt and exact official USDT Transfer event.

Never ask an applicant for a seed phrase, private key, wallet password, OTP, or remote access. Never accept a screenshot or self-reported balance as funding proof. Wallet-message authentication is not KYC, KYB, source-of-funds review, or solvency verification. The owner approval control is an application permission, not a substitute for those checks.

Suggested outreach should state plainly that participation is voluntary, funding is not guaranteed, the sponsor controls their wallet, the sponsor may decline any request, and every transfer requires a fresh exact transaction review and signature. Do not promise returns, reimbursement, guaranteed liquidity, or payment from a grant.

## 3. Contracted payout partner onboarding

A payment processor, OTC desk, treasury provider or other payout operator must not be treated as an ordinary sponsor merely because it offers an API.

Before technical integration, obtain and verify:

- Legal entity name, jurisdiction, registration and authorized signatories.
- Contracted service scope, supported jurisdictions, user eligibility and prohibited use cases.
- KYB/KYC, AML/sanctions screening, source-of-funds and transaction-monitoring responsibilities.
- Written confirmation that the partner can lawfully send official USDT TRC20 to the intended recipient types and that the proposed use is permitted.
- Custody model, beneficial control, wallet ownership/authorization, segregation of customer and operating funds, and insolvency treatment.
- Funding commitment, prefunding/settlement terms, fees, limits, reserves, cut-off times, service levels and failure/refund process.
- Security evidence, independent audit reports, incident response, key-management controls and business continuity.
- A signed API specification and sandbox credentials, followed by a separately approved production agreement and credentials.

A partner must provide authoritative machine-readable evidence for each payout: partner transaction/reference ID, exact sender and recipient, token contract, network, amount, fee, lifecycle state, and a verifiable transaction hash. Webhooks must be authenticated, replay-protected, idempotent and reconciled against independent Mainnet evidence. A partner status such as `accepted` or `processing` is not an on-chain confirmation.

### Required adapter contract (design target; not currently implemented)

A future provider adapter may expose these conceptual operations:

- `capabilities()`: supported network, token contract, jurisdictions, limits and custody model.
- `quote(intent)`: exact recipient, amount, fees, expiry and quote identifier.
- `checkFunding(quote)`: authoritative available prefunded balance or partner commitment.
- `createPayout(quote, idempotencyKey)`: submit only after owner approval and all required partner/user authorization.
- `getPayout(providerReference)`: reconcile asynchronous status and transaction hash.
- `verifyWebhook(headers, rawBody)`: authenticate signed callbacks and reject replay.
- `reconcile(providerReference)`: compare partner evidence with independent TRON Mainnet transaction and receipt data.

These names are an interface proposal, not claims that a provider endpoint exists. Do not code against an assumed URL, undocumented payload, generic API key or guessed webhook signature. Implement a concrete adapter only after the selected partner supplies its official current specification and test credentials.

### Non-negotiable execution controls

- Keep provider credentials server-side in a secret manager; never expose them to the browser or logs.
- Bind authorization to the exact user/request, recipient, token, network, amount, fees and expiry.
- Use idempotency keys and durable state transitions to prevent duplicate payouts.
- Enforce partner limits, live prefunding/credit authorization and risk/compliance checks immediately before submission.
- Use allowlisted partner endpoints and authenticated TLS; reject redirects and untrusted webhook origins.
- Treat timeout/unknown outcomes as reconciliation states, not permission to retry blindly.
- Require independently verified solidified Mainnet transaction and exact USDT Transfer event before marking on-chain confirmed.
- Keep exchange-account credit as a separate status that requires evidence from the receiving exchange or its official partner API.
- Fail closed on missing funding evidence, invalid signatures, expired quotes, mismatched intent, provider outage or ambiguous transaction outcome.

## 4. Grants are not payout liquidity by default

Development grants may fund permitted engineering, security, documentation or ecosystem work. Do not count an application, award letter or development-only disbursement as sponsor funds. Only funds actually received and explicitly authorized in writing for the intended payout activity may be considered, and then only after separate legal/compliance review and independent on-chain verification.

TRON Builders League publishes a staged funding model and limits awarded funds to approved project purposes. Confirm the live official program terms and eligibility directly before applying: https://trondao.org/tron-builders-league

## 5. Release and acceptance checklist

- [ ] Unmatched withdrawal requests remain queued and clearly say no sponsor is assigned.
- [ ] No owner or requester balance is used as sponsor liquidity.
- [ ] Sponsor invitation link opens only the separate sponsor application route.
- [ ] Sponsor identity signature is clearly distinguished from a transaction signature.
- [ ] Sponsor application approval does not imply KYC/KYB, source-of-funds or live funding verification.
- [ ] Every sponsor payout is signed by the sponsor's own wallet for the exact recipient and amount.
- [ ] Partner integration remains unavailable until a real partner, contract, API specification and sandbox are verified.
- [ ] Provider credentials remain server-side and partner webhooks are authenticated/replay-protected.
- [ ] Unknown broadcasts are reconciled before any retry.
- [ ] Solidified Mainnet transaction and official USDT Transfer event are independently verified.
- [ ] Exchange account credit is not inferred from on-chain delivery.
- [ ] CI, code review, deployment preview and funded end-to-end test are complete before production release.

## Current implementation status

The sponsorless request queue and self-custody sponsor portal exist in the application. This update adds an owner-facing sponsor invitation action and this partner integration specification. It does **not** create a sponsor, contract a payout partner, configure a partner API, obtain grant funding, or enable a payout without the existing live funding and signature gates.
