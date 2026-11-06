# Fincra provider adapter status (2026-11-06)

## Scope of this change

This branch adds a Fincra-first adapter foundation for the private owner-only Tron Transfer application while retaining Tatum for TRON Mainnet reads and later chain verification.

Implemented in this branch:

- Server-only Fincra environment parsing with sandbox as the default.
- Strict builder for same-currency USDT to a TRON crypto wallet using \`paymentDestination=crypto_wallet\` and \`paymentScheme=usdt_trc20\`.
- Six-decimal USDT base-unit parsing, bounded numeric amount conversion, Mainnet TRON Base58Check address validation, and unique customer-reference validation.
- Read-only diagnostics against the authenticated Fincra business profile and its business wallet list.
- Payout-record normalization that requires exact business payout identity (customer reference, currencies, scheme, destination and recipient). A successful result is accepted by the helper only when the beneficiary's net received amount exactly matches the requested amount; mismatches go to manual review.
- HMAC-SHA512 webhook-signature verification helper.
- Sandbox-only payout initiation and customer-reference lookup helpers. The sandbox initiation helper refuses live mode and requires the explicit \`FINCRA_SANDBOX_PAYOUTS_ENABLED=true\` flag.
- Owner-only provider-readiness page now displays the Fincra API/profile and sponsor-account balance diagnostics without enabling submission.

## What this does not enable

- Production Fincra payout submission remains disabled.
- The existing legacy \`/sponsor-requests/:id/fincra-payout\`, \`/sponsor-requests/:id/fincra-status\`, and \`/fincra/webhook\` endpoints remain disabled. The new helper is not a route that can send funds in production.
- The readiness API does not claim Fincra has donated USDT or granted credit. A positive available balance belongs to the configured Fincra business account and must be attributable to the sponsor under a lawful, documented arrangement.
- An API key and matching business ID do not prove the operator is legally authorized to use the business account or that the sponsor approved the payout program.
- Sandbox acceptance is not Mainnet submission, TRON settlement, or exchange deposit credit.
- A Fincra payout status of \`processing\` is not success. Provider status, exact beneficiary amount and independent solidified TRON transaction evidence must be reconciled separately.

## Environment

Keep all credentials on the backend only:

| Variable | Use |
| --- | --- |
| \`FINCRA_ENVIRONMENT\` | \`sandbox\` by default; never change to \`live\` merely to test this branch |
| \`FINCRA_SECRET_KEY\` | Fincra environment-specific secret API key |
| \`FINCRA_BUSINESS_ID\` | Exact business ID returned by the authenticated business profile |
| \`FINCRA_SOURCE_CURRENCY\` | \`USDT\` for this same-currency adapter |
| \`FINCRA_WEBHOOK_SECRET\` | Webhook HMAC-SHA512 verification key; helper only in this release |
| \`FINCRA_SANDBOX_PAYOUTS_ENABLED\` | Optional, explicit sandbox-only test gate; does not enable live payouts |

Do not put any of these values in source control, frontend variables, issues, pull requests, or chat. Rotate credentials that have already been exposed outside the provider/Render secret store.

## Remaining production gates

All of the following remain required before a live payout route may be enabled:

1. Fincra confirms in writing that the exact sponsor legal entity and account are eligible for stablecoin payouts and the intended use case.
2. Fincra enables live USDT TRC20 payouts for that business account.
3. The sponsor organization independently owns or controls the exact Fincra account, signs the standing mandate naming the exact configured business ID, and authorizes the private-owner withdrawal purpose, recipients, amounts, limits and validity period.
4. The owner completes independent due diligence and records a durable approval reference; application or wallet signature alone is not KYB, identity verification, source-of-funds evidence, or legal approval.
5. Live account diagnostics verify the exact business profile and positive available USDT balance. The account owner/sponsor must lawfully fund that account; this integration cannot create principal or credit.
6. The provider fee model is proven to leave the exact requested net amount at the beneficiary, with any charges separately funded and authorized.
7. Production request creation reserves principal and fees atomically, pins the exact recipient/contract/network/amount and uses one stable customer reference. Fincra documents that customer references must be unique and duplicate references are rejected; after a timeout or duplicate-reference response, re-query the original reference rather than creating a different reference to attempt a second payout. A lookup 404 after an ambiguous submission is not by itself permission to replay.
8. The status worker and webhook receiver verify the provider record, webhook signature, exact mandate/business ID, exact amount and recipient. Webhooks are re-queried against Fincra before state changes; the current live-capable lookup helper is read-only and is not yet exposed by an authenticated payout-status route.
9. The Mainnet settlement path independently verifies the solidified TRON transaction, successful receipt and exact official Tether USDT Transfer event. A provider response alone is not chain settlement.
10. Testnet/sandbox integration tests, PostgreSQL concurrency/replay tests, negative tests, operational pause controls, security review and explicit production release approval pass.

No personal wallet funding, unapproved third-party spending, fabricated balance, or exchange-credit claim is permitted as a fallback.


## Duplicate and timeout policy

A webhook is a provider notification, not a withdrawal instruction. The receiver deduplicates a repeated signed event and must never use a duplicate notification to create another payout. A payout itself is identified by one stable, unique `customerReference`. Fincra documents that reusing a customer reference is rejected as a duplicate; on an ambiguous network timeout, reconcile the original reference rather than creating a new one. See the [Fincra stablecoin payout API](https://docs.fincra.com/reference/initiate-payout-2) and [customer-reference status lookup](https://docs.fincra.com/reference/fetch-payout-by-customer-reference).

The new `lookupFincraPayoutByCustomerReference` helper is a read-only building block for reconciliation and supports the configured sandbox or live API base URL. It distinguishes HTTP 404 from other provider failures. It does not retry a payout, submit an API payout request, mark a transfer settled, or enable the disabled withdrawal-request endpoints.
