# Multi-organization sponsor registry

## Scope implemented in this release

The application now has an administrator-protected PostgreSQL registry for independent sponsor organizations and their TRON accounts. Creating a record does not mean that an organization has agreed to sponsor the platform or that its account is funded.

Organizations and accounts are separate. Each account records a network and one role:

- `asset-principal`: potential source of a sponsored TRX or allowlisted USDT principal grant.
- `network-fee`: distinct account for separately approved network-fee/resource coverage.

Each account has its own immutable `sponsorReference`, which is checked against the sponsor reference on any budget linked to that account. A budget can belong to only one organization account.

## Administrator API

All endpoints require `Authorization: Bearer <SPONSOR_ADMIN_API_TOKEN>`. The token must be at least 32 characters, remain server-side, and never be committed or sent through chat. Responses are marked `Cache-Control: no-store`.

### Register an organization

`POST /api/tron/sponsorship/organizations`

```json
{
  "sponsorReference": "external-org-alpha",
  "legalName": "Example Treasury Ltd",
  "displayName": "Example Treasury",
  "jurisdictionCountryCode": "SG"
}
```

New records always start as `pending_review`.

### Register a role-specific account

`POST /api/tron/sponsorship/organizations/{organizationId}/accounts`

```json
{
  "sponsorReference": "alpha-mainnet-principal",
  "network": "mainnet",
  "role": "asset-principal",
  "address": "T..."
}
```

Register fee accounts separately with role `network-fee`. Supported networks are `mainnet`, `nile`, and `shasta`. The address must pass TRON Base58Check validation. Each account starts as `pending_verification`; a unique database constraint prevents the same network/address from being registered against multiple organizations or roles.

### Organization review

`POST /api/tron/sponsorship/organizations/{organizationId}/review`

The permitted progression is:

`pending_review -> under_review -> verified -> approved`

An organization may be suspended or revoked from a non-terminal state. Revocation is terminal. Moving to `verified` requires an evidence reference and a verification method. Moving to `approved` requires a signed-agreement reference and a review reference. The API stores references only: it does not fetch or validate the underlying legal documents or attestations. The human reviewer remains responsible for independently checking them.

### Account review

`POST /api/tron/sponsorship/organizations/{organizationId}/accounts/{accountId}/review`

An account can be verified only after its parent organization is `verified` or `approved`. Account verification requires an evidence reference, verification method, and review reference. Suspended or revoked accounts cannot be reactivated; register a new account and repeat verification.

The recorded verification method is one of `wallet-signature`, `custodial-provider-attestation`, `multisig-attestation`, or `manual-independent-review`. These labels and evidence references are audit metadata; this API does not cryptographically verify them.

### List organizations

`GET /api/tron/sponsorship/organizations?status=approved&limit=50`

The response includes account inventory and review references and is protected by the same administrator token.

## Database controls

The registry creates six tables in the existing `trc20_token_clone` PostgreSQL schema:

- `sponsor_organizations`
- `sponsor_organization_accounts`
- `sponsor_organization_audit_events`
- `sponsor_organization_budget_links`
- `sponsor_organization_payout_intents`
- `sponsor_organization_payout_reservations`

Registration, review, budget linking and link revocation are written to the audit table in the same database transaction. Foreign keys prevent orphaned account/audit records. A unique constraint prevents reusing one network/address across multiple organizations. Provider credentials and signing material are neither accepted nor stored.

## Deliberately not enabled

This release includes registry/review, exact budget association, read-only dual-sponsor candidate selection, and a short-lived two-budget accounting reservation bound to one immutable request intent. It still does not automatically validate legal documents or cryptographic wallet/custody attestations; verify transaction-specific fee coverage; cryptographically authorize a specific transfer; or sign, submit, or broadcast transactions.

All API responses explicitly keep `submissionEnabled: false` and `canSubmitSponsoredTransfer: false`. Organization/account records also report `payoutEligible: false`. Keep the separate real-value payout execution hard gate disabled.

