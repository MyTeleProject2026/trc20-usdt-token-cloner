# Multi-organization sponsor registry

## Scope implemented in this release

The application now has an administrator-protected PostgreSQL registry for independent sponsor organizations and their TRON accounts. Creating a record does not mean that an organization has agreed to sponsor the platform or that its account is funded.

Organizations and accounts are separate. A legal organization may register one or more role-specific wallets. The principal and fee roles can belong to one organization or to two different organizations, but they always remain separate accounts, addresses, budgets, and approvals. Each account records a network and one role:

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

The registry creates eight tables in the existing `trc20_token_clone` PostgreSQL schema:

- `sponsor_organizations`
- `sponsor_organization_accounts`
- `sponsor_organization_audit_events`
- `sponsor_organization_budget_links`
- `sponsor_organization_payout_intents`
- `sponsor_organization_payout_reservations`
- `sponsor_organization_payout_authorization_challenges`
- `sponsor_organization_payout_authorizations`

Registration, review, budget linking and link revocation are written to the audit table in the same database transaction. Foreign keys prevent orphaned account/audit records. A unique constraint prevents reusing one network/address across multiple organizations. Provider credentials and signing material are neither accepted nor stored.

## Deliberately not enabled

This release includes registry/review, exact budget association, read-only dual-sponsor candidate selection, short-lived atomic two-budget accounting reservations, and separate one-time wallet-message approvals from both sponsor accounts bound to the immutable request intent. It still does not automatically validate legal documents or custody attestations; verify transaction-specific fee coverage; create or sign the blockchain transaction; or submit or broadcast transactions.

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
- either two separately approved sponsor organizations, or one approved organization with two separately verified role-specific accounts;
- two different wallet addresses in all cases; the same wallet cannot serve both roles;
- a verified `asset-principal` account linked to an active `asset-grant` budget;
- a verified `network-fee` account linked to a separate active `network-fee` TRX budget;
- distinct account IDs, budget IDs, and budget-link IDs, even when both accounts belong to one organization;
- an approved agreement whose legal scope expressly authorizes that organization to fund each role, with exact matching organization/account/budget references, wallet addresses, networks, roles, purpose, asset, contract, and allowlisted agreement scopes;
- fresh solidified chain balance snapshots for both exact sponsor wallets, budget reconciliation against their commitments, and a current observed fee-to-principal resource delegation.

Both budget counters are incremented and both reservation rows, the intent row, and audit records are written in one PostgreSQL transaction. The intent digest binds the network, asset, token contract, receiver, exact base-unit principal amount, fee cap, and both budget-link IDs. Repeating the same idempotency key and identical intent returns the prior record; reusing that key with different intent data is rejected.

A new intent has status `pending_authorization` and expires after ten minutes. The system releases both internal budget reservations when an operator cancels it:

`POST /api/tron/sponsorship/payout-intents/{intentId}/cancel`

Body: `{"reviewReference":"operator-cancellation-ticket-2026-001"}`.

Expired intents can be swept by the administrator-only endpoint:

`POST /api/tron/sponsorship/payout-intents/expire`

Optional body: `{"limit":100}`.

`feeCapSun` is only the amount held against the network-fee sponsor's budget; it is not an exact transaction fee quote. The current delegation observation is not proof of sufficient Energy/Bandwidth for a specific built transaction. The reservation endpoint itself does not accept sponsor signatures. Each sponsor separately signs a one-time, role-specific message on `#/sponsor-authorization`; after both wallets are verified, the intent becomes `sponsor_authorization_complete`. That status proves both owner-message approvals only. It does not authorize a blockchain transaction, create/sign a transaction, or permit submission/broadcast. Every response keeps `canSubmitSponsoredTransfer`, `submissionEnabled`, and `transactionSubmitted` false; `userFundedFallbackAllowed` also remains false.

The next milestone is a separately reviewed sponsor-controlled transaction signer/provider and controlled testnet settlement. A real sponsor must provide genuine written consent, independently verifiable control/funding evidence, and its own authorized signing or payout service. Keep the existing Mainnet payout execution hard gate disabled.

### Read-only transaction-specific preflight for an approved intent

`POST /api/tron/sponsorship/payout-intents/{intentId}/transaction-preflight`

