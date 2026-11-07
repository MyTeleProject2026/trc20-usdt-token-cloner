# Stage 7C — private document custody, malware scanning and testnet verification

## What is implemented on this feature branch

- `server/sponsor-document-custody.mjs` validates PDF/JPEG/PNG magic bytes, size bounds and media types.
- The upload route authenticates the sponsor wallet before parsing a bounded raw request body.
- The backend sends the file to a configured ClamAV daemon using the INSTREAM protocol. It first requests the daemon VERSION and checks it against the server-pinned version prefix. Timeout, unavailable scanner, version mismatch, malformed response or malware detection fails closed.
- A file is sent to the vault only after a clean ClamAV response.
- The backend uploads to a fixed HTTPS vault API base whose hostname must exactly match the server-side allowlist. User requests cannot supply a URL, hostname or object key.
- The vault must return an HMAC-authenticated receipt binding the generated object key, SHA-256, byte size, encryption-at-rest confirmation, retention policy and immutable version ID.
- The evidence metadata row and a separate append-only malware scan attestation are inserted only after scan success and vault receipt verification.
- Legacy metadata-only evidence references remain pending and cannot be reviewed or satisfy the two-role quorum.
- Reviewer and emergency security-officer registries require explicit version labels and SHA-256 pins. Duplicate wallet addresses are rejected, both reviewer roles must be present, and security-officer addresses must be distinct from reviewers.
- A registry helper validates configuration and prints digest pins without printing wallet addresses or writing configuration.
- A separate Nile verification script permits only a read-only GET to the exact `https://nile.trongrid.io` origin. It does not sign, broadcast or contact Mainnet.

## Private vault gateway contract

The implementation uses a provider-neutral gateway contract because no named or provisioned vault provider was present in the repository. The gateway must be an independently operated service on an approved HTTPS hostname.

Request:

- `PUT /v1/objects/{server-generated-object-key}`
- `Authorization: Bearer <vault API token>`
- `Content-Type: application/pdf | image/jpeg | image/png`
- `X-Content-SHA256: <lowercase SHA-256>`
- `X-Encryption-Required: true`
- `X-Retention-Policy-Reference: <approved retention reference>`
- `X-Malware-Scan-Status: clean`
- `X-Malware-Scanner: clamav-instream`

The gateway must enforce private access, encryption at rest, retention policy and immutable object versions. It must not make objects public.

Successful JSON response fields:

- `stored: true`
- `objectKey` (exact requested key)
- `contentSha256` (exact uploaded digest)
- `byteSize` (exact uploaded byte count)
- `encryptedAtRest: true`
- `retentionPolicyReference` (exact requested value)
- `versionId` (non-empty immutable vault version)
- `receiptSignature` (hex HMAC-SHA256)

The HMAC is calculated over compact JSON with exactly this property order:
`stored, objectKey, contentSha256, byteSize, encryptedAtRest, retentionPolicyReference, versionId`.
The shared receipt key must be held by the gateway and backend in their respective secret managers. The backend verifies the HMAC using a timing-safe comparison. A successful HTTP response without a valid receipt is rejected.

The backend does not currently implement a vendor-specific vault. A compatible gateway must be built or selected, security-reviewed, and deployed before uploads can succeed.

## ClamAV deployment contract

Required server configuration:

- `SPONSOR_ORG_CLAMAV_HOST`: private-network DNS name reachable only by the backend.
- `SPONSOR_ORG_CLAMAV_ALLOWED_HOSTS`: comma-separated exact ClamAV host allowlist.
- `SPONSOR_ORG_CLAMAV_PORT`: normally 3310.
- `SPONSOR_ORG_CLAMAV_VERSION`: expected version prefix, for example `ClamAV 1.4.2`.
- `SPONSOR_ORG_CLAMAV_TIMEOUT_MS`: bounded timeout from 1000 to 60000 ms.