## Implemented dual-sponsor reservation milestone

The selected principal and fee budgets can now be reserved together against one immutable transfer intent. This is an internal PostgreSQL accounting hold only: it does not lock on-chain tokens, TRX, Energy, or Bandwidth, and it does not establish sponsor consent or authority to spend.

A solidified TRON transfer does not prove an exchange credited a deposit. Exchange credit requires the receiving exchange's own authenticated deposit-status evidence.

## Attach an existing sponsor budget to a registry account

A registered account is not automatically a sponsor. It must be linked to one exact, already active sponsor budget:

`POST /api/tron/sponsorship/organizations/{organizationId}/budget-links`

Headers:

```http
Authorization: Bearer <SPONSOR_ADMIN_API_TOKEN>
Content-Type: application/json
```

Body:

```json
{
  "accountId": "12",
  "budgetId": "45",
  "reviewReference": "budget-link-review-2026-001"
}
```

The API re-reads and locks the organization, account and budget in a PostgreSQL transaction. It only accepts the link when:

- the organization is `approved` and has a recorded agreement reference;
- the exact account belongs to the organization and is `verified`;
- account network and public wallet address equal the budget network and `sponsor_address`;
- account `sponsorReference` equals the budget `sponsor_reference`;
- account role matches budget purpose (`asset-principal` for `asset-grant`, `network-fee` for `network-fee`);
- the budget is active, has an approval timestamp and review reference, and its exact agreement scope is still server-allowlisted;
- the budget's approved agreement reference equals the parent organization's signed-agreement reference.

A budget can be linked only once. Unique database and foreign-key constraints prevent linking one budget to multiple accounts or organizations. The link and audit event are committed together. Suspending or revoking an organization/account also disables its active budget links. A link can be permanently revoked with:

`POST /api/tron/sponsorship/budget-links/{linkId}/revoke`

Body: `{"reviewReference":"revocation-ticket-2026-001"}`.

List an organization's budget links with:

`GET /api/tron/sponsorship/organizations/{organizationId}/budget-links`.

## Read-only dual-sponsor selection

The administrator-only endpoint is:

`GET /api/tron/sponsorship/organizations/selection?network=nile&asset=USDT&tokenContract=T...&amountBaseUnits=2500000&estimatedFeeSun=100000`

For a native TRX principal, use `asset=TRX` and omit `tokenContract`. `amountBaseUnits` is the exact integer principal amount. `estimatedFeeSun` is the operator-supplied comparison cap in SUN; it is not a transaction quote.

The selector searches only active links whose organization is approved, account is verified, agreement scope is still allowlisted, and budget is active. It then:

1. checks that the principal budget can cover the whole requested principal and that the fee budget can separately cover the supplied fee cap;
2. requests fresh role-specific solidified funding snapshots for the exact principal and fee addresses;
3. reconciles each wallet's on-chain TRX/token balance against all of its supported active/paused ledger commitments;
4. reads the fee account's current TRON resources and the exact fee-to-principal solidified delegation pair;
5. returns a pair only when both independent balance reconciliations are covered and an active delegation is observed.

The route evaluates at most ten candidate pairs per call. A larger candidate set is reported as truncated rather than claiming exhaustive search. Provider throttling, stale snapshots, absent token-contract balance data, insufficient balances, and missing delegation all fail closed.

A successful result has status `dual-sponsor-preflight-passed-review-required`. It is **not** transaction authorization or permission to spend. The resource reader reports current resources and stake-equivalent delegation, not the exact Energy/Bandwidth requirement for a newly built transaction. Therefore the result deliberately sets `transactionSpecificFeeCoverageVerified`, `separateBudgetsReserved`, `transactionAuthorizationVerified`, `canSubmitSponsoredTransfer`, and `submissionEnabled` to false. The future submit workflow must recheck the exact transaction quote, mandate, destination policy, authorization nonce, reservations and settlement requirements.

