# Stage 7C — independently attested scanning and Ed25519 private-vault receipts

## Implemented on the feature branch

- The evidence upload route requires an authenticated sponsor wallet session and an existing mandate owned by that same wallet.
- The backend validates PDF/JPEG/PNG content signatures and a 20 MiB size limit.
- The backend sends the exact file bytes to a separately configured scanner service. The scanner returns a signed Ed25519 attestation binding a unique attestation ID, SHA-256, byte size, CLEAN result, scanner identity/version and scan timestamp.
- The backend verifies the attestation against a pinned scanner public-key registry and checks that its hash, size, scanner identity and freshness match the exact uploaded bytes.
- Only after scanner attestation verification does the backend upload the file to the fixed HTTPS vault gateway using a generated object key.
- The vault must return a signed Ed25519 receipt binding issuer, audience, organization, receipt ID, issue time, object key, immutable object version, content digest, byte size, media type, encryption mode, retention policy/expiry and the independently signed scanner attestation.
- The backend validates the receipt using a separate pinned vault receipt public-key registry. Vault and scanner key material must be distinct.
- Initial acceptance requires a receipt issued within ten minutes and a scan attestation no older than five minutes. Historical governance reads reverify the stored signatures and immutable receipt data without applying the initial-upload freshness window.
- The backend persists the full signed receipt, receipt key ID, object version, retention/encryption metadata, full scanner attestation and scanner key ID. Evidence metadata, scan attestations, reviewer decisions and revocation events are append-only.
- Every later evidence-set/quorum check re-verifies the Ed25519 receipt and the separately persisted scanner attestation, and compares their signed fields to the denormalized database metadata. Missing, revoked, altered, substituted or inconsistent records fail closed.
- The old metadata-only evidence reference endpoint remains available for migration, but those records do not have a signed receipt or scan attestation and cannot satisfy quorum.

## API integration contract

The backend calls the following separately operated services:

### Independent scanner

`POST /v1/scans`

- HTTPS origin and hostname must be configured by the server.
- Bearer token is stored only in server-side secrets/configuration.
- Request body is the raw document; headers bind the organization, mandate, MIME type, byte size and SHA-256.
- Response: `{ "attestation": <Ed25519-signed scan attestation> }`.

The scanner must actually inspect the exact uploaded bytes. It must not return CLEAN based on a request header or caller-provided assertion.

Attestation schema:

- `schema: tron-transfer.malware-scan-attestation.v1`
- `attestationId`
- `contentSha256`
- `byteSize`
- `result: CLEAN | INFECTED | ERROR`
- `completed: true`
- `scanner`, `scannerVersion`, `scannedAt`
- `signature: { algorithm: Ed25519, keyId, value }`

### Private vault gateway

`PUT /v2/objects/{server-generated-object-key}`

Headers:

- Bearer service token.
- Content-Type, Content-Length, SHA-256 and organization ID.
- Retention policy reference.
- Base64url JSON in `X-Scan-Attestation`, which is the verified scanner response, not a boolean claim.

Successful response:

`{ "receipt": <Ed25519-signed private-vault receipt v2> }`

The receipt payload schema is `tron-transfer.private-vault-receipt.v2`. It binds:

- issuer, audience, receipt ID, organization ID and issuedAt;
- object key, immutable provider version ID, SHA-256, size and media type;
- storage provider `aws-s3`;
- `SSE-KMS` encryption, verified flag and non-secret key reference;
- S3 Object Lock retention mode (`GOVERNANCE` or `COMPLIANCE`), policy reference and retainUntil;
- malware scan verified flag, CLEAN result, scanner identity/version/time and the exact scanner-signed attestation;
- Ed25519 receipt signature and key ID.

The gateway must not sign a receipt simply because S3 returned HTTP success. Before signing, the gateway implementation must independently read back the exact object version and verify its actual checksum/version, encryption configuration, Object Lock mode and retention expiry. The gateway must also verify the scanner signature and bind that exact attestation to the exact object digest. The application verifies the gateway signature and claims; it does not directly query AWS S3 in this implementation.

## Trusted Ed25519 key registries

Vault receipt and scanner attestation keys are separate trust domains. Public-key registries are server-only configuration, versioned and pinned by SHA-256. The configuration parser enforces Ed25519 key type, bounded key count, active key presence, and rejects overlapping vault/scanner key material.

Vault receipt keys:

- `SPONSOR_ORG_VAULT_RECEIPT_PUBLIC_KEYS`: JSON object keyed by key ID with `{ "active": true, "publicKeyPem": "..." }`.
- `SPONSOR_ORG_VAULT_RECEIPT_KEYS_VERSION`
- `SPONSOR_ORG_VAULT_RECEIPT_KEYS_SHA256`

