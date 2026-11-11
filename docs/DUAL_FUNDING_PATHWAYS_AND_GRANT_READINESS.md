# Dual funding pathways and grant readiness

## Purpose

Tron Transfer uses two independent funding pathways. They must never be combined into a single assumed balance or described as guaranteed funding:

1. **Development grants:** applications to ecosystem/developer programs for eligible engineering, security, documentation, integrations or community milestones.
2. **Voluntary individual sponsors:** a separate self-custody TRON wallet owner who independently agrees to fund and sign one exact Mainnet USDT payout.

A grant application is not a sponsor. A sponsor approval is not a balance check. A grant award is not payout liquidity until the award has been disbursed, the receiving account and asset are verified, and the written grant terms expressly permit the proposed use.

## Development-grant pathway

The owner dashboard links to these external program entry points:

- TRON Builders League: https://trondao.org/tron-builders-league
- Tether developer resources and grants: https://tether.dev
- Tether WDK documentation: https://wdk.tether.io/

Program terms, application windows, eligibility, geography, award size, KYC/AML requirements, permitted costs and payment methods can change. The platform does not submit applications, represent that an application is approved, or guarantee an award. Confirm current requirements directly with each program before applying.

WDK is wallet-development tooling. It can support self-custodial wallet and signing integration; it is not a grant, USDT faucet, credit facility, sponsor, or access path to Tether treasury assets.

### Suggested application package

Prepare and review the following materials before submitting any application:

- A concise problem statement and target users, without claiming users, revenue or partnerships that do not exist.
- A working product demonstration and repository link, identifying which components are implemented and which remain gated.
- A technical architecture diagram showing the owner identity wallet, separately controlled sponsor wallet, Mainnet preflight, sponsor's explicit transaction signature, Tatum broadcast and solidified transaction verification.
- A security model covering key custody (no imported keys), exact recipient/amount binding, idempotency, replay/duplicate handling, uncertain broadcast reconciliation, audit logs and deployment gates.
- A milestone plan with verifiable deliverables, dates, acceptance tests and a realistic budget.
- A clear statement that development-grant proceeds will be used only for expenses allowed by the grant agreement.

Do not claim a grant is available to finance withdrawals. If a program explicitly permits liquidity or end-user disbursements, obtain written confirmation and legal/compliance review before implementing that use.

## Individual sponsor pathway

The existing sponsor-direct workflow is separate from development grants:

- The platform owner may submit a request using an identity-only wallet; the owner wallet does not need payout USDT or TRX.
- A sponsor applies with a self-custody TRON Mainnet wallet and must be reviewed by the platform owner.
- The sponsor must hold the exact official Mainnet USDT amount and enough Energy/Bandwidth or TRX for network costs.
- The sponsor reviews and signs each exact transfer in its own TronLink wallet.
- The backend checks the signed transaction, sponsor authorization and live funding/resource coverage before broadcast.
- A payout is not confirmed until the solidified Mainnet receipt and exact official USDT Transfer event are verified.
- A confirmed transfer to an exchange deposit address does not establish that the exchange credited an account.

No sponsor identity or funding is presumed. Never request a seed phrase, private key, password or OTP. Do not imply a sponsor is approved or funded until the platform has verified the relevant state.

## Funding status vocabulary

Use these distinct states in UI, reports and application tracking:

| State | Meaning |
| --- | --- |
| `not-submitted` | No application has been submitted. |
| `submitted` | An application was sent; no award is implied. |
| `under-review` | The program has acknowledged review; no award is implied. |
| `approved-not-disbursed` | Written award exists, but funds have not been received. |
| `disbursed-development-only` | Funds were received and are restricted to permitted development expenses. |
| `disbursed-authorized-payout-use` | Funds were received and written terms expressly permit the relevant payout use; separate legal/compliance and custody checks still apply. |
| `declined-or-closed` | The application was declined or closed. |

These are tracking labels, not on-chain proof. Any actual wallet balance must be checked independently against Mainnet.

## Safe deployment acceptance criteria

- The Mainnet route stays disabled for any payout until an approved sponsor is matched, live USDT and network resources are sufficient, the sponsor signs the exact transaction, and verification checks pass.
- A grant status never increases a sponsor balance, owner balance, payout limit or available withdrawal amount.
- Tatum credentials remain server-side.
- No private key, seed phrase, password or OTP is collected or stored by this application.
- No broadcast acceptance is displayed as a confirmed transfer.
- No on-chain transfer is displayed as proof of exchange-account credit.
- If the funding source, transaction state or verification result is uncertain, fail closed and retain the request for reconciliation or manual review.

## Current implementation boundary

The owner dashboard provides external links and explains the two funding paths. It does not yet integrate with grant-provider application APIs or claim live grant status. Sponsor applications, sponsor review, live per-request funding checks, sponsor signatures and Mainnet verification remain separate operational controls. Keep all payouts gated until the required real sponsor funding and authorization exist.
