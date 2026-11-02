# Fireblocks organization, TRON vault, and API-user setup

This runbook is for the **authorized adult representative, treasurer, or security administrator of the real legal organization** that will own and control the treasury. Do not create an organization using false details, borrow another person's account, or bypass Fireblocks' eligibility and compliance checks. Fireblocks must approve and activate the production workspace before it can hold or move production assets.

Tron Token Studio cannot create or approve a Fireblocks organization, open a custody account, issue an API key, create a provider vault, or fund a vault. Those actions belong to the organization and Fireblocks. This repository supplies the integration after those independent steps are complete.

## 1. Establish the organization workspace

1. The organization's authorized adult representative should contact Fireblocks through its official website and request the product/workspace suitable for the organization's legitimate treasury use.
2. Follow the onboarding, eligibility, legal-entity, identity, compliance, contractual, and jurisdictional requirements that Fireblocks gives that organization. The exact requirements and availability are determined by Fireblocks; do not invent entity details or use another organization's identity.
3. Confirm that the workspace is a **production** workspace, not a sandbox/test workspace. Confirm the workspace owner/admin, recovery contacts, user approval quorum, and transaction policy owners.
4. Keep organization-level ownership separate from the application API user. The app must not be the workspace owner and must not receive unrestricted administrator rights.

