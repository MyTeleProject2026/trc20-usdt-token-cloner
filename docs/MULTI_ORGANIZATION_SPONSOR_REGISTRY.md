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

The registry creates four tables in the existing `trc20_token_clone` PostgreSQL schema:

- `sponsor_organizations`
- `sponsor_organization_accounts`
- `sponsor_organization_audit_events`
- `sponsor_organization_budget_links`

Registration, review, budget linking and link revocation are written to the audit table in the same database transaction. Foreign keys prevent orphaned account/audit records. A unique constraint prevents reusing one network/address across multiple organizations. Provider credentials and signing material are neither accepted nor stored.

## Deliberately not enabled

This release includes registry, review, exact budget association and read-only dual-sponsor candidate selection. It does not automatically validate legal documents or cryptographic wallet/custody attestations; create provider connections; reserve budgets for a selected payout; verify transaction-specific fee coverage; cryptographically authorize a specific transfer; or sign, submit, or broadcast transactions.

All API responses explicitly keep `submissionEnabled: false` and `canSubmitSponsoredTransfer: false`. Organization/account records also report `payoutEligible: false`. Keep the separate real-value payout execution hard gate disabled.

## Next milestone

The next implementation step is to bind the selected principal/fee pair to one immutable transfer intent, reserve both budgets atomically, and require transaction-specific fee/resource estimates plus a sponsor-owned cryptographic authorization for that exact intent. Only then should a sponsor-owned provider/signer be integrated and tested on a controlled testnet. A real sponsor must first provide written consent, independently verifiable control/funding evidence, and its own authorized signing or payout service.

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

## Remaining real-payout dependencies

This milestone adds registry-to-budget ownership and a live read-only dual-sponsor candidate preflight. It does not integrate a sponsor-owned signer/provider submitter, create reservations for the selected pair, cryptographically verify every off-chain sponsor mandate, establish transaction-specific fee coverage, or broadcast. Do not change the existing real-value payout hard gate. Mainnet release still requires a controlled end-to-end test, independent security review, operational runbook, and explicit release approval.
