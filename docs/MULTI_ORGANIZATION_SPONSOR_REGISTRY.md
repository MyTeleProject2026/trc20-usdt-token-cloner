# Multi-organization sponsor registry

## Scope implemented in this release

The application now has an administrator-protected PostgreSQL registry for independent sponsor organizations and their TRON accounts. Creating a record does not mean that an organization has agreed to sponsor the platform or that its account is funded.

Organizations and accounts are separate. Each account records a network and one role:

- `asset-principal`: potential source of a sponsored TRX or allowlisted USDT principal grant.
- `network-fee`: distinct account for separately approved network-fee/resource coverage.

Each account has its own immutable `sponsorReference`, intended to match the exact sponsor reference used by the existing budget/agreement-scope workflow. This registry release does not yet enforce that cross-table relationship.

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

The registry creates three tables in the existing `trc20_token_clone` PostgreSQL schema:

- `sponsor_organizations`
- `sponsor_organization_accounts`
- `sponsor_organization_audit_events`

Registration and review changes are written to the audit table in the same database transaction. Foreign keys prevent orphaned account/audit records. A unique constraint prevents reusing one network/address across multiple organizations. Provider credentials and signing material are neither accepted nor stored.

## Deliberately not enabled

This release is registry and review workflow only. It does not yet link registry accounts to the existing sponsor-budget rows with a foreign key; validate sponsor agreements; verify wallet control or custodial attestations automatically; create provider connections; retrieve live balances/resources; allocate or select sponsors; reserve budgets; or create, sign, submit, or broadcast transactions.

All API responses explicitly keep `submissionEnabled: false` and `canSubmitSponsoredTransfer: false`. Organization/account records also report `payoutEligible: false`. Keep the separate real-value payout execution hard gate disabled.

## Next milestone

The next implementation step is a reviewed, database-enforced mapping from approved organization accounts to the existing budget/agreement scopes, followed by a selection engine that checks principal and fee/resource capacity independently. Only then should the platform integrate a sponsor-owned provider/signer. A real sponsor must first provide written consent, independently verifiable control/funding evidence, and its own authorized signing or payout service.

A solidified TRON transfer does not prove an exchange credited a deposit. Exchange credit requires the receiving exchange's own authenticated deposit-status evidence.
