# Multi-organization sponsor registry, budget mapping and selection preflight

## Organization and account registry

The administrator-only registry is documented in the organization registration sections below. Organizations start in `pending_review`; account entries start in `pending_verification`. A human reviewer must verify evidence and a signed sponsor mandate before the organization can be approved and its account marked verified.

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
