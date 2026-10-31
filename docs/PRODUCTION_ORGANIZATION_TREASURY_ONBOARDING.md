# Production organization and treasury onboarding (no Fireblocks account yet)

## Status and hard safety boundary

This runbook is preparatory. It does not create a Fireblocks account, verify a legal entity, establish custody, fund a wallet, or authorize a payout. The application must remain in read-only/preflight mode until every gate below is independently evidenced and approved.

Never put Fireblocks API secrets, private keys, recovery material, signing shares, or wallet credentials in GitHub, issue comments, chat, application logs, or frontend environment variables. Configure secrets only in the backend secret manager/Render environment after an authorized account exists.

## Gate 0 — jurisdiction and business legality (must happen first)

Before applying to a custodian or accepting, holding, transferring, or arranging customer crypto:

1. Identify the actual operating entity, place of incorporation, management/control location, customers' locations, and every jurisdiction in which the service will be offered.
2. Obtain written advice from qualified local financial-regulatory counsel on whether the proposed activities amount to custody, exchange, transfer, payment, brokerage, money transmission, or another regulated activity; identify licensing/registration, AML/CFT, sanctions, consumer-protection, tax, data-protection, and reporting obligations.
3. Ask Fireblocks directly whether the actual entity, beneficial owners, operating locations, and intended business model are eligible for onboarding and the requested products. Do not assume a foreign incorporation changes where the service is actually operated or avoids local rules.
4. Do not use another person's/company's account, a nominee, false address, VPN, or inaccurate business description to bypass eligibility or regulatory checks.
5. If counsel or the provider cannot confirm lawful eligibility, stop the production custody/payout plan. Continue only non-custodial development, testnet work, or a lawful alternative approved by counsel.

**Myanmar-specific caution:** A 2022 Financial Intelligence Consultative Group paper hosted by Myanmar's Financial Intelligence Unit states that Myanmar did not allow VASPs and cryptocurrencies at that time. This is not a current legal opinion and may not reflect later notices or the exact facts of this project. Because the operator may be located in Myanmar, obtain current Myanmar legal advice and written regulator/provider clarification before proceeding. Do not infer that using an overseas entity or hosting provider makes the activity lawful.

## Gate 1 — organization onboarding pack

Prepare accurate, current documents for the real contracting entity. Fireblocks determines its own due-diligence checklist; expect to be asked for some or all of:

- Incorporation/registration certificate and current company registry extract.
- Registered office, principal place of business, operating locations, website, and business description.
- Constitutional documents and evidence the entity is active and in good standing.
- Directors, senior officers, authorized signatories, and ultimate beneficial owners, including ownership/control chart and identity/address evidence.
- Board resolution or equivalent authority approving the Fireblocks relationship, custody model, named administrators/signers, and treasury use.
- Source-of-funds/source-of-wealth evidence and explanation of expected asset origins, counterparties, volumes, and transaction purpose.
- AML/CFT, sanctions, customer due-diligence, transaction monitoring, wallet screening, Travel Rule (where applicable), complaints, incident response, and record-retention policies.
- Legal opinion/licensing/registration evidence where required; tax and accounting treatment.
- A clear description of whether funds are company-owned treasury funds or customer assets. Do not mix the two or describe customer funds as company treasury.

Submit only through Fireblocks' official onboarding channel. Never send identity documents or sensitive company records to this repository.

## Gate 2 — custody and treasury design

Choose and document one legal/funds-flow model before creating wallets:

- **Company-owned treasury:** the entity owns the USDT/TRX and pays only its own obligations or legally approved grants. It must not be represented as customer deposits.
- **Third-party sponsor model:** one or more external legal organizations may independently own and authorize their contributions under written agreements. A single organization may cover both the USDT principal and network fees only through separately registered and verified `asset-principal` and `network-fee` accounts, distinct wallet addresses, distinct budgets and budget links, and separate role-specific approvals. Its agreement and mandate must expressly cover both roles, including principal, network costs, destination policy, limits, and settlement. Alternatively, two different organizations may cover the two roles. Never treat one wallet, one budget, or one signature as authorization for both roles.
- **Customer custody/omnibus model:** holding customer assets or paying out on their behalf can create materially different licensing, safeguarding, reconciliation, insolvency, and governance obligations. Do not enable this model without legal approval and a specifically designed custody ledger and controls.

For every approved sponsor/treasury, record legal owner, source of funds, asset ownership, wallet control, permitted purpose, limits, fee responsibility, refund/failed-payment handling, reconciliation owner, and termination process.

## Gate 3 — Fireblocks workspace and access (only after Gates 0–2)

