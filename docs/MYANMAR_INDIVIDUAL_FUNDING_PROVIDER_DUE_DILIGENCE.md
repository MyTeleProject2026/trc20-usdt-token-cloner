# Provider and direct-funding due diligence — Myanmar individual (2026-11-12)

## Executive result

No provider has been verified as meeting all of these requirements at once:

- applicant is an individual resident in Myanmar with no registered company;
- provider supplies its own USDT TRC20 Mainnet liquidity or an expressly approved credit facility in the USD 5,000–10,000 range;
- the funds may be used for third-party wallet/exchange withdrawals from this project; and
- provider has confirmed onboarding and product eligibility for this applicant and jurisdiction.

Do not represent any provider prospect as approved, funded, or available. Public API documentation proves technical product capability only; it does not establish country eligibility, an account relationship, a credit line, or authority to disburse third-party funds.

## Individual sponsor route

The existing sponsor-direct design remains the most plausible direct route without owner capital:

1. A real individual voluntarily applies using their own TRON Mainnet wallet.
2. The platform conducts its required manual due diligence and applicable geographic, identity, sanctions and source-of-funds checks.
3. The sponsor retains wallet control and signs each exact recipient/amount transaction in TronLink.
4. Live USDT balance and TRON resources are checked; sponsor limits and reservations are applied.
5. The signed transaction is validated before broadcast; the solidified Mainnet receipt and official USDT Transfer event are independently checked.

An application, accepted-for-due-diligence status, wallet signature over an identity challenge, or sponsor profile is not proof of a funded mandate. No approved and funded sponsor is verified by this research.

## Provider review

### Confirmed geographic blockers

- **Mangopay:** official country restrictions mark Myanmar (MM) as blocked for pay-ins, user creation, recipients/bank accounts and payouts. Do not onboard using altered residency or another person's identity. Source: https://docs.mangopay.com/guides/users/country-restrictions
- **BitPay:** official supported-jurisdictions article lists Myanmar as unsupported. Source: https://support.bitpay.com/hc/en-us/articles/360000123366-What-countries-or-jurisdictions-does-BitPay-support
- **Tazapay:** official prohibited-country article lists Myanmar among prohibited onboarding jurisdictions. Source: https://support.tazapay.com/which-countries-are-prohibited-from-onboarding-with-tazapay
- **Finoreo:** its published site says it does not onboard companies from Myanmar. This is a business product and does not establish eligibility for a Myanmar individual. Source: https://finoreo.com/

### Technically relevant, but not funding sources

- **Confirmo:** its payout documentation supports USDT on TRON, but payouts are sent from the customer's Confirmo balance. Its programmatic payout API requires a source balance. This is a processing rail, not a free liquidity facility. Sources: https://docs.confirmo.net/docs/payouts-overview and https://docs.confirmo.net/docs/programmatic-payouts
- **Orbital:** its payout documentation supports crypto payouts, but describes the source as the merchant's Orbital account/eCommerce account. The merchant must have funds available in the selected account. Jurisdiction and contracting-entity restrictions apply; API support is not a confirmation of legal availability. Sources: https://docs.getorbital.com/reference/pay-outs and https://docs.getorbital.com/docs/e-commerce-accounts
- **TransFi:** its crypto payout API says payouts are prefunded by transferring funds to TransFi or by using the customer's pay-in balance, depending on configuration. This is not a promise of provider-supplied credit. Source: https://docs.transfi.uk/reference/create-crypto-payout-order
- **Exura Pay:** its public page says the product is currently on a waitlist, targets brokers/businesses, and requires merchant KYB. It is not an available individual funding source. Source: https://exuraglobal.com/en/pay
- **Monvenience:** its published individual-account page lists Myanmar as a restricted jurisdiction and says individuals fund the account by transferring their own USDT/USDC. It is neither Myanmar-eligible nor a no-deposit funding source. Source: https://www.monvenience.com/crypto-card/

### Existing Fincra work in this repository

Draft PRs #126 and #148 describe Fincra payout integration foundations. Their own descriptions require Fincra to enable live USDT TRC20 payouts for the exact business account and require a funded account or formal credit facility. They also keep live payout submission disabled. No public evidence reviewed here confirms that Fincra will onboard this Myanmar-based individual, waive business requirements, provide its own liquidity, or authorize this platform's third-party withdrawal use.

Do not enable the Fincra submit path merely because the adapter code or API credentials exist. Obtain written product, country, contracting-entity, use-case, and funding approval first.

## Best grant/sponsor lead: TRON Builders League

Official programme: https://trondao.org/tron-builders-league

Published terms:
- Individuals of legal age where they reside may apply; a registered company is not expressly required by the eligibility clause.
- Funding is discretionary and milestone-based, not guaranteed.
- The headline programme pool is not an individual award promise; no standard USD 5,000–10,000 award is published.
- Approved uses are limited to development/technical improvements, security audits and smart-contract deployment, community growth/marketing, and business expansion within the TRON ecosystem.
- Projects must comply with applicable local financial laws.

The terms do not explicitly approve a revolving third-party withdrawal reserve or payout float. The applicant must ask TRON in writing whether Myanmar residency is eligible and whether the proposed budget/use is permitted. Treat development grant funding and operational payout liquidity as separate categories until written approval says otherwise.

Source: https://trondao.org/tron-builders-league

## Required provider evidence before coding or enabling a provider adapter

1. Written confirmation of Myanmar individual eligibility for the exact contracting entity and product.
2. Written approval for the project activity: third-party USDT TRC20 payouts to external wallet/exchange deposit addresses.
3. Signed agreement defining whether funding is prefunded customer money, provider-owned liquidity, grant, donation, investment, or credit; include repayment, collateral, fees, reserves, recourse, expiry and termination.
4. Provider-originated, timestamped wallet/account-specific available balance and holds; aggregate screenshots or user-entered balance fields are not evidence.
5. Confirmation of genuine TRON Mainnet USDT contract support and how Energy, Bandwidth and TRX fees are covered.
6. Official API documentation, authenticated server-side credentials, signed webhook scheme, idempotency, limits, human approval requirements and reconciliation process.
7. Legal/compliance review, sanctions/source-of-funds controls, recipient screening, Travel Rule obligations where applicable, and an operational pause/revocation path.

Only after these are independently verified should a provider-specific adapter be built and reviewed. A generic adapter with caller-supplied balances, booleans or approval references would create a false impression of funding and is not acceptable.

## Release decision

- Individual sponsor path: retain manual review, sponsor wallet control, per-transfer signing, live Mainnet balance/resource checks, limits/reservations, and solidified event verification.
- Provider path: remain disabled until a named provider provides the evidence above.
- Grant path: pursue TRON Builders League for permitted development milestones; do not count an application or award announcement as payout liquidity.
- No automatic withdrawals, synthetic balance credits, bypass of jurisdiction restrictions, fake KYC/KYB, or production release based on sandbox data.
- No sponsor or provider has been contacted by this research, no application has been submitted, and no Mainnet payout has been made.
