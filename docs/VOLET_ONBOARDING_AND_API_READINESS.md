# Volet onboarding and TRX provider readiness

## Current decision

Volet is the selected onboarding candidate, but the requested funding arrangement remains **provider credit** and the requested destinations remain **ordinary TRX wallet payout plus restricted escrow**.

Volet's public Merchant API documentation describes custodial payouts from the merchant's Volet account and requires a verified account and sufficient account balance. Public documentation does not establish a provider credit facility, a TRON payable smart-contract call with attached native TRX, or sponsorship of the escrow contract-call network fee.

Therefore:
- Do not mark Volet as an approved credit provider based on API access.
- Do not enable live payouts, escrow funding, or any broadcast switch.
- Do not treat a prefunded Volet account as credit.
- Keep both destination workflows disabled until the provider explicitly authorizes the exact workflow and credit/fee terms in a binding agreement and the API supports it.
- A Volet ordinary-wallet payout may be evaluated separately only if the owner knowingly changes the funding arrangement to prefunded balance. That is not the current requirement.

## Official Volet documentation

- Merchant API reference: https://volet.com/docs/api/
- Enable Mass Payouts: https://volet.com/docs/guides/mass-payouts/enable-mass-payouts/
- API integration guide: https://volet.com/docs/guides/mass-payouts/integrations/api-integration/
- Verification overview: https://volet.com/docs/guides/overview/verification/
- Personal verification: https://volet.com/docs/guides/get-started/verify-personal/
- Business verification: https://volet.com/docs/guides/get-started/verify-business/
- Supported countries: https://volet.com/docs/guides/overview/supported-countries/
- Mass payouts overview: https://volet.com/docs/guides/mass-payouts/mass-payouts-overview/

## Owner onboarding checklist

1. Open https://volet.com/ and register using an email account controlled by the owner.
2. Confirm the email and sign in.
3. Open the Verification page. Review which Personal or Business account type is available and which documents are requested for the owner's actual country and legal status.
4. Do not misstate residence, citizenship, company status, or business activity. Do not submit another person's identity or company documents.
5. Complete only the verification steps the owner is eligible to complete. Volet says Business API/mass-payout features require company verification; exact KYB requirements depend on company structure, incorporation country, activity, and requested services.
6. After verification, check whether Payment Tools > API is visible. If it is not, do not try to bypass the restriction.
7. Before enabling an API, confirm with Volet whether the account is eligible for TRX external-wallet payouts from the owner's country and whether it offers an actual credit facility. The public payout guide says sufficient account balance is required.
8. Ask Volet to confirm in writing whether it supports native TRX principal and network fees on credit, and whether it supports a TRON TVM TriggerSmartContract call with exact attached call_value to the proposed escrow contract. Public docs do not establish either capability.
9. Only after provider authorization and API compatibility are documented should the owner create a narrowly scoped API credential.

## API configuration (only after account verification and provider approval)

In the Volet dashboard:
1. Go to Payment Tools > API > Create.
2. Give the API a descriptive internal name, such as `TronTransfer-Server`.
3. Add only the production backend's fixed outbound IP address to the IP whitelist. Do not use "Allow all IPs" for production.
4. Create an API password. Store it only in the backend secret manager/environment; never put it in browser code, a VITE_ variable, Git, logs, or chat.
5. Set the public application URL to the actual Tron Transfer service URL.
6. Enable only the permissions required for the approved workflow. For a separately approved ordinary external-wallet payout, the documented permission is "Payouts to external crypto wallets". Read-only balance and transaction lookup permissions may also be needed.
7. Do not enable payout permissions until the account owner has confirmed that the provider terms, destination scope, limits, and funding arrangement match the intended use.

Volet's documented Merchant API authentication uses:
- `Api-Name`: the API name configured in the dashboard.
- `Account-Email`: the account email owning the API.
- `Authentication-Token`: SHA-256 of `password:YYYYMMDD:HH` using UTC date/hour.

The API password is never sent as a request header. The backend must generate the time-based token server-side. Do not share the API password or generated token with support or in this repository.

## Documented API flow and limitations

For custodial payouts, the official guide describes:
1. Read wallet balances.
2. Check payout limits and tariffs.
3. Check exchange rates if conversion is used.
4. Validate the payout request.
5. Create one payout transaction per API request.
6. Persist the provider transaction ID.
7. Poll transaction status and reconcile final states.

Relevant documented endpoints include:
- `GET /api/account/balances`
- `GET /api/account/limits/min`
- `GET /api/account/tariffs`
- `GET /api/transactions/{id}`
- `GET /api/transactions`

The API integration guide requires a verified account, configured API, sufficient Volet account balance, and recipient details. It documents TRX among external crypto payout currencies. It does not document a credit line or a payable TRON contract-call API. Ordinary external-wallet payout support must not be reused as escrow funding.

## Evidence required before implementation can be enabled

Store non-secret evidence in the repository or owner records:
- Official account verification status and account type (do not commit identity documents).
- Written provider confirmation of country eligibility and TRX payout availability.
- Executed credit agreement or facility reference, approved limit, available credit, expiration, fee budget, and permitted destinations.
- Written confirmation whether fees are also credit-funded.
- Provider API documentation for the exact TRON transaction type and signing/broadcast workflow.
- Provider test account and sandbox evidence.
- Explicit authorization for each destination: ordinary wallet payout and/or payable escrow funding.

Do not store passports, identity documents, API passwords, private keys, seed phrases, or raw credentials in GitHub.

## Tron Transfer integration boundary

The current server readiness checks intentionally fail closed. Keep `RESTRICTED_TRX_PROVIDER=compare` until the owner has verified the provider arrangement. Setting `RESTRICTED_TRX_PROVIDER=volet`, adding API credentials, or setting an agreement flag must not independently enable execution. Provider credit and fee availability must be fetched from an authenticated provider endpoint and matched to the executed agreement, allowed destination, amount, and expiry.

No live transfer, escrow funding, or real-funds authorization is enabled by this onboarding document.
