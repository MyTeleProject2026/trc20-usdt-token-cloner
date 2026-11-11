# Private Treasury Vault — read-only observation API and signed receipt v1

## Status

This is a provider-independent **read-only observation contract** and local verification library. It is not a custody-provider integration, funding source, credit facility, withdrawal API, reservation writer, or payout executor.

Implementation:
- `server/private-treasury-vault-observation.mjs`
- `tests/private-treasury-vault-observation.test.mjs`

The HTTP client performs one authenticated HTTPS GET only when a future caller explicitly invokes it. It requires an exact allowlisted origin and rejects redirects. This repository change does not configure an origin, credential, trust key, route, provider account, database mutation, or live network request. The client and verifier are not mounted into an owner route in this stage.

## Read-only gateway API

### Request

```http
GET /v1/vaults/{vaultId}/observations/latest
Authorization: Bearer <gateway-read-token>
Accept: application/json
Cache-Control: no-store
```

Requirements:
- HTTPS only.
- Exact origin allowlist; no wildcard host, userinfo, query, fragment, or non-root base path.
- Server-side bearer token only. Never place credentials in frontend code, logs, receipt payloads, or source control.
- Redirects are rejected. Request timeout is bounded (1–15 seconds).
- This endpoint must be read-only. It must not create reservations, alter balances, request signatures, initiate transfers, or broadcast transactions.
- The gateway must obtain the observation from its authoritative custody ledger and reconcile the wallet/account with solidified TRON Mainnet state. The receipt must not merely repeat caller-supplied values.

### Response envelope

The response is exactly `{ "payload": { ... }, "signature": { ... } }`. Unknown top-level envelope or payload fields are rejected to prevent unsigned extension fields and schema confusion.

```json
{
  "payload": {
    "schema": "tron-transfer.private-treasury-vault-observation.v1",
    "issuer": "configured-vault-gateway-issuer",
    "audience": "tron-transfer-private-treasury",
    "receiptId": "globally-unique-receipt-id",
    "observationId": "globally-unique-observation-id",
    "vaultId": "configured-vault-id",
    "network": "TRON_MAINNET",
    "treasuryAddress": "T...",
    "issuedAtMs": 1800000000000,
    "observedAtMs": 1799999999000,
    "expiresAtMs": 1800000030000,
    "chain": {
      "blockNumber": 99000000,
      "blockId": "64-character-solidified-block-id-hex",
      "finality": "solidified"
    },
    "assets": {
      "usdt": {
        "contract": "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        "decimals": 6,
        "balanceBaseUnits": "2500000000",
        "reservedBaseUnits": "500000000",
        "availableBaseUnits": "2000000000"
      },
      "trx": {
        "balanceSun": "9000000",
        "reservedSun": "1000000",
        "availableSun": "8000000"
      }
    },
    "resources": {
      "freeBandwidthLimit": "1500",
      "freeBandwidthUsed": "200",
      "stakedBandwidthLimit": "1200",
      "stakedBandwidthUsed": "300",
      "energyLimit": "5000",
      "energyUsed": "1000"
    },
    "reservation": {
      "sequence": 42,
      "snapshotId": "globally-unique-reservation-snapshot-id"
    }
  },
  "signature": {
    "algorithm": "Ed25519",
    "keyId": "vault-observation-ed25519-01",
    "value": "base64url-encoded-64-byte-signature"
  }
}
```

The example is a schema illustration, not a real balance, account, receipt, or funding attestation.

## Cryptographic signing and trust

- Sign the UTF-8 bytes of the canonical JSON serialization of **payload only**. The signature object is outside the signed payload.
- Canonicalization recursively sorts object keys lexicographically; preserves array order; accepts only JSON primitives, arrays, and plain objects; and accepts only safe-integer JSON numbers. Monetary and resource quantities are decimal integer strings, never floating-point numbers.
- Use Ed25519. The signature is canonical base64url and exactly 64 decoded bytes.
- `keyId` resolves to a separately configured, pinned trust-registry entry containing the Ed25519 public key, issuer, allowed audience list, active status, and validity interval.
- Revoked key IDs are rejected even if an older registry snapshot still lists them as active. The trust/revocation snapshot must be current (maximum age 60 seconds for this verifier).
- Rotation procedure: publish the new public key and its validity window before use; overlap old/new keys only for a bounded transition; stop issuing with the old key; publish its revocation; and ensure verifiers refresh the pinned trust/revocation snapshot. Never accept a key merely because it is embedded in a receipt.
- The financial-vault keys are a separate trust domain from the Stage 7C document-custody and malware-scanner keys. Do not reuse those registries or keys.

## Required validation

The verifier binds the receipt to the expected issuer, audience, vault ID, exact TRON address, TRON Mainnet, and official six-decimal USDT contract. It checks:
- Ed25519 signature and trusted, active, non-revoked issuer key;
- fresh trust-registry/revocation snapshot;
- observation age (at most 60 seconds), issue time, expiry, and receipt lifetime (at most 60 seconds);
- solidified block number and 32-byte block ID;
- canonical integer strings and exact USDT/TRX balance minus reservation arithmetic;
- available USDT not below the platform's **1,000 USDT** minimum (1,000,000,000 base units);
- Energy and Bandwidth observations;
- unique receipt and observation IDs against caller-supplied prior-seen state;
- reservation sequence and snapshot identifier.

The verifier returns only a verified observation record with `payoutAuthorized: false`. It does not independently query a TRON node to prove the signed block anchor; the gateway is responsible for source acquisition and the consumer must retain the block metadata for independent observation/reconciliation.

## Replay and reservation consistency

The verifier requires the caller to supply the current set/list of already-seen receipt and observation IDs. It rejects known IDs. This read-only module does not write that set and does not claim atomic replay prevention under concurrent consumers.

Before any future state-changing ledger consumer could rely on an observation, it would need a durable, atomic compare-and-set/unique constraint on both IDs, and monotonic reservation sequence handling in the same database transaction as the reservation decision. A stale or lower reservation sequence must never overwrite a newer one. Ambiguous withdrawals must remain reserved until independently reconciled. Those database operations are intentionally not implemented by this read-only stage.

## Explicitly out of scope

- No provider-specific custody SDK, account creation, credit facility, or funding arrangement.
- No Fincra payout source, Fireblocks dependency, or individual sponsor.
- No document-vault receipt reuse as financial evidence.
- No funding-ledger credit, reservation mutation, withdrawal request, or authorization decision.
- No private-key import, signer contact, signature request, transaction creation, signing, or broadcast.
- No production route mount, environment changes, database migration, deployment, or transfer.

A cryptographically authentic observation proves only that a trusted issuer signed the stated observation. It does not by itself prove legal ownership, unrestricted spendability, availability of credit, authority to spend, or an enforceable commitment to fund withdrawals. Real withdrawals remain impossible without a genuinely funded and independently authorized vault arrangement.