Scanner attestation keys:

- `SPONSOR_ORG_SCANNER_ATTESTATION_PUBLIC_KEYS`: JSON object keyed by key ID with `{ "active": true, "publicKeyPem": "..." }`.
- `SPONSOR_ORG_SCANNER_ATTESTATION_KEYS_VERSION`
- `SPONSOR_ORG_SCANNER_ATTESTATION_KEYS_SHA256`

The command `npm run sponsor:vault-keys:check` validates the public-key registries and prints digest pins and counts without printing public-key material or writing configuration. The corresponding private signing keys must remain in separate service-controlled KMS/HSM/key managers and must never be placed in Git, Render environment variables, or the Tron Transfer frontend.

Existing reviewer and security officer registries remain separate and continue to use `npm run sponsor:registry:check`.

## Required service configuration

Scanner service:

- `SPONSOR_ORG_SCANNER_ATTESTATION_API_BASE`
- `SPONSOR_ORG_SCANNER_ATTESTATION_ALLOWED_HOSTS`
- `SPONSOR_ORG_SCANNER_ATTESTATION_API_TOKEN`
- `SPONSOR_ORG_SCANNER_NAME`
- `SPONSOR_ORG_SCANNER_VERSION_PREFIX`

Vault gateway:

- `SPONSOR_ORG_VAULT_API_BASE`
- `SPONSOR_ORG_VAULT_ALLOWED_HOSTS`
- `SPONSOR_ORG_VAULT_API_TOKEN`
- `SPONSOR_ORG_VAULT_RECEIPT_ISSUER`
- `SPONSOR_ORG_VAULT_MIN_RETENTION_DAYS`
- `SPONSOR_ORG_VAULT_RECEIPT_PUBLIC_KEYS`
- `SPONSOR_ORG_VAULT_RECEIPT_KEYS_VERSION`
- `SPONSOR_ORG_VAULT_RECEIPT_KEYS_SHA256`

Scanner signing public keys:

- `SPONSOR_ORG_SCANNER_ATTESTATION_PUBLIC_KEYS`
- `SPONSOR_ORG_SCANNER_ATTESTATION_KEYS_VERSION`
- `SPONSOR_ORG_SCANNER_ATTESTATION_KEYS_SHA256`

Origins must be HTTPS and exactly host-allowlisted. Service tokens are required and must be at least 32 characters. No secret values are provisioned by this feature branch.

## Database and migration

The evidence table stores the exact signed receipt JSON, receipt key ID, receipt ID, object version, retention, encryption mode and scan metadata. The malware scan attestation table stores the exact scanner-signed attestation JSON, key ID, digest, scanner version and scan time.

The runtime route creates/adds the governance columns when its persistence endpoints are invoked and the existing organization application/mandate tables are present. The reference migration at `server/migrations/20261107_sponsor_organization_governance_stage7.sql` mirrors the schema and append-only triggers. It has not been applied to Render or any live database.

## Production acceptance requirements not satisfied by code alone

- A real scanner service must be independently deployed, patched, authenticated and configured.
- A real private-vault gateway must be built/deployed and independently reviewed. It must implement the S3 read-after-write property checks specified above before signing.
- The S3 bucket, versioning, Object Lock policy, KMS key, access policy, audit trail, backup/retention and deletion controls must be approved by the organization and verified by the gateway.
- Trust public keys and corresponding service private keys must be provisioned by their actual service owners and reviewed. No keys are generated or provisioned by this code change.
- The organization must approve retention duration and retention mode; Compliance-mode retention can be irreversible until expiry.
- Human reviewers must still inspect source evidence and independently establish legal identity, authority, source of funds and provider account ownership. A cryptographic file receipt proves custody/integrity claims, not the truth of a document or KYB approval.

## Security and deployment boundary

- Missing service configuration, invalid trust pins, invalid/expired signatures, scanner errors, scan staleness, object mismatch, inadequate retention, invalid encryption claims or persisted metadata mismatch fail closed.
- V2 custody is not a signer or payout authorization.
- Governance quorum remains separate from payout permission.
- Mainnet sponsor-direct broadcasting is hard-disabled on this supervised feature branch. The treasury Fireblocks withdrawal route has its own hard-coded execution-disabled guard.
- No Render configuration, external provider account, vault, scanner, trust key, production database or deployment is changed by this work.
- No transaction is signed or broadcast; no funds are transferred. Sandbox balances remain non-spendable and do not qualify as Mainnet funding.