The backend sends the ClamAV `VERSION` and `INSTREAM` commands. Network ACLs must restrict the daemon to the backend service; do not expose unauthenticated ClamAV TCP publicly. The version string is checked against the daemon response before each scan. Signature database freshness and daemon patching remain operational responsibilities.

## Required environment variables

Vault gateway:

- `SPONSOR_ORG_VAULT_API_BASE`: HTTPS base URL, no user information, query or fragment.
- `SPONSOR_ORG_VAULT_ALLOWED_HOSTS`: comma-separated exact hostname allowlist.
- `SPONSOR_ORG_VAULT_API_TOKEN`: bearer credential, at least 32 characters.
- `SPONSOR_ORG_VAULT_RECEIPT_HMAC_SECRET`: independent HMAC receipt key, at least 32 characters.

ClamAV:

- `SPONSOR_ORG_CLAMAV_HOST`
- `SPONSOR_ORG_CLAMAV_ALLOWED_HOSTS`
- `SPONSOR_ORG_CLAMAV_PORT`
- `SPONSOR_ORG_CLAMAV_VERSION`
- `SPONSOR_ORG_CLAMAV_TIMEOUT_MS`

Trusted registries:

- `SPONSOR_ORG_REVIEWER_REGISTRY`: JSON array with at least one `compliance-reviewer` and one `security-reviewer`, each `{walletAddress, role, active:true}`.
- `SPONSOR_ORG_REVIEWER_REGISTRY_VERSION`: operator-managed version label.
- `SPONSOR_ORG_REVIEWER_REGISTRY_SHA256`: digest pin generated by `npm run sponsor:registry:check`.
- `SPONSOR_ORG_SECURITY_OFFICERS`: JSON array of one or more `{walletAddress, active:true}` entries. These addresses must not overlap reviewer addresses.
- `SPONSOR_ORG_SECURITY_OFFICERS_VERSION`: operator-managed version label.
- `SPONSOR_ORG_SECURITY_OFFICERS_SHA256`: digest pin generated by `npm run sponsor:registry:check`.

Only public wallet addresses and role metadata belong in registry JSON. Never put seed phrases, private keys, wallet passwords, vault tokens or HMAC keys in these arrays. Provision values through the organization's approved secrets/configuration process. There is no API endpoint to edit trusted registries.

Registry JSON is canonicalized by wallet address before hashing. Any edit, role change, address change or active-state change requires a new version label and new digest pin. Missing pins, duplicate addresses, missing reviewer roles or overlapping security/reviewer identities fail closed.

## Commands

- `npm run sponsor:registry:check`: validate the JSON registries and print their digest pins. It does not update environment configuration.
- `SPONSOR_GOVERNANCE_VERIFICATION_NETWORK=nile SPONSOR_GOVERNANCE_TESTNET_NODE_URL=https://nile.trongrid.io npm run sponsor:testnet:check`: perform a read-only Nile latest-block request.

The Nile script refuses Mainnet, non-HTTPS URLs, alternate hosts, paths, credentials and query strings. It only performs `GET /wallet/getnowblock`. It does not test a production wallet session, upload a real document, mutate the database or submit a transaction.

## Verification boundary and outstanding deployment work

Automated tests exercise MIME validation, ClamAV protocol/version handling, scan-before-upload ordering, HMAC receipt validation, registry pins, and the Nile-only GET guard. CI is required to verify these tests on the latest branch head.

No actual vault vendor/gateway, Clamd service, secret-manager values, trusted reviewer addresses, security-officer addresses or Nile node credentials are provisioned by this code change. Therefore a successful test suite does not mean the live custody services are operational.

The upload route is still under the existing Mainnet wallet-session authentication model; the separate Nile check is read-only and does not switch governance authorization to testnet. The reference migration is updated but is not applied to any live database.

No Render configuration changes, production database writes, deployment, real-money signer integration, payout execution, transaction signing or fund transfer are included. Sandbox balances do not count as Mainnet funding. Every governance response continues to report `payoutAuthorized: false`.