All endpoints require the server-only `SPONSOR_ADMIN_API_TOKEN`. The selection endpoint uses existing backend provider credentials and exact registered addresses; it does not accept provider credentials, private keys, or wallet signatures in request data. Keep all sponsor secrets in the approved backend secret store.

### Create a short-lived, dual-sponsor payout intent

`POST /api/tron/sponsorship/organizations/payout-intents`

Headers:

```http
Authorization: Bearer <SPONSOR_ADMIN_API_TOKEN>
Content-Type: application/json
```

Example request for a TRX principal transfer:

```json
{
  "idempotencyKey": "operator-created-unique-intent-2026-0001",
  "network": "nile",
  "asset": "TRX",
  "receiverAddress": "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE",
  "amountBaseUnits": "2500000",
  "feeCapSun": "120000",
  "principalBudgetLinkId": "31",
  "feeBudgetLinkId": "32"
}
```

For USDT, set `asset` to `USDT` and provide the exact network-allowlisted `tokenContract`. On Mainnet, only the official Tether TRC20 USDT contract is accepted. For a testnet, the configured network-specific token contract is a test asset and is not Tether-issued Mainnet USDT.

The service re-reads the linked budgets and requires:
- two different approved sponsor organizations and two different wallet addresses;
- a verified `asset-principal` account linked to an active `asset-grant` budget;
- a verified `network-fee` account linked to a separate active `network-fee` TRX budget;
- exact matching organization/account/budget references, wallet addresses, networks, roles, purpose, asset, contract, and allowlisted agreement scopes;
- fresh solidified chain balance snapshots for both exact sponsor wallets, budget reconciliation against their commitments, and a current observed fee-to-principal resource delegation.

Both budget counters are incremented and both reservation rows, the intent row, and audit records are written in one PostgreSQL transaction. The intent digest binds the network, asset, token contract, receiver, exact base-unit principal amount, fee cap, and both budget-link IDs. Repeating the same idempotency key and identical intent returns the prior record; reusing that key with different intent data is rejected.

A new intent has status `pending_authorization` and expires after ten minutes. The system releases both internal budget reservations when an operator cancels it:

`POST /api/tron/sponsorship/payout-intents/{intentId}/cancel`

Body: `{"reviewReference":"operator-cancellation-ticket-2026-001"}`.

Expired intents can be swept by the administrator-only endpoint:

`POST /api/tron/sponsorship/payout-intents/expire`

Optional body: `{"limit":100}`.

`feeCapSun` is only the amount held against the network-fee sponsor's budget; it is not an exact transaction fee quote. The current delegation observation is not proof of sufficient Energy/Bandwidth for a specific built transaction. The reservation API does not accept sponsor signatures, does not set the intent to authorized, does not create a transaction, and cannot submit or broadcast. Every response keeps `canSubmitSponsoredTransfer`, `submissionEnabled`, and `transactionSubmitted` false; `userFundedFallbackAllowed` also remains false.

The next milestone is independent cryptographic authorization from each sponsor for this exact immutable intent, with replay-resistant nonces, expiry, signer identity and mandate policy, followed by transaction construction and transaction-specific energy/bandwidth/fee estimation. Only after a separately reviewed sponsor-owned signing/provider integration and controlled testnet validation should any submission path be considered. A real sponsor must provide genuine written consent, independently verifiable control/funding evidence, and its own authorized signing or payout service. Keep the existing Mainnet payout execution hard gate disabled.

## Remaining real-payout dependencies

The implementation still lacks independent sponsor cryptographic authorization for an exact intent, transaction-specific fee/resource verification, a sponsor-owned signing/provider adapter, controlled testnet broadcast and settlement, and a complete receiver-side real deposit verification workflow. Do not change the existing real-value payout hard gate. Mainnet release still requires a controlled end-to-end test, independent security review, operational runbook, and explicit release approval.