This administrator-only endpoint accepts an empty JSON object. It does not accept caller-supplied receiver, contract, amount, fee, sponsor address, or transaction fields; those values are loaded from the immutable intent. The store revalidates that:

- the intent is still unexpired and has both independently recorded sponsor-owner message approvals;
- both sponsor organization/account/budget links still match their approved identities and roles;
- both original principal and fee budget reservations remain active with the exact amounts recorded on the intent;
- the original token contract remains on the current network-scoped allowlist.

The preflight then builds an unsigned TRX or TRC-20 transaction draft, verifies its sender, receiver, contract, transfer calldata and exact amount, simulates the TRC-20 transfer where applicable, and reads current principal/fee sponsor resource snapshots plus the exact fee-to-principal delegation pair. It estimates the signed transaction byte size using one 65-byte signature, estimates current Energy/Bandwidth shortfall and compares the resulting estimated network fee with the intent's fee cap.

The endpoint is read-only: it does not change the intent, consume a sponsor approval, sign, submit, broadcast, delegate resources, or modify reservations. The fee sponsor's own wallet resources are never added to the principal's available resources; only resources already visible in the principal's own current node snapshot are counted. A passing estimate is still not final fee coverage: the final serialized signature size, dynamic contract energy, resource state and chain parameters can change before execution. All execution flags remain false.

## Remaining real-payout dependencies

The system still lacks an independently reviewed sponsor-controlled transaction signer/provider adapter, an audited resource-delegation funding workflow where required, controlled testnet transfer broadcast and settlement, and a complete receiver-side real exchange-deposit verification workflow. The read-only preflight is not a final execution quote or a payout authorization. Do not change the existing real-value payout hard gate. Mainnet release still requires a controlled end-to-end test, independent security review, operational runbook, and explicit release approval.

## Remaining real-payout dependencies

The implementation still lacks transaction-specific fee/Energy/Bandwidth verification for a constructed transfer, an independently reviewed sponsor-controlled transaction signer/provider adapter, controlled testnet transfer broadcast and settlement, and a complete receiver-side real deposit verification workflow. Do not change the existing real-value payout hard gate. Mainnet release still requires a controlled end-to-end test, independent security review, operational runbook, and explicit release approval.

## Independent owner approval page

The standalone frontend route `#/sponsor-authorization` is intentionally outside the platform administrator's owner-password gate so each external sponsor organization can open it directly. It does not receive or require `SPONSOR_ADMIN_API_TOKEN`. Each sponsor owner must connect the wallet that matches the exact verified account/role stored in the approved budget link.

The page performs two separate wallet message-signature steps. The server-generated sponsor message identifies the sponsor legal name as well as its organization/account IDs, wallet, role and full transfer allocation. A valid signature demonstrates control of the linked address only; it does not independently prove that the signer is a director, employee or legally authorized agent of the sponsor organization. That authority remains a mandatory administrator evidence-review responsibility.
1. A normal `/api/auth/tron` wallet-identity challenge creates a short-lived network/origin-scoped wallet session. This proves wallet control only.
2. The session is used to request a short-lived role-specific payout-intent challenge. The wallet signs the server-generated message that includes the immutable intent digest, both sponsor budget-link IDs, network, receiver, asset/contract, principal amount and fee cap. The backend consumes the nonce once, recovers the signer address with TronWeb, and requires an exact match to the verified sponsor account.

The backend stores the SHA-256 hash of the signature plus the challenge/message digests, not the raw wallet message signature. The raw session token is held only in memory by the page and is not written to browser storage. A wrong wallet, wrong network, inactive sponsor link, expired intent, replayed challenge or already-approved role is rejected. Each role is approved independently by the wallet that controls that role's exact verified account. One organization may therefore provide both approvals only through its separately verified principal and fee accounts; the same wallet cannot approve both roles.

When both roles have signed, the intent status becomes `sponsor_authorization_complete`. This means only that both role-specific message signatures were validated. It is **not** a transaction signature, exact fee quote, resource sufficiency proof, authorization for the backend to broadcast, or a completed payout. The two internal budget holds still expire and can be cancelled. All submission flags remain false and the existing Mainnet real-value payout hard gate remains disabled.
