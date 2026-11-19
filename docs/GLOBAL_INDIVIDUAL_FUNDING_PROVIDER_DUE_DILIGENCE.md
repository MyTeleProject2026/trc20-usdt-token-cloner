# Global individual funding and provider due diligence

**Status:** jurisdiction-neutral baseline; prepared after the applicant clarified that Myanmar is not their current country of residence. The applicant's actual country of legal residence has not yet been confirmed. This document therefore does not claim that any provider is available or unavailable to them on geographic grounds.

## Executive result

No provider has yet been verified as meeting all requirements simultaneously:

- onboarding an individual in the applicant's actual country of legal residence, without assuming a registered company exists;
- supplying its own USDT TRC20 Mainnet liquidity or an expressly approved credit facility in the USD 5,000–10,000 range;
- expressly authorizing this platform's third-party wallet/exchange withdrawals; and
- providing written product, legal-entity, funding and payout authorization.

Do not represent any prospect as approved, funded or available. Public API documentation proves technical capability only; it does not establish country eligibility, an account relationship, credit, liquidity or permission to disburse third-party funds.

## Individual sponsor route

The existing sponsor-direct design remains the most plausible direct route without owner capital:

1. A real individual voluntarily applies using their own TRON Mainnet wallet.
2. The platform conducts manual due diligence and applicable identity, residence, sanctions and source-of-funds checks.
3. The sponsor retains wallet control and signs each exact recipient/amount transaction in TronLink.
4. Live USDT balance and TRON resources are checked; sponsor limits and reservations are applied.
5. The signed transaction is validated before broadcast; the solidified Mainnet receipt and official USDT Transfer event are independently checked.

An application, accepted-for-review status, wallet signature over an identity challenge, or sponsor profile is not proof of a funded mandate. No approved and funded sponsor is verified by this research.

## Provider categories reviewed

### Technical payout rails — not funding sources by themselves

- **Confirmo:** supports USDT on TRON, but payout documentation describes payment from the customer's Confirmo balance. This is a processing rail, not a promise of provider-supplied liquidity. Sources: https://docs.confirmo.net/docs/payouts-overview and https://docs.confirmo.net/docs/programmatic-payouts
- **Orbital:** documents crypto payouts from a merchant/eCommerce account. The merchant must have funds available; API support is not confirmation of country eligibility or credit. Sources: https://docs.getorbital.com/reference/pay-outs and https://docs.getorbital.com/docs/e-commerce-accounts
- **TransFi:** documents prefunded crypto payouts or use of the customer's pay-in balance, depending on configuration. This is not a promise of provider-supplied credit. Source: https://docs.transfi.uk/reference/create-crypto-payout-order
- **Exura Pay:** public materials describe a waitlist/business-oriented product and merchant KYB; it is not verified as an available individual funding source. Source: https://exuraglobal.com/en/pay

### Country-specific restrictions — do not apply these to the applicant without confirming residence

The following published restrictions concern Myanmar specifically. They are retained as reference research only; they do **not** establish that the applicant is resident in Myanmar or that these restrictions apply to the applicant.

- **Mangopay:** its official country restrictions mark Myanmar (MM) as blocked for specified pay-in, user, recipient/bank-account and payout services. https://docs.mangopay.com/guides/users/country-restrictions
- **BitPay:** its supported-jurisdictions article lists Myanmar as unsupported. https://support.bitpay.com/hc/en-us/articles/360000123366-What-countries-or-jurisdictions-does-BitPay-support
- **Tazapay:** its prohibited-country article lists Myanmar among prohibited onboarding jurisdictions. https://support.tazapay.com/which-countries-are-prohibited-from-onboarding-with-tazapay
- **Finoreo:** its published site says it does not onboard companies from Myanmar; this does not establish eligibility for individuals elsewhere. https://finoreo.com/
- **Monvenience:** its published crypto-card page lists Myanmar as restricted and describes individual funding from the user's own USDT/USDC, so it is not a no-deposit funding source. https://www.monvenience.com/crypto-card/

No country restriction above should be generalized to another jurisdiction. Each provider's current official country list and the actual contracting entity must be checked after the applicant confirms legal residence.

## Existing Fincra work in this repository

Draft PRs #126 and #148 describe Fincra payout integration foundations. They are not proof that Fincra will onboard this individual, supply provider-owned liquidity, extend credit or authorize third-party payout use. Verify the exact product, country, contracting entity, account type, funding basis and permitted use directly with Fincra before implementing or enabling a live adapter.

## Best project-development funding lead: TRON Builders League

Official programme: https://trondao.org/tron-builders-league

The published terms state that individuals who are at least the age of majority where they reside may apply; a registered company is not expressly required by that eligibility clause. Funding is discretionary and milestone-based, not guaranteed. The official page advertises a programme pool, not an individual award promise or a guaranteed USD 5,000–10,000 grant. Permitted uses include development/technical improvements, security audits and smart-contract deployment, community growth/marketing, and business expansion within the TRON ecosystem. The terms require compliance with applicable local financial laws.

The terms do not explicitly approve a revolving third-party withdrawal reserve or payout float. Treat development grant funding and operational payout liquidity as separate categories unless TRON confirms the proposed use in writing. The applicant's residence eligibility must also be confirmed against the current programme rules.

## Required evidence before coding or enabling a provider adapter

1. Written confirmation of individual eligibility for the applicant's actual country of legal residence and the exact contracting entity/product.
2. Written approval for this project's activity: third-party USDT TRC20 payouts to external wallet/exchange deposit addresses.
3. Signed agreement defining whether funding is customer-prefunded money, provider-owned liquidity, grant, donation, investment or credit; include repayment, collateral, fees, reserves, recourse, expiry and termination.
4. Provider-originated, timestamped account-specific available balance and holds; aggregate screenshots or user-entered balance fields are not evidence.
5. Confirmation of genuine TRON Mainnet USDT contract support and how Energy, Bandwidth and TRX fees are covered.
6. Official API documentation, authenticated server-side credentials, signed webhook scheme, idempotency, limits, human approval requirements and reconciliation process.
7. Legal/compliance review, sanctions/source-of-funds controls, recipient screening, Travel Rule obligations where applicable, and an operational pause/revocation path.

Only after these are independently verified should a provider-specific adapter be built and reviewed. A generic adapter with caller-supplied balances, booleans or approval references would create a false impression of funding and is not acceptable.

## Release decision

- Keep individual sponsor review, sponsor wallet control, per-transfer signing, live Mainnet balance/resource checks, limits/reservations and solidified-event verification.
- Keep provider execution disabled until a named provider supplies the evidence above.
- Pursue TRON Builders League for permitted development milestones, not as assumed payout liquidity.
- Do not bypass country restrictions, KYC/KYB, sponsor authorization, or source-of-funds controls.
- No sponsor/provider has been contacted and no application has been submitted by this research. No provider credentials have been added and no Mainnet payout has been made.
