# TRON Transfer — Individual Sponsor Brief

**Status date:** 12 November 2026  
**Project repository:** https://github.com/MyTeleProject2026/trc20-usdt-token-cloner  
**Implementation review:** https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/pull/153

## The request

TRON Transfer is seeking one or more **voluntary individual self-custody sponsors** willing to make a capped amount of official TRON Mainnet USDT available for specific, reviewed withdrawals.

The initial recruitment target is **$5,000–$10,000 equivalent in official USDT TRC20 sponsor-controlled capacity**. This is not a request to send $5,000–$10,000 to the project owner or to deposit tokens into a platform wallet. The sponsor keeps control of their own wallet and approves each exact payout separately. A sponsor may start with a much smaller limit or agree to a single low-value pilot.

The project is also open to separate software-development sponsorship or grant support, but those funds are not treated as withdrawal liquidity unless the written award and applicable legal review explicitly permit that use.

## What the project does

The application is designed to separate the withdrawal requester from the sponsor who supplies the asset principal and network resources. Its sponsor-direct workflow is built around:

- an isolated sponsor portal and sponsor-owned TRON Mainnet wallet;
- wallet authentication and separate manual platform-owner approval;
- live checks for official USDT balance and TRON network-fee resources;
- reservation-aware matching and per-payout/daily limits;
- preparation of a transaction bound to the exact recipient, token contract, network and amount;
- explicit signature by the sponsor in their own TronLink wallet;
- backend validation before broadcast; and
- independent verification of the solidified TRON Mainnet receipt and official USDT Transfer event.

The official Tether TRC20 Mainnet contract used by the project is `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`. A token symbol or screenshot is not sufficient proof of token identity or funding.

## How a sponsor participates

