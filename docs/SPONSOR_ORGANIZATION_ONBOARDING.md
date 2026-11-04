# Wallet-Bound Sponsor Organization Onboarding

This flow adds a durable, wallet-bound organization application to TRON Token Studio. It is the next due-diligence stage after the read-only sponsor-liquidity aggregation. It does not enable transfers.

## What the application proves

A sponsor applicant must first complete the existing TRON Token Studio wallet sign-in flow on **TRON Mainnet**. That flow verifies a one-use message signature and creates a short-lived wallet session bound to the configured frontend origin. The organization application takes its sponsor wallet address from that authenticated session; the client cannot choose a different address.

The application records:
- organization name, business contact email, jurisdiction and optional HTTPS website;
- the authenticated Mainnet sponsor wallet address;
- requested roles: `asset-principal` and/or `network-fees`;
- explicit attestations that the applicant is authorized to represent the organization, controls the sponsor wallet, has lawful control of the proposed funds, accepts the sponsor terms and consents to the stated application-data processing;
- the server-defined attestation version and application/review audit metadata.

The attestations are declarations, not independent proof of incorporation, beneficial ownership, delegated authority, source of funds or a legal mandate. The owner must perform the required due diligence independently.

## Routes

All routes set `Cache-Control: no-store`.

### Submit an organization application

`POST /api/tron/sponsorship/organizations`

Requires `Authorization: Bearer <wallet-session-token>` and the exact configured frontend `Origin`. The session must be a valid Mainnet wallet session.

Example JSON:

    {
      "organizationName": "Example Sponsor Foundation",
      "businessEmail": "treasury@example.org",
      "jurisdiction": "Singapore",
      "website": "https://example.org",
      "requestedRoles": ["asset-principal", "network-fees"],
      "authorityToRepresentOrganization": true,
      "controlsSponsorWallet": true,
      "lawfulSourceOfFunds": true,
      "acceptsSponsorTerms": true,
      "privacyConsent": true
    }

The wallet address is derived from the authenticated session and must not be sent in the body. Only HTTPS websites are accepted. Unexpected fields—including private keys, seed phrases, signatures, API credentials and client-supplied wallet addresses—are rejected.

A wallet may have one open application at a time. Identical resubmission is idempotent; conflicting resubmission is rejected. The database also limits a wallet to three applications in a rolling 24-hour period.

On success, the response is `pending-review` and includes a generated `sponsorReference` that can later be associated with an independently approved budget. The application is not a sponsor agreement and contributes zero available liquidity.

### Read the applicant's own application

`GET /api/tron/sponsorship/organizations/me`

Requires the same authenticated Mainnet wallet session. The lookup is scoped to the address in that session. Contact details are shown only to the wallet that submitted the application.

### Owner-only application queue

`GET /api/treasury/owner/sponsor-organizations?status=pending-review&limit=50`

Requires a valid Mainnet wallet session for `OWNER_WALLET_ADDRESS` or `TREASURY_OWNER_ADDRESS`. The bounded status filter accepts `pending-review`, `in-review`, `accepted-for-due-diligence`, `declined` or `closed`. The protected owner response may include business contact details.

### Owner-only review

`POST /api/treasury/owner/sponsor-organizations/{id}/review`

Example JSON:

    {
      "status": "accepted-for-due-diligence",
      "reviewReference": "internal-case-review-2026"
    }

The review reference is mandatory for due-diligence acceptance and decline decisions. Every decision stores the reviewing owner address and a non-secret audit event. Allowed transitions are deliberately limited:
- `pending-review` → `in-review`, `accepted-for-due-diligence` or `declined`;
- `in-review` → `accepted-for-due-diligence` or `declined`;
- `accepted-for-due-diligence` → `in-review`, `declined` or `closed`;
- `declined` → `closed`;
- `closed` is final.

`accepted-for-due-diligence` does **not** mean approved to send money. It is a workflow state indicating that an organization has passed an initial intake review for continued due diligence.

## Relationship to sponsor budgets and withdrawals

Organization onboarding deliberately does not:
- create or activate a sponsor budget;
- add a wallet to the approved agreement-scope allowlist;
- reserve USDT or TRX;
- prove that the on-chain balance is uncommitted or available;
- grant transaction-signing authority or custody rights;
- delegate Energy/Bandwidth;
- sign, broadcast or submit a transaction;
- mark an exchange deposit as credited.

To contribute actual USDT principal, an organization must separately execute an appropriate agreement/mandate, complete identity and authority checks, nominate an authorized signer or sponsor-operated wallet workflow, establish exact-scope asset-grant approval, and prove a fresh solidified Mainnet USDT balance. Fee/resource sponsorship remains a separate role and requires its own TRX/resource budget and payer evidence. The existing exact-scope agreement allowlist and budget activation controls remain in force.

The organization table is separate from the existing provider-interest application table: provider due diligence alone does not prove control of a sponsor wallet.

## Storage and deployment

Applications are stored in `trc20_token_clone.sponsor_organizations`; creation and review metadata are written to `trc20_token_clone.audit_events`. The schema is created idempotently when a route first accesses it. It stores no private keys, signatures, seed phrases, transaction payloads, or provider credentials.

The existing backend settings `DATABASE_URL`, `FRONTEND_ORIGIN`, and the configured owner wallet identity are used. No Fireblocks account, vault, API key, secret-key file, new provider, or new Render environment value is required for this intake workflow.

## Verification checklist

1. Sign in with a sponsor-controlled TRON Mainnet wallet using the existing wallet challenge and signature flow.
2. Submit a non-production organization test application; expect `pending-review`.
3. Confirm the recorded sponsor wallet matches the authenticated signer, not a body-supplied address.
4. Confirm the sponsor wallet can read only its own application.
5. Sign in with the configured owner wallet and inspect the owner-only queue.
6. Record a review with an internal case reference and confirm the audit event.
7. Confirm that all responses still state `sponsorAgreementAuthorized: false`, `canContributeLiquidity: false` and `payoutAuthorized: false`.
8. Confirm the organization does not appear as available sponsor capacity until separate exact-scope approval, active budget, and fresh on-chain balance reconciliation all succeed.

This feature is an onboarding workflow, not a production payout integration. Real withdrawals remain disabled until a separately tested signer, principal-funding, network-resource, reservation, reconciliation, replay-protection and settlement workflow is authorized and deployed.
