# Sponsor provider application API

## Purpose and authority boundary

This intake collects a provider organization's name, business contact email, and requested onboarding scope for manual due diligence. It is not a sponsor agreement, proof of funding, approval to act as a provider, signing authority, or permission to submit a transaction.

All sponsored transaction submission remains disabled. The API deliberately returns providerSubmissionEnabled: false and feeSponsorshipEnabled: false regardless of application state. The project requires a separate verified external sponsor agreement and fee policy compatible with the external-sponsor-only requirement before any submission path can be considered.

## Public routes

### Submit an application

POST /api/tron/sponsorship/provider-applications

JSON body:

    {
      "providerName": "Example organization",
      "contactEmail": "operations@example.org",
      "scope": "network-fees",
      "privacyConsent": true
    }

Allowed scopes:
- network-fees — request due diligence for network-fee/resource sponsorship.
- trx-grant — request due diligence for a separate native TRX asset grant.
- trc20-grant — request due diligence for a separately authorized TRC-20 asset grant.

Only the four listed request fields are accepted. Extra keys are rejected rather than ignored; do not send passwords, wallet keys, recovery phrases, provider API secrets, signatures, or transaction payloads. The route requires privacyConsent: true and applies an in-memory rate limit of three submissions per normalized email per hour per running process.

On success (201), the response returns an opaque UUID reference, scope, initial status pending-review, and a clear notice that no provider approval or transaction authorization was created. Contact details are not echoed back. Keep the reference to check status later. There is no automatic confirmation email.

Possible errors include:
- 400 for invalid fields, missing consent, or unexpected fields.
- 429 for too many attempts for that email within the rate-limit window.
- 503 if the database is unavailable or successful storage cannot be confirmed.

### Read application status

GET /api/tron/sponsorship/provider-applications/{reference}/status

This route requires the opaque UUID reference, sets Cache-Control: no-store, and returns status metadata only; it never reveals the provider name or contact email. Statuses include pending-review, in-review, accepted-for-due-diligence, declined, and closed. An invalid reference returns 400; a syntactically valid but unknown reference returns 404.

The reference should be treated as private because it grants access to status metadata for that application.

## Operator-only routes

These routes use Authorization: Bearer <SPONSOR_ADMIN_API_TOKEN>. The token must remain server-side, be at least 32 characters, and must not be exposed in browser code, URLs, logs, or application responses.

### List applications

GET /api/tron/sponsorship/provider-applications?status=pending-review&limit=50

The optional status filters to one known status; limit is from 1 to 100. This privileged route may return the business email, so it must only be used by an approved project operator over HTTPS. It sets Cache-Control: no-store and varies on authorization.

### Record a manual review decision

POST /api/tron/sponsorship/provider-applications/{reference}/review

Example request:

    {
      "status": "accepted-for-due-diligence",
      "reviewReference": "approved-internal-case-reference"
    }

Allowed review statuses are in-review, accepted-for-due-diligence, declined, and closed. Acceptance for due diligence requires a review reference and records an audit event; it is not an approved sponsor agreement and cannot activate fee sponsorship. Final states cannot be changed by repeatedly calling the review endpoint; reopening or reversal requires a deliberate reviewed change.

## Persistence and auditing

Applications are stored under trc20_token_clone.sponsor_provider_applications with a UUID reference, provider name, normalized business email, scope, status, timestamps, and an optional review reference. Creation and review decisions record non-secret metadata in trc20_token_clone.audit_events. API secrets, signing keys, recovery phrases, signatures, and transaction payloads are not stored in this table.

The in-memory rate limit resets when the backend process restarts and does not replace a shared durable abuse-control service. For public production onboarding at scale, add cross-instance rate limiting, privacy/retention policy, CSRF/origin review where applicable, and operational monitoring. Do not disable the field allowlist or consent check as a workaround.

## Operational verification checklist

1. Confirm Render deploys the expected main commit and the backend startup log reports database initialization as ready.
2. Submit a test application using non-sensitive test contact data and explicit consent; confirm a 201 response with a UUID reference.
3. Query the status route using that reference; confirm it returns status metadata but no provider name or email.
4. Query the admin list route without a token and confirm 401. With a properly stored server-side admin token, confirm it returns a bounded list.
5. Test each review transition and confirm the audit event and status change. In particular, verify accepted-for-due-diligence requires a review reference.
6. Independently confirm fee payer semantics, funding, consent, signer authorization, limits, replay protection, settlement, and chain finality before implementing any sponsored submission flow.

GitHub Actions currently has a runner-assignment failure in this repository; until the runner executes npm test, the committed regression tests must not be described as passing. A successful Render deploy confirms startup/build, not end-to-end provider application or sponsored-transfer behavior.
