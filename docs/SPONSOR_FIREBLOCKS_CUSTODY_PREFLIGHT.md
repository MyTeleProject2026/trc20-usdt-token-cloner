# Sponsor organization Fireblocks custody preflight

## Purpose

This integration binds one approved sponsor organization to two distinct existing Fireblocks vault accounts:

- **Principal vault:** the registry's asset-principal wallet and official Mainnet USDT asset.
- **Fee/resource vault:** the registry's network-fee wallet and native TRX asset.

Both role-specific accounts must belong to the same approved registry organization and must use different wallet addresses, registry account IDs, and Fireblocks vault-account IDs. The first adapter intentionally supports one Fireblocks workspace for one legal sponsor organization. It does not accept multiple provider credentials or arbitrary caller-supplied vault IDs.

## Prerequisites

Before configuring this preflight:

1. The real treasury organization has completed its legal, compliance, custody-provider, and written mandate reviews.
2. The organization is approved in the sponsor registry.
3. Its principal and fee wallets are separately registered, independently verified, and linked to separate approved budgets.
4. Both sponsor owners have approved the exact payout intent through their own wallet sessions.
5. The Fireblocks workspace belongs to that organization and contains the two existing TRON vault accounts. Do not create or claim vault ownership through this application.
6. The Fireblocks USDT asset metadata identifies the official TRON Mainnet USDT contract TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t with six decimals. The fee asset metadata must identify native TRX with six decimals.
7. The fee wallet has a current solidified Energy and/or Bandwidth delegation to the principal wallet. The separate TRON transaction preflight must confirm that the principal has enough current resources for the specific unsigned transaction.

## Backend environment mapping

Use the existing backend-only Fireblocks API user credentials:

- FIREBLOCKS_API_KEY
- FIREBLOCKS_SECRET_KEY_PATH
- FIREBLOCKS_API_BASE

Then configure these non-secret mapping values:

- SPONSOR_FIREBLOCKS_REGISTRY_ORGANIZATION_ID
- SPONSOR_FIREBLOCKS_REGISTRY_PRINCIPAL_ACCOUNT_ID
- SPONSOR_FIREBLOCKS_REGISTRY_FEE_ACCOUNT_ID
- SPONSOR_FIREBLOCKS_PRINCIPAL_VAULT_ACCOUNT_ID
- SPONSOR_FIREBLOCKS_FEE_VAULT_ACCOUNT_ID
- SPONSOR_FIREBLOCKS_USDT_ASSET_ID
- SPONSOR_FIREBLOCKS_TRX_ASSET_ID

The registry IDs must match the records returned by the sponsor registry. Fireblocks vault IDs must be numeric and distinct. Asset IDs must be copied from the real workspace after metadata verification. Never infer an asset ID from a ticker. Never put API credentials, RSA keys, private keys, or recovery material in the frontend or APK.

The adapter internally creates role-scoped Fireblocks clients using the same workspace API identity but different vault account IDs. It re-reads the Fireblocks vault account, asset metadata, asset wallet address, and provider-available balance for both roles. For USDT it requires the metadata contract address to resolve to the official Mainnet contract; for the fee account it requires native TRX metadata. It also obtains Fireblocks' high fee estimate for the exact payout amount and recipient and compares that estimate with the intent's approved fee cap.

## Endpoint

POST /api/tron/sponsorship/payout-intents/{intentId}/custody-preflight

Headers:

```http
Authorization: Bearer <SPONSOR_ADMIN_API_TOKEN>
Content-Type: application/json
```

Body must be empty:

```json
{}
```

The endpoint requires an unexpired, dual-owner-approved, internally reserved payout intent and independently passing TRON resource preflight. It is administrator-protected and returns no provider credentials or RSA key material.

## Important limits

This is a **read-only provider custody preflight**, not a payout execution endpoint. It does not:

- create a Fireblocks transaction;
- approve or bypass Fireblocks transaction policies;
- sign or broadcast any TRON transaction;
- create or delegate TRON Energy/Bandwidth;
- lock USDT or TRX on-chain;
- guarantee final network fees or exchange deposit credit.

The response must continue to report transactionCreated=false, transactionSigned=false, transactionSubmitted=false, canSubmitSponsoredTransfer=false, and submissionEnabled=false. A passing result means only that the configured provider workspace and both mapped vault roles pass this read-only check at that time.

The next implementation stage is a separate idempotent provider submission/settlement workflow that rechecks the mandate, policy, reserved budgets, live chain balances/resources, exact recipient and amount, and provider approvals. It must preserve Fireblocks' transaction approval policy, reconcile the provider transaction ID with the solidified TRON transaction and exact USDT Transfer event, and safely handle timeouts/unknown provider outcomes without duplicate payouts. That execution stage must remain disabled until the real organization authorizes it and controlled end-to-end evidence exists.
## Gated provider submission and status recovery

The follow-on implementation adds two administrator-only endpoints:

- POST /api/tron/sponsorship/payout-intents/{intentId}/fireblocks-submit with an empty JSON body creates or recovers the provider transaction request.
- POST /api/tron/sponsorship/payout-intents/{intentId}/fireblocks-refresh with an empty JSON body reads the existing Fireblocks transaction status. It never creates a new request.

The submission endpoint is an actual provider-side side effect when all release gates pass. It requires all of the following backend variables:

- SPONSOR_ORG_FIREBLOCKS_SUBMISSION_ENABLED=true
- SPONSOR_ORG_FIREBLOCKS_PRODUCTION_RELEASE_APPROVED=true
- SPONSOR_MAINNET_BUDGET_ACTIVATION_ENABLED=true
- SPONSOR_ORG_FIREBLOCKS_RELEASE_REFERENCE=<approved release/review reference>

All four are deliberately unset or false in the environment template. Do not enable them until the real treasury organization, its legal mandate, both role wallets and budgets, Fireblocks vault policies/approvers, real provider balances, fee-resource delegation, and controlled testnet evidence have been independently reviewed. Enabling these gates can create a real Fireblocks transaction request; the provider's own policy may sign and broadcast automatically if its rules allow it. The application does not bypass that policy.

Before a new provider request, the backend revalidates the exact approved intent, reservations and registry account mappings, re-runs both TRON resource and Fireblocks custody preflights, and writes an immutable local submission record. The external transaction ID is deterministically derived from the intent ID and digest. Fireblocks documents that it permanently rejects future transaction requests using a duplicate externalTxId; retries therefore look up and reuse the same identifier rather than generating a new payment ID.

Provider timeouts and ambiguous outcomes keep both sponsor reservations active. The application looks up the same externalTxId and records a provider-unknown state when it cannot prove whether Fireblocks accepted the request. It must not release the reservation, mint a replacement request ID, or fall back to user funds.

A Fireblocks request ID or provider status is not a confirmed blockchain payment. A provider-returned transaction hash is still only a candidate for independent Mainnet verification. The new submission records do not yet settle sponsor budgets; principal spend and the fee sponsor's actual TRX spend remain reserved pending a separate exact solidified-receipt/event verification and budget settlement stage. The current response flags remain non-submittable at the application/chain settlement layer.