1. **Review first.** Read the source repository, [draft PR #153](https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/pull/153), and the [sponsor operating rules](EXTERNAL_SPONSOR_OPERATING_CONTRACT.md).
2. **Confirm eligibility.** The sponsor and project operator must establish the relevant legal identities, actual legal residence/jurisdiction, source of funds and any applicable KYC/KYB, sanctions or licensing obligations. No one should bypass a provider's or jurisdiction's requirements.
3. **Connect the sponsor's own wallet.** The sponsor uses a trusted build of the separate `#/sponsor` portal and connects their own TronLink wallet on TRON Mainnet.
4. **Apply and wait for review.** A wallet identity message proves control of the address only. It is not proof of identity, legal capacity, solvency, source of funds, or agreement to make a payout.
5. **Set limits and refresh live status.** Any approval is subject to current official USDT availability, TRX/Energy/Bandwidth resources, policy limits and the sponsor's own funding decision.
6. **Review each payout.** The sponsor sees the exact recipient and amount and chooses whether to sign that specific transaction in TronLink. There is no implied authority to spend merely because a wallet is connected or an application is accepted.
7. **Verify settlement.** After the signature, the backend revalidates the transfer intent before broadcast. The application must wait for a solidified receipt and exact official USDT Transfer-event evidence before reporting on-chain confirmation.

The sponsor can decline any request. Funds are not transferred to the project owner for safekeeping, and the owner does not receive the sponsor's private keys or seed phrase.

## What the sponsor is being asked to provide

A prospective sponsor may propose any of the following, subject to written review:

- a one-time, low-value Mainnet pilot;
- a capped per-payout amount and daily limit;
- a time-limited pool of sponsor-controlled availability, with a fresh signature required for every payout; or
- a separate network-resource/fee budget, only where the sponsor explicitly authorizes it and the actual TRON fee/resource requirement is independently checked.

Principal and network fees are separate budget categories. A promise to cover Energy or Bandwidth does not fund USDT principal. A platform display, grant application, API key, wallet connection or provider login is not funding evidence.

## Sponsor safeguards

- **Self-custody:** the sponsor's wallet remains under the sponsor's control.
- **Transaction-specific approval:** every payout requires the sponsor's signature over the exact transaction; an identity-message signature is not a transfer authorization.
- **Live checks:** the system must check current official USDT and TRON resources before preparing a payout and revalidate the signed transaction before broadcast.
- **Limits and reservations:** per-payout and daily caps plus reservations are intended to prevent over-allocation and duplicate use.
- **Settlement evidence:** provider acceptance or a broadcast response is not final settlement. Solidified Mainnet receipt and exact token Transfer-event verification are required.
- **No key collection:** the project must never ask for a seed phrase, private key, wallet password, OTP or remote access.
- **No fabricated liquidity:** a sponsor profile, application, grant, unconfirmed provider account or UI balance is not available payout funding.
- **Pause on uncertainty:** insufficient funds/resources, expired authorization, mismatched recipient/amount, unclear legal eligibility or ambiguous transaction outcome must stop the payout and trigger review.

An on-chain transfer does not guarantee that an exchange credits its internal deposit balance. Exchange credit is a separate status that requires confirmation from the receiving exchange or its authorized data source.

## Current implementation status — read before participating

The sponsor-direct implementation is in **open draft PR #153**. The PR has not been merged, and no production deployment or verified public preview is being represented here. The current branch includes the sponsor portal, sponsor application/review workflow, sponsor-side transaction signing path, owner-only partner prospect management, and regression coverage.

The latest head previously checked for this brief was `33e362542344a08e45cb506e2c18e0cc185d8305`; its three associated GitHub Actions workflows completed successfully. That result is code/CI evidence only. It does not establish that a real sponsor exists, that the app is deployed, or that a Mainnet payout works end to end.

**Current real-world blockers:**

- No individual sponsor is confirmed approved and funded.
- No contracted payout provider or provider-owned liquidity/approved credit facility is verified.
- No funded Mainnet end-to-end sponsor payout has been completed.
- The actual legal contracting party and applicant's country of legal residence must be confirmed as part of due diligence; no eligibility conclusion should be inferred from approximate location.
- A public preview still needs review on desktop and mobile before release.

For these reasons, the project is not asking anyone to connect a production wallet or send funds based solely on this document. Prospective sponsors should review the actual deployed build and written terms before participating.

## Proposed delivery milestones

| Milestone | Evidence required before proceeding |
| --- | --- |
| 1. Independent review | Repository/PR review, threat model, sponsor terms, legal and jurisdiction review |
| 2. Testnet rehearsal | Reproducible sponsor application, exact transaction signing, negative tests, idempotency and settlement-reconciliation tests using test assets only |
| 3. Sponsor onboarding | Verified sponsor identity and source of funds where required; written voluntary mandate; live wallet ownership/funding/resource checks |
| 4. Mainnet pilot | A sponsor-approved low-value transfer to a destination independently checked for network, contract, address and any memo/tag requirements |
| 5. Capped expansion | Review pilot evidence and operational controls before considering higher limits; sponsor retains per-transfer approval |

A milestone is not complete merely because a UI control or database record exists. Each milestone requires the evidence listed above.

## Reporting proposed to sponsors

After any real pilot, the project should provide a redacted record showing the sponsor-approved cap, actual principal and network cost, request outcome, TRON transaction ID, solidification evidence and unresolved items. Do not publish personal identity/contact data or sensitive wallet-security information. Do not label a transaction as exchange-credited without exchange-side evidence.

This reporting commitment is proposed for sponsor review; it is not a claim that a funded pilot or public reporting service already exists.

## Terms and limitations

This is a project overview and discussion brief, not a signed sponsor agreement, investment prospectus, guarantee, escrow arrangement, custody agreement, tax opinion or legal opinion. No return, interest, reimbursement, profit share or repayment is promised. The project's operating entity, applicable legal jurisdiction, and required licensing/compliance treatment must be independently established before any binding funding or payout arrangement.

A sponsor should independently review the code, obtain its own legal/compliance advice where appropriate, and never rely on a chat message or an unverified deployment as authorization to transfer funds.

## Public sponsor inquiry

Use the [GitHub sponsor inquiry form](https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/issues/new?template=individual-sponsor-inquiry.yml) to express interest without sending an email. The issue is public and collects only non-sensitive project-interest information. Do not post wallet addresses, identity documents, personal contact details, legal-residence details, source-of-funds material or wallet secrets. Any private due diligence must happen later through an independently verified and appropriate channel.

## Project links

- Repository: https://github.com/MyTeleProject2026/trc20-usdt-token-cloner
- Draft implementation: https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/pull/153
- Sponsor operating rules: https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/blob/ui/modern-crypto-dashboard-theme/docs/EXTERNAL_SPONSOR_OPERATING_CONTRACT.md
- Sponsor recruitment design: https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/blob/ui/modern-crypto-dashboard-theme/docs/PAYOUT_PARTNER_INTEGRATION_AND_SPONSOR_RECRUITMENT.md