Official Fireblocks starting points:
- [Fireblocks Quickstart](https://fireblocks.readme.io/docs/quickstart)
- [Manage API access](https://fireblocks.readme.io/docs/manage-api-keys)
- [Fireblocks user roles and workspace security](https://fireblocks.readme.io/docs/manage-users)

## 2. Create the production TRON treasury vault

In the approved production workspace, the organization's authorized vault administrator should:

1. Create a dedicated Vault Account for the organization's TRON treasury. Record its numeric Vault Account ID.
2. Confirm that TRON Mainnet is available and enabled for the workspace.
3. Add/enable the native TRX asset and the **official TRON USDT TRC-20** asset in that workspace. Fireblocks supports TRON and TRC-20 assets, but token availability can depend on the asset and workspace. Use the asset list/metadata returned by Fireblocks; never assume an asset ID from an example or a symbol alone.
4. Verify USDT metadata identifies the exact official Mainnet contract:
   - Network: TRON Mainnet
   - Contract: `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`
   - Decimals: 6
   - Symbol: USDT
5. Verify the other configured asset is native TRX, not a TRC-20 token that happens to use a TRX-like label. The application expects six decimals and native-asset metadata.
6. Generate/view the TRON deposit address for both vault assets. Confirm the address shown by Fireblocks is the address the organization intends to configure as `TREASURY_ADDRESS`. This application deliberately fails closed unless the provider returns exactly one address for each configured asset and both match that same configured treasury address.
7. Record the actual vault ID, the exact provider asset IDs, the TRON address, and the regional API origin from the approved workspace. Do not put credentials in this record.

Fireblocks references:
- [Fireblocks and TRON](https://www.fireblocks.com/blog/tron-x-fireblocks)
- [Add TRC-20 and other tokens to a workspace](https://fireblocks.readme.io/docs/add-your-tokens-1)
- [Get supported assets](https://fireblocks.readme.io/docs/list-supported-assets-1)
- [Create Vault Accounts](https://fireblocks.readme.io/reference/create-vault-account)
- [Fireblocks object model](https://fireblocks.readme.io/docs/object-model)

## 2A. Automatic, read-only configuration discovery

After the organization has created a dedicated read-only Fireblocks API user and installed its separate API-authentication RSA key as a backend-only secret file, the owner console can query:

`GET /api/treasury/fireblocks/discovery`

The endpoint is owner-session authenticated and read-only. It uses only the dedicated `FIREBLOCKS_READONLY_API_KEY` / `FIREBLOCKS_READONLY_SECRET_KEY_PATH` identity, which must differ from the payout identity, and calls only vault, asset-catalogue and address-read methods:
- enumerate paginated Vault Accounts;
- query Fireblocks' supported asset catalog for USDT and TRX;
- accept USDT only when provider contract metadata matches the official TRON Mainnet Tether contract;
- accept TRX only when provider metadata identifies the native six-decimal TRX asset;
- compare each candidate vault's active assets and, for a bounded number of candidates, read both asset-address lists;
- suggest vault ID, asset IDs and the common TRON address only when the result is unambiguous.

The owner console refreshes this discovery snapshot with the other backend status data. The backend caches successful discovery results briefly to avoid repeatedly calling Fireblocks while the dashboard polls.

**Discovery is not configuration activation.** The endpoint does not select a vault, write Render environment variables, create or activate assets, move balances, approve a sponsor agreement, or enable transfers. If several matching vaults or asset pairs exist, the endpoint reports candidates but does not choose one. The organization must review and approve the exact source vault and agreement scope. The existing payout readiness checks and sponsor release signature still bind the final vault ID, asset IDs, treasury address, contract, limits and recipient policy.

The read-only API key and mounted RSA authentication file cannot be auto-created by this application; they must be issued by Fireblocks to the authorized sponsor organization. The read-only client exposes no transaction-submission or fee-estimate methods. The endpoint does not return the API key, secret-file path, RSA key, private key or signing material to the frontend.

The discovery endpoint prefers each asset's Fireblocks `legacyId` (API ID) when the catalogue returns both a newer asset UUID and a legacy identifier. Fireblocks' current List Assets API reference says to continue using the legacy ID until all services support the newer UUID. If an asset response has no valid legacy ID, treat the identifier as unconfirmed and do not manually substitute a different-looking ID.

Reference: [Fireblocks List Assets API](https://fireblocks.readme.io/reference/listassets).

## 3. Fund the vault only through the organization's approved treasury process

Funding is a real asset movement, not an application setting. The organization's authorized treasury staff must use its approved source of funds and its own independent controls to fund the Fireblocks TRON address with genuine official USDT and enough native TRX to cover the configured fee reserve. Verify the network and address in the Fireblocks Console before any deposit; do not rely on an address copied from chat or an unverified UI.

The application compares Fireblocks' available balance with the public TRON chain balance. A provider balance alone or a public-chain balance alone is insufficient. The app does not mint, manufacture, borrow, or display synthetic USDT.

## 4. Create separate Fireblocks API users/keys

Create two API users in the same approved workspace, with two independently generated RSA-4096 key pairs and separate secret files:

- **Discovery identity:** Viewer/read-only permissions sufficient for vault-account enumeration, asset-catalogue reads and vault address reads. It must not have transaction-initiation or signing permissions. Configure `FIREBLOCKS_READONLY_API_KEY`, `FIREBLOCKS_READONLY_SECRET_KEY_PATH` and optionally `FIREBLOCKS_READONLY_API_BASE`.
- **Payout identity:** the minimum transaction-capable role Fireblocks confirms is required for fee estimation, transaction initiation and status lookup. Keep Fireblocks policy approvals and human quorum enabled. Configure the existing `FIREBLOCKS_API_KEY`, `FIREBLOCKS_SECRET_KEY_PATH` and `FIREBLOCKS_API_BASE`.

The application rejects a read-only identity that reuses the payout API key or RSA secret-file path. Do not use one API user for both roles.

The API key is an identifier for an API user. Its matching RSA private key is a **Fireblocks API-authentication credential**, not a TRON wallet private key and not the key that directly signs blockchain transfers. Keep the API private key secret and keep Fireblocks' custody signing controls inside Fireblocks.

Generate the key pair and CSR in the organization's secured administrative environment, not in this chat, the repository, an APK, or a shared device. Fireblocks' current API-key guide specifies RSA 4096. Example command (replace the organization label with the real legal organization name):

```sh
umask 077
openssl req -new -newkey rsa:4096 -nodes \
  -keyout fireblocks_api_private_key.pem \
  -out fireblocks.csr \
  -subj '/O=Your Legal Organization Name'
```

- Keep `fireblocks_api_private_key.pem` in the organization's restricted secret store. Do not email it, paste it into ChatGPT, or commit it.
- Upload only `fireblocks.csr` to Fireblocks when creating the API user; the CSR contains the public-key request, not the private key.
- In Fireblocks Console, open **Developer Center → API Users → Add API user**, give it a clear service identity, select the least-privileged role that can perform the exact read, fee-estimate, transfer-initiation, and transaction-status operations used by this app, and upload the CSR.
- For transaction initiation, Fireblocks documents a Signer role for API users that need transaction-signing capability. Do not grant the app an Owner or broad Admin role merely to make an error disappear. Ask the workspace administrator/Fireblocks support to confirm the minimum role and permissions for the enabled API endpoints.
- Keep Fireblocks transaction policies and human approval quorums enabled. Restrict the API user to the dedicated vault and intended TRON assets, use destination allowlists where supported, enforce provider-side amount/velocity limits, and require independent approvals appropriate to the organization's risk controls.
- Complete any required API-user approval quorum. Then copy the API key/ID from the API Users page. The private key remains only with the organization.

Fireblocks references:
- [Manage API keys](https://fireblocks.readme.io/docs/manage-api-keys)
- [Quickstart: create a CSR/API user](https://fireblocks.readme.io/docs/quickstart)
- [Define approval quorums](https://fireblocks.readme.io/docs/define-approval-quorums)
- [Set transaction policies](https://fireblocks.readme.io/docs/set-policies)

## 5. Install the API credentials on the existing Render backend

The current backend service is the Node web service linked to this repository. Use its Render Dashboard → **Environment** page.

1. Under **Secret Files**, add two separate files: `fireblocks_readonly_api_private_key.pem` and `fireblocks_payout_api_private_key.pem`. Each must match its own Fireblocks API user CSR. Render makes service secret files available at `/etc/secrets/<filename>`.
2. Add the following variables to the backend service (not the frontend/static site and never as `VITE_*` variables):

| Variable | Value to obtain from the approved Fireblocks workspace |
|---|---|
| `FIREBLOCKS_READONLY_API_KEY` | Dedicated Viewer/read-only API user ID for discovery |
| `FIREBLOCKS_READONLY_SECRET_KEY_PATH` | `/etc/secrets/fireblocks_readonly_api_private_key.pem` |
| `FIREBLOCKS_READONLY_API_BASE` | Production regional API origin for the read-only identity |
| `FIREBLOCKS_API_KEY` | Separate transaction-capable payout API user ID shown in Fireblocks |
| `FIREBLOCKS_SECRET_KEY_PATH` | `/etc/secrets/fireblocks_payout_api_private_key.pem` |
| `FIREBLOCKS_API_BASE` | The exact production regional API origin shown/confirmed for the workspace; leave unset for the documented default if appropriate |
| `FIREBLOCKS_VAULT_ACCOUNT_ID` | Numeric ID of the dedicated TRON treasury Vault Account |
| `FIREBLOCKS_USDT_ASSET_ID` | Exact asset ID for the official TRON USDT token in that workspace |
| `FIREBLOCKS_TRX_ASSET_ID` | Exact asset ID for native TRX in that workspace |
| `TREASURY_ADDRESS` | Exact TRON address returned by the configured Fireblocks vault assets |
| `TREASURY_SPONSOR_ORGANIZATION_REFERENCE` | Sponsor organization's real legal/contract reference, matching the signed agreement |
| `TREASURY_SPONSOR_AGREEMENT_REFERENCE` | Exact signed agreement reference, also present in the approved agreement scope |
| `TREASURY_SPONSOR_TOTAL_BUDGET_USDT` | Maximum USDT principal commitment expressly authorized by the sponsor |
| `TREASURY_MAX_PAYOUT_USDT` / `TREASURY_DAILY_LIMIT_USDT` | Per-transfer and daily caps that do not exceed the sponsor's signed commitment |
| `TREASURY_FEE_LIMIT_SUN` | Conservative native-TRX fee reserve threshold in SUN |
| `TREASURY_ALLOWED_RECIPIENT_ADDRESSES` | Optional static comma-separated recipient allowlist; alternatively use sponsor-signed recipient approvals |
| `TREASURY_SPONSOR_APPROVER_ADDRESSES` | Required: 1–20 independent public TRON addresses controlled by the sponsor; any one signer can approve/revoke the release (1-of-N), even when a static recipient allowlist is used |
| `TREASURY_WITHDRAWALS_ENABLED` | Keep `false` during setup; set `true` only for the approved sponsor-release workflow |
| `TREASURY_REAL_VALUE_EXECUTION_ENABLED` | Keep `false` during setup; a sponsor signature is still mandatory when set `true` |
| `TREASURY_REAL_VALUE_RELEASE_REFERENCE` | Unique release authorization reference for the approved scope |
| `TREASURY_REAL_VALUE_RELEASE_EXPIRES_AT` | Future Unix-millisecond expiry, no more than 30 days ahead |

The existing application also needs `OWNER_WALLET_ADDRESS` and `TREASURY_OWNER_ADDRESS` set to the same public owner address, `DATABASE_URL`, `FRONTEND_ORIGIN`, and the exact `SPONSOR_APPROVED_AGREEMENT_REFERENCES` scope. The official USDT contract is fixed in the application; do not set a replacement contract. Do not overwrite unrelated Render variables while adding these values.

Render reference: [Environment variables and secret files](https://render.com/docs/configure-environment-variables).

## 6. Read-only validation and staged Mainnet release

During initial setup and read-only validation, keep all execution flags set to the literal string `false`:

- `TREASURY_WITHDRAWALS_ENABLED=false`
- `TREASURY_REAL_VALUE_EXECUTION_ENABLED=false`
- `TREASURY_TRX_WITHDRAWALS_ENABLED=false`

After the secret file and non-secret identifiers are configured and the service redeploys:

1. Run `npm run check:env` in a trusted project environment. It reports configuration status, not secret values. A syntactic pass does not prove Fireblocks access, workspace ownership, asset identity, balances, policy authorization, or settlement.
2. Sign in to the owner console with the configured owner wallet and call the owner-authenticated read-only endpoints:
   - `GET /api/treasury/withdrawals/readiness`
   - `GET /api/treasury/trx-withdrawals/readiness`
3. Confirm that the Fireblocks API authentication works, the USDT contract metadata is exact, native TRX metadata is correct, both asset addresses match `TREASURY_ADDRESS`, balances are independently visible on Fireblocks and TRON, the database is ready, and the fee reserve is covered.
4. Confirm that the sponsor agreement is genuinely signed and its exact Mainnet USDT scope is present in `SPONSOR_APPROVED_AGREEMENT_REFERENCES`. Configure `TREASURY_SPONSOR_ORGANIZATION_REFERENCE`, `TREASURY_SPONSOR_AGREEMENT_REFERENCE`, `TREASURY_SPONSOR_TOTAL_BUDGET_USDT`, payout caps, and either a static `TREASURY_ALLOWED_RECIPIENT_ADDRESSES` list or independent sponsor-controlled `TREASURY_SPONSOR_APPROVER_ADDRESSES`.
5. Set a unique `TREASURY_REAL_VALUE_RELEASE_REFERENCE` and `TREASURY_REAL_VALUE_RELEASE_EXPIRES_AT` (Unix milliseconds, no more than 30 days in the future). The release signature binds these values and the current vault/asset/limit/recipient-policy scope.
6. Only after all read-only provider/chain checks pass, the real sponsor controls the signer allowlist and Fireblocks transaction policy, and the organization has approved the release, set `TREASURY_WITHDRAWALS_ENABLED=true` and `TREASURY_REAL_VALUE_EXECUTION_ENABLED=true`. These two switches allow the console to prepare the exact sponsor release message and submit the sponsor's public message signature. **They do not activate execution by themselves.** The backend continues to return `executionEnabled: false` until a valid, unexpired sponsor signature is stored and re-verified against the configured independent signer.
7. Keep `TREASURY_TRX_WITHDRAWALS_ENABLED=false`; native-TRX payout execution is a separate, disabled route and is not part of this Mainnet USDT release.
8. Save sanitized evidence only. Never publish API IDs together with secrets, private keys, full account identifiers, or confidential organization details.

If any configuration bound into the release message changes, or the sponsor release expires or is revoked, execution must return to disabled until a new release reference/expiry is configured and the sponsor signs the new canonical message. If any provider, database, balance, fee-reserve, or agreement check fails, do not bypass it or treat a successful read-only response as permission to spend.

## 7. Separate provider approval from application authorization

A real payout requires all of the following independently:

- An eligible, approved production workspace and organization-owned TRON vault.
- A dedicated API user with least privilege and correct provider-side approvals.
- Fireblocks transaction policy that authorizes the exact source vault, asset and external destination.
- The app's authenticated owner session plus a fresh signature authorizing the exact recipient, amount, treasury, origin, idempotency key and expiry.
- Real official USDT principal and real TRX fee capacity.
- Database reservations, per-transfer/daily limits, replay protection, emergency stop and reconciliation.
- A controlled, independently reviewed test transaction and a verified solidified TRON receipt/event before production release.

A Fireblocks API key does not itself authorize a payout or override transaction policy. A provider transaction ID is not proof that funds arrived. The application must remain disabled until the organization has completed and documented its independent authorization and security review.

## 8. What this project cannot do on the operator's behalf

This repository cannot obtain Fireblocks customer approval, perform legal-entity verification, accept provider terms, create an organization's custody relationship, issue an API key, create or administer a vault, fund assets, choose approvers, or approve the organization's transaction policy. The linked Render service cannot see or extract the API private key for you. The organization must complete those actions in its own authorized Fireblocks and Render accounts.

Never send `fireblocks_api_private_key.pem`, an API key, wallet seed phrase, blockchain private key, password, or authentication token in this chat. If a secret is exposed, revoke/rotate it through the provider immediately.
