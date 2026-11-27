# TRON Transfer Owner Admin — target architecture and migration status

**Repository:** `MyTeleProject2026/trc20-usdt-token-cloner`  
**Production branch:** `ui/modern-crypto-dashboard-theme`  
**Frontend:** existing Render Static Site `tron-transfer`  
**Resource API:** existing Render Web Service `tron-transfer-resource-api`  
**Network:** TRON Mainnet only  
**Token:** existing custom TRC-20 `TRӾ`; contract behavior and address must not be changed by this authentication/signing project.

This document is the current source-of-truth architecture handoff. It distinguishes verified source-code facts, changes committed in this work, and work that is not yet implemented or accepted in production.

## 1. Product requirement — one platform authentication

The operator wants one Owner Admin email/password sign-in to authorize the whole Tron Transfer application:

- One application login/session.
- Both Owner and Sponsor workspaces open without separate workspace login.
- No repeated wallet connect, local vault unlock, or separate wallet password for normal operation.
- Existing Owner and Sponsor addresses, balances, on-chain permissions, roles and operation scopes remain independent.
- The Owner Admin session is the application-level authorization identity; it does not merge the two on-chain wallets.
- Each write still requires a clear review of the exact transaction and an explicit final confirmation in the Owner Admin UI.
- The application then signs through protected server-side custody and broadcasts on TRON Mainnet.
- The fee is paid by the wallet that is the actual transaction owner/payer, unless a separately verified protocol-level mechanism explicitly says otherwise. Never silently redirect fees.
- No hidden, unattended or blanket signing. An authenticated session is not itself consent to an arbitrary transaction.

The intended user experience is a single application authorization with role-aware actions. The Owner Admin interface must make clear whether an action spends Owner assets, Sponsor assets, changes Owner contract state, or delegates Sponsor resources.

## 2. Current implementation found in source (before KMS migration)

The production branch currently contains a role-separated local-signing architecture:

- Owner and Sponsor have separate account identities and wallet addresses.
- Owner login can create a paired Sponsor session group when the configured Sponsor identity is enrolled and matches.
- The API issues separate Owner and Sponsor session cookies/CSRF proofs under the shared session group.
- Sponsor API administration is authorized by the Owner Admin session for protected administrative controls; Sponsor transaction execution still requires the Sponsor session and local Sponsor signature.
- Owner transaction routes authenticate the Owner managed-wallet session and expect a locally signed transaction.
- Sponsor transaction routes authenticate the Sponsor managed-wallet session and expect a locally signed transaction.
- Signer acceptance endpoints verify local key control; they do not sign or broadcast transactions.
- The browser currently uses separate encrypted Owner and Sponsor vaults/device keys. The current managed identity report labels custody as `encrypted-local-owner-vault` and `encrypted-local-sponsor-vault`.
- Owner and Sponsor operation ledgers persist prepared/signed operation state and transaction IDs. Sponsor execution has pause, idempotency, persistence-before-broadcast and receipt reconciliation controls.
- Owner operations verify transaction intent, signer address and active TRON permission before broadcast.
- Existing TRON Mainnet read-provider policy and broadcast controls must be preserved.
- Current backend signing routes do not yet call AWS KMS. There is no completed server-side KMS signing path in this branch as of the commit recorded in the handoff.

A paired application session is not the same thing as having migrated the signing keys. Do not represent the current paired sessions as full platform signing authority.

## 3. Target architecture — application authorization + KMS-backed signing

### 3.1 Application authentication

1. Owner Admin signs in once.
2. The server establishes one secure application session, protected by secure HttpOnly cookies, CSRF protection, origin checks, session expiry, revocation and audit events.
3. Server-side authorization maps the authenticated Owner Admin to the permitted Owner and Sponsor identities.
4. Workspace switching is a UI context change, not a second authentication ceremony.
5. Role/account selection is explicit in every transaction review. The backend derives the allowed signer identity from server-side configuration and the operation type; it never trusts a browser-supplied signer address alone.

The target is one login, not one merged wallet or one all-powerful unscoped token. Owner and Sponsor permissions remain least-privilege and operation-specific.

