# Fincra provider authorization and business funding

This checklist concerns the business that owns the Fincra merchant account. It is not an authorization to spend third-party assets and it does not grant Tron Token Studio access to an organization treasury.

- The merchant/business owner must directly complete Fincra's KYB and any relevant compliance onboarding.
- The authorized business representative must obtain explicit enablement for stablecoin USDT TRC20 payouts and confirm applicable countries, beneficiary restrictions, fees, minimums, limits, settlement terms and required IP allowlisting.
- The business must fund the Fincra payout account with sufficient USDT principal or obtain a formal approved credit facility. A gas sponsorship provider or Tatum API key does not provide USDT principal.
- API keys, business identifiers and webhook secrets must be installed in backend-only secret storage by an authorized operator. Do not put credentials in GitHub, frontend variables or chat.
- The merchant must configure payout approvals, limits and business controls within Fincra's own account and document who is allowed to authorize use of its funds.
- The application owner must separately sign each exact payout request. That signature does not override Fincra's account controls or regulatory checks.

No live Fincra authorization or funding status is assumed by this repository. The integration remains disabled until provider approval and the controlled release process are complete.
