# Sponsor-funded transfer: no user-funds policy

## Product promise and limit

The intended sponsored mode is **external-sponsor-only**: an eligible user does not supply the transfer principal or network fee for an approved transfer. This is a product policy, not a claim that sponsorship is currently live. If no sponsor has approved and funded the request, the transfer is unavailable; the application must not silently charge the user's wallet, buy a paid provider service, or display a simulated credit.

## Eligibility contract

A request is eligible only when every condition is true at execution time:

- The provider and exact network are explicitly enabled by an operator.
- The sponsor has explicitly agreed to the program and the exact use case.
- The sponsor account identity and on-chain funding are freshly verified on the selected network.
- The exact asset and token contract are allowlisted; a symbol by itself is insufficient.
- The destination is compatible and allowlisted, including any required exchange memo/tag and amount minimum.
- The provider confirms that its supported path can deliver the full requested principal and separately cover the allowed fee.
- The quote is current; independent principal and fee budgets are available and atomically reserved.
- A cryptographically verified authorization binds the sponsor, network, destination, exact amount, maximum fee, nonce, expiry, and idempotency key.
- The emergency pause is off and the per-transfer/program limits are satisfied.

If any check is missing, stale, ambiguous, or unavailable, return a blocked status with a non-sensitive reason. Do not submit and do not use user funds as fallback.

## User-facing statuses

- `sponsor-not-configured`: no provider is integrated for this network.
- `sponsor-approval-required`: the external sponsor has not approved the request.
- `sponsor-funding-unverified`: current chain funding or program budget could not be verified.
- `unsupported-asset-or-destination`: exact asset/network/destination compatibility is not approved.
- `fee-coverage-unverified`: provider cannot prove how the network fee is covered.
- `authorization-required`: no valid sponsor authorization exists for this exact transfer.
- `sponsor-budget-insufficient`: sponsor budgets cannot cover the full principal and fee.
- `sponsor-paused`: operator emergency pause is active.
- `ready-for-sponsored-submission`: all preflight gates passed; this is still not a transfer success.
- `submission-unknown`: submission outcome is ambiguous; reconcile the original request before retrying.
- `solidified-on-chain`: independent chain evidence confirms the exact transfer.
- `exchange-credit-unverified`: chain transfer is confirmed but the exchange has not authoritatively confirmed deposit credit.
- `exchange-credited`: only use after an authoritative exchange record confirms credit.

Never show a sponsor budget, provider quote, pending reservation, or expected grant as a user's spendable wallet balance.

## Ledger and settlement rules

- Principal and network-fee reservations are separate and atomic.
- The receiver must receive the exact approved amount; fees are not subtracted from principal.
- Repeated identical requests must be idempotent. A repeated key with a different intent is rejected.
- An ambiguous timeout is reconciled using the same provider request/reference; do not submit a replacement automatically.
- Release reservations only after resolving the transaction state and recording an audit event.
- A chain transaction is not an exchange credit. Exchange credit requires an authenticated exchange deposit-status integration.
- Refunds, reversals, and expired grants require a durable reconciliation record; do not manufacture replacement credits in the UI.

## Current implementation boundary

The existing API can read sponsor wallet balances and TRON resource snapshots and maintains fail-closed sponsorship status. These read-only facts do not prove sponsor consent, a funded spendable budget, signing authority, fee coverage, or a successful submission. GasFree discovery/preflight is not itself a sponsor-funded asset-principal transfer.

Until a real provider-specific signing/submission adapter, funded sponsor program, durable authorization, and tested reconciliation path are integrated, the correct status is unavailable. Keep `canSubmitSponsoredTransfer` and `submissionEnabled` false. This protects the user from accidental charges and false success claims.

## Acceptance evidence required to enable a network

For each exact network/asset combination, retain sanitized evidence of sponsor approval, funding checks, provider quote and authorization, independent testnet transaction verification, exact receiver amount, fee settlement, duplicate-request behavior, timeout reconciliation, and emergency-pause behavior. Mainnet additionally requires explicit operator approval and independent security review.