### 3.2 KMS custody and identity preservation

Use two independent AWS KMS asymmetric signing keys, one per existing TRON wallet:

- Key spec: `ECC_SECG_P256K1`.
- Key usage: `SIGN_VERIFY`.
- Origin: `EXTERNAL` when importing existing key material, subject to AWS KMS import requirements.
- Import the existing Owner private key into the Owner KMS key and the existing Sponsor private key into the Sponsor KMS key.
- Verify each KMS public key derives to the exact existing TRON Mainnet address before enabling any signing.
- Never generate replacement wallet keys as a shortcut: that would change the wallet addresses and would not preserve existing balances, contract ownership or Sponsor delegations.
- The two KMS key ARNs must be distinct. IAM must grant the Render backend role only the required `kms:DescribeKey`, `kms:GetPublicKey` and `kms:Sign` access to those exact keys; no broad account-wide KMS signing permission.
- Keep offline, encrypted recovery material for each imported private key under a separately controlled recovery procedure. KMS imported asymmetric key material is permanently associated with its KMS key; it cannot be replaced with a different key material set. Loss/expiry/deletion can make the KMS key unusable. Recovery must be rehearsed before production cutover.
- Never put private keys, seed phrases, KMS import plaintext, AWS access keys or credentials in source code, browser storage, GitHub, build logs, or ordinary Render environment variables.
- Prefer Render-to-AWS short-lived workload identity/federation if supported by the deployment setup. If that is not available, use a dedicated tightly scoped AWS role credential delivery mechanism with rotation; do not use a long-lived administrator key.

AWS documentation confirms that KMS supports imported asymmetric secp256k1 key material and the `ECC_SECG_P256K1` key spec. The KMS signing API returns an ECDSA signature representation; TRON transactions require the 65-byte recoverable signature form. The backend adapter must correctly derive/validate the recovery byte, normalize signature values as required, and verify the resulting signature against the expected existing wallet public key and transaction digest. This cryptographic conversion is a mandatory implementation/test gate, not an assumption.

