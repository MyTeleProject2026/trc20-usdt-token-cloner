# Third-Party Treasury Authorization Gate

## Purpose

This document records the organizational approvals that must exist before anyone considers a third-party treasury arrangement for TRON Token Studio. It is a governance checklist, not a Fireblocks integration guide, wallet operating procedure, legal opinion, or authorization to move funds.

**Current application state:** real-value wallet signing, transaction broadcasting, and server-funded payout submission remain disabled. Do not remove the fail-closed behavior or represent a request, preview, or unconfirmed transaction as a completed payout.

## Roles and responsibilities

- **Treasury organization:** the independent legal entity that owns or lawfully controls the funds and decides whether it will provide a payout service.
- **Authorized adult representative:** a director, officer, or other person whose authority the organization has documented. This representative must handle provider onboarding, commercial agreements, custody decisions, and payout operations.
- **Treasury/custody administrators:** personnel appointed by that organization to administer its custody environment and approve transactions under its internal controls.
- **TRON Token Studio:** at most, a request and status interface. It does not own the treasury's assets and must not imply that treasury assets are the app user's personal wallet balance.

## Required authorization gates

All gates below are external prerequisites. A software change, API key, or successful deployment does not satisfy them.

### 1. Organization and provider onboarding

The treasury organization's authorized adult representative should contact Fireblocks through its official business channels and obtain written confirmation of:

- whether the organization and its proposed business model are eligible for onboarding;
- the jurisdictions and services available to that organization;
- the KYB documents and beneficial-owner / authorized-representative information required;
- whether the specific TRON and TRC-20 asset use case is supported for the intended product and account;
- the applicable commercial terms, service scope, and support process.

Fireblocks states that its KYB/onboarding may involve company registration or incorporation documents, beneficial ownership information, and identity/contact details for directors, beneficial owners, authorized signatories, or other business representatives. The organization's representative must submit such information directly through the provider's approved process. A minor must not collect or submit other people's identity documents.

Reference: https://www.fireblocks.com/privacy-policy/

### 2. Separate agreement with the treasury organization

Fireblocks onboarding alone does not mean that the treasury agrees to fund TRON Token Studio payouts. The organization must separately approve and document:

- the legal entity responsible for each payout;
- the business purpose and eligible beneficiaries;
- who owns and controls the assets before and after each payout;
- funding commitments, fees, limits, cancellation rules, and service levels;
- responsibility for incorrect recipient details, rejected transfers, disputes, and reconciliation;
- the permitted role of TRON Token Studio and its operators.

No funds should be represented as available until the treasury confirms the arrangement and the actual asset balance through its own approved records.

### 3. Legal and compliance approval

Before any real-value service is enabled, the organization's qualified legal and compliance advisers must assess the proposed activity in every relevant jurisdiction, including whether it creates custody, money-transmission, payment-service, virtual-asset-service, sanctions, AML, KYC, consumer-protection, tax, or other obligations.

Provider onboarding is not a legal determination that the business model is permitted. Do not launch or solicit customer funds while this review is unresolved.

### 4. Custody governance and transaction approvals

The treasury organization—not the app user—must decide and administer custody governance. It must document named responsible personnel, separation of duties, approval thresholds, destination controls, transaction limits, incident response, audit logging, and reconciliation.

The organization's authorized custody administrators must retain control of credentials and signing authority. Never place seed phrases, private keys, recovery material, or signing secrets in frontend code, source control, chat, screenshots, or ordinary application settings. Do not ask a minor to handle custody credentials.

Fireblocks describes policy controls with designated approvers and approval groups. The treasury's own administrators and advisers must determine the appropriate controls for its organization.

Reference: https://developers.fireblocks.com/

### 5. Technical and security acceptance

Only after the preceding gates are documented may the organization's appointed adult technical and security owners assess a future integration. Their review must include:

- least-privilege access and separation between request creation and treasury approval;
- authenticated, integrity-protected request handling and replay protection;
- verified recipient and asset identification;
- independent verification of network transaction outcome;
- idempotency, auditability, reconciliation, monitoring, and incident handling;
- documented recovery and access-revocation procedures.

This repository document intentionally does not provide signing instructions, credential setup, payout API calls, or a method to bypass provider controls.

## Project status tracker

| Gate | Status |
|---|---|
| Fireblocks organization onboarding and KYB | Not confirmed |
| Treasury organization willing to fund payouts | Not confirmed |
| Written treasury service agreement | Not provided |
| Legal/compliance review | Not provided |
| Custody governance approved by treasury | Not provided |
| Technical/security acceptance | Not provided |
| Real-value payout execution in this application | Disabled |

## Release rule

Real-value payout execution must remain disabled unless the organization itself has completed and documented every applicable gate, and its authorized adult representatives have independently approved any future release. A green build, a live Render deployment, an API key, a displayed balance, or an unconfirmed transaction is not proof of authorization or payment.

Never create fictitious USDT balances, fake transaction identifiers, or status messages that imply funds reached an external exchange or wallet when they did not.