1. Contact Fireblocks through its official website and request a business/institutional consultation. Confirm eligibility, supported product, TRON production support, pricing, service terms, and the correct production onboarding path in writing.
2. Use the entity's own verified corporate domain and authorized representatives. Keep workspace ownership with the legal entity, not an individual developer.
3. Establish named human administrators, independent transaction approvers, and a separately governed API user. Apply least privilege; do not give an application API identity unrestricted console administration or signing authority.
4. Enable strong authentication, hardware-backed authentication where available, backup/recovery procedures, user offboarding, and documented emergency revocation.
5. Configure transaction policies: approved TRON network, allowed asset IDs, recipient allowlist, per-transaction and daily limits, approval thresholds, velocity controls, and a deny-by-default policy for unrecognized destinations.
6. Confirm whether API transaction creation requires additional human approval/signers under the actual workspace policy. A successful API response is not evidence that a transaction was signed, broadcast, or settled.

Useful official starting points:
- Fireblocks business accounts: https://www.fireblocks.com/products/business-accounts
- Request a Fireblocks demo/contact: https://www.fireblocks.com/
- Fireblocks capabilities (vaults, policies, API users and transactions): https://fireblocks.readme.io/docs/capabilities
- Fireblocks API reference: https://api-reference.fireblocks.com/

## Gate 4 — TRON vault and asset verification

Only an authorized workspace administrator should create the production vault and activate the required asset wallets.

- Create separately named production vault accounts for the approved funds-flow model; do not reuse a developer/test vault.
- Retrieve supported asset IDs from that exact workspace/API environment. Never guess or hardcode an asset ID based on a ticker.
- Verify TRON Mainnet and the exact USDT TRC-20 contract against trusted official sources. The commonly used TRON USDT contract is TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t; still verify the contract and asset mapping in the actual Fireblocks workspace before enabling anything.
- Record and independently verify the vault's TRON address. Confirm the organization controls it through the provider's supported verification process.
- Fund only from a lawful, documented source. Confirm actual USDT principal and enough TRX or approved delegated Energy/Bandwidth resources for the planned transaction volume. A PostgreSQL budget reservation is not an on-chain lock or proof of funds.
- Reconcile Fireblocks balances with solidified TRON chain data and accounting records. Treat pending deposits, unconfirmed transactions, and stale snapshots as unavailable.

Fireblocks confirms support for TRX and TRC-20 assets on TRON, but asset availability and asset IDs must be checked in the workspace:
- https://www.fireblocks.com/blog/tron-x-fireblocks
- https://www.fireblocks.com/supported-assets
- https://fireblocks.readme.io/docs/object-model

## Gate 5 — application integration and controlled validation

After the organization has an approved production workspace, complete these steps without exposing secrets:

1. Create a dedicated backend API user with only the permissions required for read-only vault/balance/fee checks and transaction creation under restrictive policy. Keep signing and approvals controlled by the organization's designated signers.
2. Store API key ID and private-key material only in Render's encrypted secret/environment configuration for the backend service. Never place them in Vite/frontend variables, APK assets, logs, or source control. Rotate/revoke immediately if exposed.
3. Verify the API base URL/environment, workspace, vault ID, TRON asset IDs, source address, destination allowlist and policy independently. Keep test and production credentials separate.
4. Run read-only health checks first: authentication, workspace identity, vault identity, supported asset lookup, balances, and fee/resource estimate. Redact secrets and sensitive identifiers in logs.
5. Complete testnet end-to-end tests with test assets and a controlled receiver. Verify signer/approver workflow, idempotency, duplicate-submit handling, failure recovery, timeout reconciliation, and exact TRC-20 Transfer event matching.
6. Conduct a security review, threat model, access review, and independent legal/compliance sign-off.
7. Only after explicit written authorization from the organization and a separately approved production change may a tiny, controlled Mainnet test be considered. Confirm the exact amount, source vault, destination, token contract, fees, and transaction ID with the authorized operator before submission. Do not enable broad customer payouts based on a successful test.

## Required evidence before any Mainnet payout gate can be considered

- Current legal opinion and required licences/registrations for each relevant jurisdiction.
- Fireblocks written eligibility/onboarding approval and executed service agreement.
- Verified legal entity, UBOs, board authorization, and source-of-funds file.
- Approved custody/funds-flow model and sponsor agreements.
- Named signers/approvers, tested recovery, least-privilege API identity, and restrictive transaction policy.
- Verified production TRON vault, exact workspace asset IDs, and independently reconciled genuine USDT/TRX/resource balances.
- Passing testnet and security review, idempotency/reconciliation evidence, operational runbooks, and monitoring/incident procedures.
- Explicit change approval, controlled Mainnet test evidence, and receiver/exchange deposit policy checks.

Until then, keep all production submission/broadcast flags false. The application must never claim that an internal reservation, displayed balance, API preflight, or unconfirmed transaction is a completed payment.
