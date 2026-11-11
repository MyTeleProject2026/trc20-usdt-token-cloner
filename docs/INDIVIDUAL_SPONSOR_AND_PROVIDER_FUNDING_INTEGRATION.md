# Individual sponsors and funding-provider integration

## Scope

Tron Transfer supports two separate ways to obtain lawful payout funding:

1. **Individual self-custody sponsors.** Individuals may apply with their own TRON Mainnet wallet through the sponsor portal, subject to applicable geographic eligibility, identity, source-of-funds and sanctions checks. Eligibility must be confirmed for the applicant's actual country of legal residence and the relevant contracting entity; no country should be inferred from an approximate location or an earlier assumption. The platform owner manually reviews the application. If approved, the sponsor's wallet remains the USDT sender and the sponsor signs each exact transfer in TronLink.
2. **Contracted payout or treasury providers.** A provider may supply its own funded payout account or a specifically authorized credit facility under a signed agreement. This is a separate integration from individual wallet sponsorship. A payment API, wallet SDK, exchange account, grant programme or account registration is not itself a source of liquidity.

The two routes must not be blended into a single assumed balance. They must retain separate authorization, limits, evidence, audit trails and settlement reconciliation.

## What is implemented in this repository

### Individual sponsor route

The existing `/api/tron/sponsor-direct` route and sponsor portal provide the implementation foundation:

- wallet-authenticated sponsor application using the sponsor's own TRON Mainnet wallet;
- manual owner review and per-payout/daily limits;
- fresh official Mainnet USDT balance and TRON resource checks;
- reservation-aware sponsor matching and fee-coverage preflight;
- sponsor-specific unsigned transaction preparation;
- exact transaction validation and explicit TronLink signing by the sponsor;
- Tatum broadcast after validation; and
- solidified receipt plus exact official USDT Transfer-event reconciliation.

An approved profile is not proof of funds. A match is not authorization to spend. The sponsor must sign each exact transaction. No sponsor is presumed to exist or be funded.

### Provider activation readiness

`server/payout-activation-readiness.mjs` provides a fail-closed evidence evaluator for a provider-owned liquidity or expressly approved credit arrangement. It checks the evidence categories for provider authorization, provider wallet identity, wallet-specific available USDT, sufficient amount, official TRON Mainnet USDT contract, gas resources, recipient screening, withdrawal approval, settlement readiness and a permitted funding basis.

This evaluator is a readiness gate only. It deliberately returns `executionEnabled: false`, `signingEnabled: false`, and `broadcastingEnabled: false`, even when the evidence categories are complete. It does not call a provider, verify an account, fetch a balance, sign, broadcast or create funds. A supplied boolean or reference is not a substitute for independent verification.

## What is not yet integrated

- No named payout/treasury provider has authorized this project or supplied API credentials.
- No provider API has been selected and contractually approved for this use.
- No live provider account, wallet-specific balance, prefunded liquidity, credit facility or disbursement permission has been verified.
- No provider payout API or signed provider webhook is currently wired into the sponsor-direct route.
- No provider-based Mainnet payout has been executed or reconciled.

Do not label any prospect as an approved provider, available balance, credit facility or funded sponsor until the evidence exists.

## Provider onboarding requirements

Before implementing a provider-specific adapter, obtain and independently verify:

