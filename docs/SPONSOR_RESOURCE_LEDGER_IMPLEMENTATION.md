# Sponsor Energy/Bandwidth resource ledger

**Implementation branch:** `feat/sponsor-resource-ledger-implementation`  
**Release state:** experimental backend accounting implementation; testnet signing remains blocked pending controlled pilot and independent review. Mainnet sponsor submission is not provided by this path.

## Scope

This ledger is separate from the existing TRX/USDT sponsor principal ledger. It records delegated Energy and Bandwidth allowances in their native resource units. It does not count those units as TRX, does not record an assumed TRX debit against the fee sponsor, and does not alter the existing Wallet Vault, wallet encryption, TronLink connection, or normal Mainnet exchange-deposit flow.

Only Shasta and Nile resource mandates are accepted. The live application does not treat a configured sponsor address as proof of sponsor control, funding, signed consent, or permission to spend.

## Operator-reviewed resource mandate

The backend-only environment allowlist is:

`SPONSOR_APPROVED_RESOURCE_MANDATES`

Each semicolon-separated entry contains exactly nine pipe-separated fields:

`mandateReference|sponsorReference|network|feeSponsorAddress|assetPrincipalAddress|energyBudgetUnits|bandwidthBudgetUnits|perTransferEnergyUnits|perTransferBandwidthUnits`

All resource allowances are integer Energy/Bandwidth units, not SUN or TRX. The fee and asset-principal addresses must be different. Only `nile` and `shasta` are accepted.

Add an entry only after an operator has reviewed the signed sponsor mandate, confirmed control of both sponsor roles, verified the exact network and token scope, and checked the active fee-sponsor-to-principal delegation. The environment string is an operator-controlled approval allowlist; it is not itself a cryptographic proof of the external agreement.

The resource budget row is created from the approved scope when a transfer is reserved. Its aggregate Energy/Bandwidth caps and per-transfer caps are fixed for that mandate reference. Changing a cap requires a new reviewed mandate reference; the database rejects a conflicting reuse of an existing reference.

## Reservation flow

1. An existing, approved Shasta/Nile asset-principal transfer reservation must exist in the principal ledger.
2. The backend prepares and persists the exact unsigned transaction.
3. The backend re-reads fee-sponsor resources and the exact delegation for the saved transaction.
4. The capacity result must establish the single inbound delegation as the supported coverage source. Free Bandwidth, the principal's own stake, and unrelated resource sources are not counted as fee-sponsor coverage.
5. The backend locks the principal transfer, resource budget and idempotency reservation in PostgreSQL. It reserves exact Energy and Bandwidth estimates within both per-transfer and aggregate mandate caps.
6. The same idempotency key can retrieve the same active reservation. An expired, never-submitted reservation can be released and recreated only while the principal transfer is still pending review.
7. The broadcast claim locks the same reservation and binds it to the exact transaction ID before any node broadcast. A missing, expired, paused, mismatched or unapproved resource reservation rejects the claim.

No fee sponsor private key or wallet recovery phrase is stored by the application. Signing remains in the sponsor wallet/custody boundary and the signed transaction is validated against the saved intent.

## Solidified receipt settlement

The reconciliation path uses the fixed selected network's SolidityNode transaction and receipt and requires exact transaction identity, successful execution, matching receiver/asset/amount, and the same solidified block as the principal verification.

It stores the receipt fields separately:
- `reportedFeeSun`, `energyFeeSun`, `netFeeSun`;
- `energyUsage` (caller-side Energy), `energyUsageTotal`, and `originEnergyUsage`;
- `netUsage` (Bandwidth) and `energyPenaltyTotal`.

Contract-origin Energy is retained as evidence but is not counted as the caller's fee-sponsor resource consumption. Only caller-side Energy and transaction Bandwidth are compared with the pre-sign resource reservation.

A resource allowance is settled only when:
- the same transfer, reservation, fee sponsor, principal sponsor, network, transaction ID and solidified block match;
- the exact single-delegation capacity snapshot is persisted;
- the receipt has a successful execution result;
- all required fee evidence is present and reports zero TRX burn;
- caller Energy and Bandwidth usage are present and do not exceed the exact reservation.

On a qualifying receipt, actual resource units are booked as spent and the unused reserved units are released. Duplicate reconciliation is idempotent. A conflicting observation or repeated transaction with different evidence is rejected.

### Manual review conditions

The reservation remains held and is changed to `manual-review` if:
- any reported/energy/network TRX fee is non-zero;
- fee or resource fields are missing;
- the receipt identity, sponsor role, block or reservation does not match;
- actual resource consumption exceeds its reservation;
- the capacity snapshot cannot prove the exact inbound delegation.

A TRX fee observation is not proof that the fee sponsor was debited. A zero fee burn plus exclusive delegated-resource preflight supports resource-unit accounting for the principal transaction, but it does **not** prove a direct TRX debit or prove that a particular provider paid cash. The response and audit ledger therefore keep `directFeeSponsorTrxDebitVerified=false` and `sponsorFeeBudgetSettled=false`; only `feeSponsorResourceBudgetSettled=true` can indicate successful resource-unit settlement.

## Operator endpoints

Both endpoints require the server-only `SPONSOR_ADMIN_API_TOKEN` bearer credential. They are not exposed as public user controls.

- `GET /api/tron/sponsorship/resource-budget-reservations?network=nile|shasta&limit=50` reads a bounded view of reservations, usage, settlement status and remaining resource caps.
- `POST /api/tron/sponsorship/resource-budgets/:mandateReference/pause` accepts exactly one reason: `operator-request`, `funding-mismatch`, `provider-incident`, or `emergency-stop`. Pausing blocks new reservations/claims but does not release a submitted transaction's reserved resources; already-submitted transfers can still be reconciled.

## Release gate

The signing and broadcast routes require both:
- `SPONSOR_TESTNET_SIGNED_BROADCAST_ENABLED=true`;
- `SPONSOR_TESTNET_PILOT_RELEASE_APPROVED=true`.

Both default to false. The second flag is a separate operator approval after a controlled end-to-end testnet pilot and independent security review. A historical environment opt-in alone cannot bypass this source-code gate. The application still does not have Mainnet sponsor submission through this route, and user-funded fallback remains prohibited.

Do not set either flag merely to change UI readiness. Before approval, verify distinct sponsor ownership, written mandate, funded testnet principal, fee sponsor resource delegation, exact token contract, transaction-specific budget limits, wallet signature permission, a real Nile and Shasta pilot, successful solidified receipt and receiver balance delta, resource settlement, replay/concurrency behavior, incident pause, and an independent security review.

## Remaining external prerequisites

This repository cannot create sponsor agreements, fund external wallets, authorize another party's wallet, configure Fireblocks credentials, or verify an exchange's deposit credit. Those require the actual sponsor operators and their authorized custody workflows. No live funding, sponsor permission, provider submission, or real sponsored transfer is asserted by this implementation.

## Protocol references

- TRON transaction receipt and solidified-node API: https://developers.tron.network/reference/gettransactioninfobyid
- TRON account resources: https://developers.tron.network/reference/getaccountresource
- TRON Stake 2.0 delegation: https://developers.tron.network/docs/delegation
- TRON Energy and Bandwidth: https://developers.tron.network/docs/bandwidth-and-energy