References:
- [AWS KMS — importing key material](https://docs.aws.amazon.com/kms/latest/developerguide/importing-keys.html)
- [AWS KMS — requirements for imported asymmetric key material](https://docs.aws.amazon.com/kms/latest/developerguide/importing-keys-conceptual.html)
- [AWS KMS — asymmetric key specifications](https://docs.aws.amazon.com/kms/latest/APIReference/API_CreateKey.html)

### 3.3 Transaction flow

For every existing write operation:

1. UI asks the Resource API to prepare the exact unsigned Mainnet transaction.
2. API validates Owner Admin session, CSRF/origin, account role, configured wallet identity, operation permission, amount/recipient/contract intent, current on-chain permission, resource preflight, feeLimit and zero-TRX-burn policy.
3. API persists a durable prepared operation with idempotency key and exact unsigned transaction digest/intent.
4. UI presents a transaction review showing network, signer wallet, recipient/contract, method, amount, fee-limit ceiling, resource estimates and warnings.
5. Operator explicitly confirms that exact operation.
6. Backend reloads the durable prepared record; it does not accept arbitrary transaction bytes or an arbitrary KMS key ARN from the browser.
7. Backend re-runs freshness, expiry, intent, permission, balance and resource checks.
8. Backend selects the fixed KMS key from the server-side role mapping and signs only the transaction digest.
9. Backend converts the KMS ECDSA signature into a valid TRON recoverable signature, verifies it locally against the expected wallet address, and checks transaction ID/raw data are unchanged.
10. Backend persists the signed transaction and transaction ID before broadcast.
11. Backend performs one controlled broadcast attempt through the configured TRON Mainnet broadcast path.
12. Backend reconciles ambiguous responses against solidified Mainnet state. It must never silently sign a replacement transaction while the original transaction outcome is unknown.
13. UI displays prepared, awaiting confirmation, signed, broadcast, confirmed/solidified, failed or broadcast-unknown state from durable ledger/on-chain evidence.

Owner and Sponsor operations use the same application login and review experience but separate KMS key ARNs and signer identities.

### 3.4 Emergency controls

- Owner Admin can pause all writes globally.
- Sponsor writes retain their existing dedicated pause control.
- Revoking the Owner Admin session immediately prevents new signing requests.
- KMS IAM access can be disabled/revoked independently.
- Per-role KMS key disablement must stop signing for only that wallet.
- Every signing request, rejection, confirmation, KMS key ID, digest, transaction ID, broadcast attempt and reconciliation outcome is audited. Never log private material or credentials.
- Rate limits, replay protection, idempotency, strict request schemas and CSRF/origin checks remain mandatory.

## 4. Important migration constraints

- Existing Owner and Sponsor wallet addresses must not change.
- Importing keys into KMS is a custody migration, not a wallet rotation.
- A KMS key created with AWS-generated key material will have a different public key/address. Do not use it for the existing wallet identity.
- AWS KMS supports imported `ECC_SECG_P256K1` asymmetric signing material, but this does not by itself complete TRON integration. The 65-byte recoverable signature conversion and address recovery must be implemented and tested.
- Existing local vaults must remain available as a controlled rollback/recovery path until KMS signing is independently accepted. Do not delete local vault data as part of the first KMS release.
- No KMS signing should be enabled until both existing wallet public keys/addresses are independently verified, test vectors pass, the IAM policy is reviewed, and production acceptance is signed off.
- KMS migration must not modify the TRӾ Solidity contract, contract address, token supply, balances, Owner permissions, Sponsor delegations or any existing on-chain state.

## 5. Current branch changes recorded for this work

On `ui/modern-crypto-dashboard-theme`:

- The Sponsor runtime error caused by a missing `setOwnerAdminCsrfToken` React state setter was repaired in `Frontend-Tron-Transfer/src/SponsorWalletManager.jsx`.
- A regression assertion was added in `Frontend-Tron-Transfer/tests/sponsor-workspace-runtime.test.mjs`.
- The repair was committed directly to the existing branch. The latest source commit recorded in the continuation handoff is `ebff578ebfb7502a6fa45e0dfd4a95cd7bfcd14a`.
- CI/frontend workflow status must be checked again before calling this fix deployed or accepted.
- No Mainnet transaction was signed or broadcast by this repair.
- No KMS integration has been activated, no AWS key imported, and no production signing credentials configured by this work.
- The previous local-vault and local-signing implementation remains active until a verified KMS migration is completed.

## 6. Remaining implementation stages

### Stage A — AWS account and key custody preparation
- Confirm the AWS account, region, KMS administration owner and workload identity approach.
- Export/prepare existing Owner and Sponsor secp256k1 key material through a secure offline procedure; do not transmit secrets in chat or GitHub.
- Create two `ECC_SECG_P256K1`, `SIGN_VERIFY`, `EXTERNAL` KMS keys.
- Import the corresponding existing private key material independently.
- Verify both KMS public keys against the exact existing TRON addresses.
- Define IAM policy, key policy, CloudTrail audit, alarms, backup/restore and emergency disable procedures.

### Stage B — tested TRON KMS signing adapter
- Add AWS SDK KMS client to Resource API.
- Implement role-to-key mapping exclusively from server configuration.
- Implement deterministic transaction digest validation and KMS ECDSA signing.
- Convert DER ECDSA signatures to TRON's 65-byte recoverable signature, including low-S handling and recovery-id derivation.
- Verify signature recovery yields the configured Owner or Sponsor address.
- Add known-answer, malformed signature, wrong-key, wrong-digest, wrong-role, KMS timeout, duplicate request and unavailable-key tests.
- Default to disabled and fail closed when KMS configuration or verification is incomplete.

### Stage C — one Owner Admin authorization
- Consolidate frontend session state to one Owner Admin authentication context.
- Keep role-aware Owner/Sponsor authorization server-side.
- Remove separate Sponsor login and local vault unlock from ordinary workspace navigation after server-side session pairing is accepted.
- Do not weaken CSRF, origin, session revocation, password verification or authorization boundaries.
- Add tests proving one Owner login can open both workspaces but cannot invoke a disallowed role/operation.

### Stage D — backend signing integration
- Integrate KMS signing into Owner operation confirmation, TRӾ deployment, Sponsor operation execution, native TRX transfers, resource delegation/undelegation and every other existing signed transaction path.
- Remove browser-supplied signed-transaction requirement only after equivalent server-side transaction-intent verification and explicit confirmation are implemented.
- Keep exact prepared transaction persistence, signer/permission checks, idempotency, persistence-before-broadcast and solidified receipt reconciliation.
- Prove no write endpoint can select an arbitrary KMS key or bypass the confirmation gate.

### Stage E — frontend redesign and end-to-end acceptance
- Redesign the existing application only; do not add trading, conversion, exchange deposits or other nonexistent business features.
- Give each existing Owner and Sponsor tab its own consistent exchange-style page layout, navigation, details, forms, review, confirmation, loading, error, empty and success states.
- Apply consistent sidebar, top menu, mobile navigation, page hierarchy, tables, cards, typography, spacing, dark graphite/gold palette and responsive behavior.
- Ensure each button calls the existing real operation handler and reflects backend/ledger state. No decorative fake-live controls.
- Browser-test every existing tab and nested action on mobile and desktop.
- Verify Owner login, Sponsor workspace access, refresh/reopen session behavior, logout/revocation, both signer identities, operation confirmations, Mainnet resource gates, transaction persistence, broadcast and solidified receipts.

### Stage F — production cutover
- Backup and restore-test Neon production database; verify exact database identity.
- Configure AWS IAM/KMS and Render service environment through secure dashboard/secret mechanisms, never source files.
- Run read-only signer acceptance and KMS address verification first.
- Keep all write gates disabled until security review and full acceptance pass.
- Enable one operation family at a time, starting with a low-risk controlled Mainnet operation only after explicit operator approval and sufficient resources.
- Keep rollback to local vault signer until KMS path and recovery are proven.
- Confirm both existing Render services are healthy and running the exact approved production commit.
- Do not claim production-ready based only on CI or an HTTP uptime probe.

## 7. Release invariants — never violate

1. TRON Mainnet only; no testnet transaction path.
2. Preserve the existing Owner and Sponsor addresses.
3. Preserve the existing TRӾ contract and all existing on-chain state.
4. Never store private keys, mnemonics, passwords or AWS credentials in Git or browser storage.
5. Never accept a client-selected KMS key ARN or signer role without server-side authorization.
6. Never broadcast without an explicit confirmation tied to the exact persisted transaction intent.
7. Never bypass Energy/Bandwidth/fee-limit preflight or zero-TRX-burn protection.
8. Never claim a transaction succeeded without solidified Mainnet evidence.
9. Never automatically retry/re-sign a transaction whose broadcast outcome is unknown.
10. Keep Owner and Sponsor signing keys, addresses, balances and permissions independent.
11. Keep local vault recovery available until KMS migration and rollback are proven.
12. No new app, repository, production service, branch or pull request is required for the requested direct production-branch work.

## 8. Current readiness summary

| Area | Status |
|---|---|
| One Owner Admin application login | Partially present via paired session group; full single-auth UX not accepted |
| Owner/Sponsor separate on-chain identities | Existing architecture present |
| Owner/Sponsor browser-local encrypted vaults | Existing implementation; target is to retire after KMS acceptance |
| Server-side KMS signing | Not implemented |
| Existing wallet key import into KMS | Not performed |
| KMS-to-TRON recoverable signature adapter | Not implemented |
| All transaction paths routed through KMS | Not implemented |
| Explicit confirmation and operation ledgers | Existing safeguards present; must be retained and integrated |
| Sponsor missing-CSRF-setter runtime fix | Committed; CI/deployment acceptance must be checked |
| Complete exchange-style page-by-page redesign | Not complete |
| Full browser acceptance on every page | Not complete |
| Mainnet KMS signing acceptance | Blocked |
| Production KMS cutover | Blocked |

**The application must not be described as fully migrated, fully server-signed, or production-ready until Stages A–F have been completed and accepted.**