1. **Provider identity and authority:** legal entity, contracting entity, regulated status where applicable, authorized signatory, and the exact legal entity serving the user's jurisdiction.
2. **Geographic eligibility:** written confirmation that the provider can onboard an individual resident in the applicant's actual country of legal residence for the intended business model. Do not route around restricted jurisdictions or KYC/KYB requirements.
3. **Written funding permission:** contract clause authorizing this platform and this exact use—USDT TRC20 payouts to third-party wallet/exchange deposit addresses. Ordinary merchant settlement, exchange withdrawals, grant funding or generic API access is not equivalent.
4. **Funding model:** identify whether the provider supplies (a) its own prefunded USDT liquidity, (b) an explicitly approved credit facility, or (c) only payment-processing rails that require the customer to pre-fund. Record repayment, fees, collateral, reserves, recourse, expiry and termination terms.
5. **Asset and network:** verify that the provider supports genuine TRON Mainnet USDT at contract `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`, not another chain, bridged token, testnet asset or internal display balance.
6. **Wallet-specific liquidity:** obtain a provider-sourced, timestamped available balance and reservation/hold data for the exact sending account. An aggregate account balance or dashboard screenshot is insufficient.
7. **Network fees:** verify how Energy, Bandwidth and TRX are supplied and who pays. If the recipient must receive the full requested amount, confirm that fees are not silently deducted from the transfer principal.
8. **Authorization model:** bind every payout to the provider account, token contract, network, recipient, amount, fee cap, expiry, idempotency key and approval reference. Require any provider-mandated human review or dual control.
9. **API and webhook security:** use the provider's official documentation, server-side credentials, signed webhook verification, replay protection, idempotency, request/response identity binding, rate limits and secret rotation.
10. **Settlement evidence:** reconcile the provider's payout ID to the actual TRON transaction ID, then independently verify the solidified Mainnet receipt and exact USDT Transfer event. An exchange account credit remains a separate exchange-side event.

## Provider adapter contract

A provider-specific adapter may be added only after the provider and its official API contract are selected. It must expose narrowly scoped operations equivalent to:

- `getProviderAccountStatus()`: read-only account and onboarding state;
- `getWalletFundingSnapshot(accountRef, asset, network)`: read-only wallet-specific available, reserved and pending amounts, with source timestamp and provider evidence reference;
- `preflightPayout(intent)`: validate recipient, amount, token/network, limits, fees and provider approval without submitting;
- `submitApprovedPayout(intent, approval)`: submit only the exact previously approved intent using provider authorization;
- `getPayoutStatus(providerPayoutId)`: read-only status lookup; and
- `verifyWebhook(request)`: verify provider signature, timestamp, event identity and replay/idempotency before reconciliation.

The interface above is a design contract, not an implemented connection to any provider. Do not create generic endpoints that accept caller-supplied `funded: true`, balance numbers, approval flags, wallet addresses or transaction hashes as proof.

Provider status must remain separate from chain status:

- `provider-not-configured`
- `onboarding-pending`
- `agreement-pending`
- `approved-not-funded`
- `funded-preflight-required`
- `preflight-passed-awaiting-approval`
- `provider-submitted-awaiting-chain-verification`
- `chain-confirmed`
- `provider-rejected`
- `manual-review`

A provider API response saying accepted/submitted is not a confirmed blockchain transfer. Only independent chain verification can establish the actual transfer.

## Safe rollout gates

1. Keep the provider adapter disabled until a specific provider is selected, its official API docs are reviewed, and the provider gives written authorization for the intended use and jurisdiction.
2. Complete a provider sandbox integration with mocked or provider-supplied test assets only; never describe sandbox funds as Mainnet funds.
3. Add provider-specific contract tests for signatures, replay, idempotency, concurrent reservations, timeouts, duplicate webhooks, partial/failed payouts, insufficient liquidity, revoked authorization and reconciliation drift.
4. Complete independent security and legal/compliance review.
5. Run a small provider-authorized Mainnet pilot only after real provider liquidity and network fees are independently verified.
6. Keep the existing individual sponsor route separate. A provider integration must not weaken its sponsor consent, exact TronLink signature, live balance/resource checks or solidified-event verification.

## Operational conclusion

The individual sponsor path can work without the owner holding USDT or TRX, but only if a real sponsor voluntarily joins, passes the required checks, holds the funds/resources and signs each payment. The provider path can work only after a real provider contracts, onboards this project, authorizes the exact payout use and makes verified liquidity or approved credit available.

Until one of those conditions is actually met, withdrawal requests must remain queued or blocked. Do not promise a funded balance, enable automatic withdrawals, or use a grant, WDK, Tatum, TronLink, a prospect record or a provider login as a substitute for genuine payout funding.
