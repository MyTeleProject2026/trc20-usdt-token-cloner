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

## 3. Fund the vault only through the organization's approved treasury process

Funding is a real asset movement, not an application setting. The organization's authorized treasury staff must use its approved source of funds and its own independent controls to fund the Fireblocks TRON address with genuine official USDT and enough native TRX to cover the configured fee reserve. Verify the network and address in the Fireblocks Console before any deposit; do not rely on an address copied from chat or an unverified UI.

The application compares Fireblocks' available balance with the public TRON chain balance. A provider balance alone or a public-chain balance alone is insufficient. The app does not mint, manufacture, borrow, or display synthetic USDT.

## 4. Create a dedicated Fireblocks API user/key

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

1. Under **Secret Files**, add a file named `fireblocks_api_private_key.pem` and paste the contents of the RSA private-key file there. Render makes service secret files available at `/etc/secrets/<filename>`.
2. Add the following variables to the backend service (not the frontend/static site and never as `VITE_*` variables):

| Variable | Value to obtain from the approved Fireblocks workspace |
|---|---|
| `FIREBLOCKS_API_KEY` | The API user ID shown in Fireblocks |
| `FIREBLOCKS_SECRET_KEY_PATH` | `/etc/secrets/fireblocks_api_private_key.pem` |
| `FIREBLOCKS_API_BASE` | The exact production regional API origin shown/confirmed for the workspace; leave unset for the documented default if appropriate |
| `FIREBLOCKS_VAULT_ACCOUNT_ID` | Numeric ID of the dedicated TRON treasury Vault Account |
| `FIREBLOCKS_USDT_ASSET_ID` | Exact asset ID for the official TRON USDT token in that workspace |
| `FIREBLOCKS_TRX_ASSET_ID` | Exact asset ID for native TRX in that workspace |
| `TREASURY_ADDRESS` | Exact TRON address returned by the configured Fireblocks vault assets |

The existing application also needs its normal owner identity, PostgreSQL, and payout-limit configuration as documented in [TREASURY_WITHDRAWALS.md](TREASURY_WITHDRAWALS.md). Do not overwrite unrelated Render variables while adding these values.

Render reference: [Environment variables and secret files](https://render.com/docs/configure-environment-variables).

## 6. Read-only validation before any payout

Keep both flags set to the literal string `false`:

- `TREASURY_WITHDRAWALS_ENABLED=false`
- `TREASURY_TRX_WITHDRAWALS_ENABLED=false`

After the secret file and non-secret identifiers are configured and the service redeploys:

1. Run `npm run check:env` in a trusted project environment. It reports configuration status, not secret values. A syntactic pass does not prove Fireblocks access, workspace ownership, asset identity, balances, policy authorization, or settlement.
2. Sign in to the owner console with the configured owner wallet and call the owner-authenticated read-only endpoints:
   - `GET /api/treasury/withdrawals/readiness`
   - `GET /api/treasury/trx-withdrawals/readiness`
3. Confirm that the Fireblocks API authentication works, the USDT contract metadata is exact, native TRX metadata is correct, both asset addresses match `TREASURY_ADDRESS`, balances are independently visible on Fireblocks and TRON, the database is ready, and the fee reserve is covered.
4. Save sanitized evidence only. Never publish API IDs together with secrets, private keys, full account identifiers, or confidential organization details.

Readiness must not be bypassed by turning on a payout flag. If a check fails, fix the actual provider configuration or contact Fireblocks support; do not spoof a response.

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
