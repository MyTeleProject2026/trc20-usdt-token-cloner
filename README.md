# TRON Transfer

TRON Transfer is a TRON Mainnet application project for wallet-authenticated workflows and a separately controlled, self-custody sponsor path for official USDT TRC20 payouts.

> **Release status — 12 November 2026:** the main sponsor-direct implementation is being reviewed in [draft PR #153](https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/pull/153). It is not merged or verified as deployed to production. A passing CI run does not prove a funded Mainnet payout.

## Public sponsor information

- **[Read the individual sponsor brief](docs/SPONSOR_BRIEF.md)** — funding target, custody model, milestones, controls and current limitations.
- **[Sponsor operating rules](docs/EXTERNAL_SPONSOR_OPERATING_CONTRACT.md)** — what is required before sponsor funds can be used.
- **[Sponsor recruitment and payout-partner design](docs/PAYOUT_PARTNER_INTEGRATION_AND_SPONSOR_RECRUITMENT.md)** — self-custody sponsor workflow and future provider requirements.
- **[Sponsor/provider due diligence](docs/GLOBAL_INDIVIDUAL_FUNDING_PROVIDER_DUE_DILIGENCE.md)** — why provider APIs and grant awards are not automatically payout liquidity.
- **[Draft implementation PR #153](https://github.com/MyTeleProject2026/trc20-usdt-token-cloner/pull/153)** — code, discussion and current review status.

## What the implementation is designed to do

The individual sponsor path separates the requester from the wallet that supplies the payout:

1. A requester submits a withdrawal request; a zero requester USDT balance does not create funds or bypass sponsor approval.
2. An individual sponsor applies using their own TRON Mainnet wallet. Wallet-message signing proves address control only, not identity, solvency, source of funds or legal eligibility.
3. The platform owner reviews the application and sets limits. Approval does not prove that the wallet is funded.
4. The backend checks fresh official Mainnet USDT and TRON resource availability, reserves sponsor capacity and prepares the exact transfer intent.
5. The sponsor reviews the recipient and amount and signs the specific transaction in their own TronLink wallet.
6. The backend revalidates the signed transaction before broadcast and independently checks the solidified receipt and exact official USDT Transfer event.

The separate sponsor route is `#/sponsor` in the frontend build. Do not connect a wallet to an unfamiliar or untrusted deployment; verify the code and deployment first.

## Funding target and custody boundary

The current recruitment target is **$5,000–$10,000 equivalent in sponsor-controlled official TRON Mainnet USDT capacity**. This is a target for availability under sponsor-defined limits, not a deposit to the developer, a platform treasury, or an owner-controlled wallet. A sponsor may offer a smaller amount or a single-payout pilot.

A sponsor remains the sender and retains custody of their own keys. No private key, seed phrase, wallet password or OTP is needed by this project. A payout is not authorized until the sponsor signs the exact transaction. The project does not claim guaranteed returns, reimbursement, credit, or exchange-account deposit credit.

## Current external dependencies

- No individual sponsor is currently verified as approved and funded.
- No provider has supplied written authorization, a verified funded payout account, or an approved credit facility for this project.
- No real funded Mainnet pilot is claimed.
- No provider payout adapter is enabled for live execution.
- A receiver's on-chain transaction confirmation does not prove that a centralized exchange credited its internal account.

Development grants, software sponsorship and operational payout liquidity are different categories. A development grant must not be counted as withdrawal principal unless the award explicitly permits that use and the funds are received and independently verified.

## Validation and deployment

PR #153 contains the implementation and CI workflows. Review the status shown on the PR for the current head. A successful build or automated test suite is not a substitute for:

- review of the public preview on desktop and mobile;
- sponsor/legal-entity, residence, identity, sanctions and source-of-funds due diligence where applicable;
- a written sponsor mandate and independently verified live funding/resources;
- a low-value sponsor-authorized Mainnet pilot;
- solidified-chain settlement verification; and
- an independent security and operational review before production activation.

No production release or Mainnet payout should be inferred from the presence of code, a sponsor application, a connected wallet, a provider API, or a green CI result.

## Repository

- Owner: [MyTeleProject2026](https://github.com/MyTeleProject2026)
- Project: [trc20-usdt-token-cloner](https://github.com/MyTeleProject2026/trc20-usdt-token-cloner)
- Sponsor portal implementation: [SponsorPortal.jsx](Frontend-Tron-Transfer/src/SponsorPortal.jsx)
