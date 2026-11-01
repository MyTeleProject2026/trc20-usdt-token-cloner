# Third-party funding authorization and deposit verification

## Status and purpose

This is a preparation and verification control for the Option A funding architecture: an authorized third-party organization manually deposits genuine TRON assets into its approved Fireblocks treasury vault.

The repository cannot obtain another party's consent, establish their legal authority, create a Fireblocks organization, create a vault, or move funds. The feature added with this document verifies a narrowly scoped TRON wallet message signature. It does not replace the written funding agreement or Fireblocks' custody and approval controls.

**The known external source address remains unauthorized until its legitimate owner and the relevant organization have completed the separate authorization process. Do not treat a public balance or watch-only access as permission to use funds.**

## Required separation of roles

- **Owner identity wallet:** signs into the private Tron Token Studio console. It may have zero USDT and zero TRX if used only for off-chain authentication.
- **Third-party source wallet:** controlled by the authorized funding organization. Its owner may sign the scoped consent message and later manually initiate an incoming deposit. Tron Token Studio never receives its private key.
- **Fireblocks treasury vault:** created and controlled by the authorized organization in an approved Fireblocks production workspace. Its real TRON address is configured as `TREASURY_ADDRESS`. This—not the third-party source address—is the source for any later Fireblocks payout.
- **External withdrawal recipient:** the exchange or wallet receiving a later payout. It is not the source wallet or the vault.

## Stage 1 — obtain the actual agreement first

Before requesting a wallet signature, the parties must execute a separate written agreement through their authorized representatives. It should establish at least:

1. The actual legal entities and the authority of each signatory.
2. The source of funds and the source wallet controlled by the funding organization.
3. The named Fireblocks organization and the exact production vault receiving the deposit.
4. Whether the contribution is a grant, loan, advance, service arrangement or another legally reviewed category.
5. Whether and how the Fireblocks-held funds may be used for later customer/recipient withdrawals. Any such mandate must expressly permit external exchange/wallet payouts and specify the permitted purpose, principal, recipients or destination policy, fees, term and approval authority.
6. Maximum principal, maximum fee funding, permitted network and token contract, time period, recipient policy and approval authority.
7. Reconciliation, reporting, fees, disputes, sanctions/compliance responsibilities, revocation and return-of-funds terms.

The manifest's `agreementReference` identifies the separately retained agreement. New v2 authorizations also include `agreementDocumentSha256`, the SHA-256 fingerprint of the exact final executed file bytes. This lets the source wallet signature bind to one exact agreement version without uploading the confidential document. The hash does not establish authenticity, signatory authority, source of funds or legal enforceability; those still require independent organizational and legal review.

## Stage 2 — create and verify the real Fireblocks destination

The authorized organization's Fireblocks administrator must independently:

1. Establish an eligible, approved production workspace.
2. Create a dedicated TRON Mainnet Vault Account.
3. Activate native TRX and the official TRON USDT TRC-20 asset.
4. Verify the USDT contract is exactly `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` and that both assets resolve to the intended vault deposit address.
5. Configure the organization's own transaction policy, independent approvers, destination controls and risk limits.
6. Provide the non-secret vault ID, actual asset IDs and exact vault address to the authorized integration operator through a controlled channel.

The organization must set `TREASURY_ADDRESS` to the actual Fireblocks vault address. Never set it to the third-party source address just because that address displays a balance.

## Stage 3 — fingerprint the executed agreement and create the signed consent manifest

Keep the executed agreement in the organization's controlled document storage. Do not commit or upload it to GitHub or ChatGPT. From the project root, calculate the fingerprint locally:

```bash
npm run funding:agreement:hash -- ./executed-agreement.pdf
```

The command reads a regular local file of up to 50 MiB and prints its lowercase SHA-256 digest and byte count. It does not transmit or store the document. If the agreement is amended or replaced, calculate a new digest and obtain a new source-wallet signature.

Create a local JSON manifest, kept outside Git, using the v2 format:

```json
{
  "format": "tron-token-studio/third-party-funding-authorization/v2",
  "authorizationId": "funding-consent-2026-001",
  "network": "mainnet",
  "sponsorAddress": "SOURCE_WALLET_CONTROLLED_BY_AUTHORIZED_ORG",
  "vaultAddress": "ACTUAL_FIREBLOCKS_TRON_VAULT_ADDRESS",
  "usdtContract": "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  "maxUsdtBaseUnits": "25000000",
  "maxTrxSun": "8000000",
  "agreementReference": "ORG-AGREEMENT-2026-001",
  "agreementDocumentSha256": "64_CHARACTER_LOWERCASE_SHA256_FROM_LOCAL_HASH_COMMAND",
  "issuedAt": "2026-11-01T00:00:00.000Z",
  "expiresAt": "2026-11-04T00:00:00.000Z",
  "signature": "ADD_SIGNATURE_AFTER_THE_SOURCE_WALLET_OWNER_SIGNS"
}
```

The example limits mean at most 25 USDT (25,000,000 base units at six decimals) and 8 TRX (8,000,000 SUN at six decimals). They are examples only. The real organization must choose the limits that match its separately approved agreement.

The signed text includes the agreement's SHA-256 fingerprint. To print the exact text to present to the source wallet owner:

```bash
TREASURY_ADDRESS=ACTUAL_FIREBLOCKS_VAULT_ADDRESS npm run funding:authorization:message -- ./third-party-funding-authorization.json
```

The authorized wallet owner should connect their own wallet on TRON Mainnet, inspect the complete message and sign that exact text using the wallet's plaintext `signMessageV2` message-signing feature. For TronLink, the browser-side signing call is:

```js
const signature = await window.tron.tronWeb.trx.signMessageV2(message)
```

This is an off-chain message signature, not an on-chain transfer. It should not require network fees. The signer must never send a seed phrase, private key, wallet password or signing secret to the application or ChatGPT. A watch-only wallet cannot create this signature.

Put the returned `0x`-prefixed 65-byte signature into the manifest's `signature` field. The signature binds the source address, destination vault, official token contract, amount caps, agreement reference, exact agreement-file fingerprint and expiry.

The manifest's validity is limited to seven days from issue time. Generate a fresh consent if it expires or any bound field changes.

## Stage 4 — verify locally

Run the verifier from the project root with `TREASURY_ADDRESS` set to the verified Fireblocks vault address:

```bash
TREASURY_ADDRESS=ACTUAL_FIREBLOCKS_VAULT_ADDRESS npm run funding:authorization:verify -- ./third-party-funding-authorization.json
```

The verifier checks:

- Canonical v2 manifest format and supported fields only.
- A required lowercase 64-character SHA-256 fingerprint of the exact executed agreement file bytes.
- Mainnet network and exact official USDT contract.
- Valid TRON Base58Check source and vault addresses.
- Source and destination are different.
- The destination exactly matches the configured `TREASURY_ADDRESS`.
- Positive integer base-unit caps, canonical timestamps and a maximum seven-day validity window.
- The recovered signer of the TIP-191/TronWeb V2 message exactly matches `sponsorAddress`.

It prints only a sanitized verification result. A successful result proves that the signer controls the source address and signed the exact, scoped consent text. It does **not** prove the signed individual is a duly authorized representative of a legal entity; that is covered by the separate agreement and organizational due diligence.

The local CLI verifier reports `payoutExecutionAuthorized: false`. It does not write to the application database or create a Fireblocks transfer.

## Stage 4B — register verified consent in the owner console

The backend provides owner-session-protected endpoints under `/api/treasury/third-party-funding`. Before registration, the service requires a recent (maximum six-hour-old) **verified** Fireblocks inventory snapshot for the exact configured vault, with all required vault, official-USDT, native-TRX, address, chain-balance and database checks passing.

After the written agreement has actually been reviewed by the operator, register the signed manifest from the authenticated owner session:

```http
POST /api/treasury/third-party-funding/authorizations
Authorization: Bearer <owner-session>
Origin: <configured-frontend-origin>
Content-Type: application/json

{
  "manifest": { "...": "the signed manifest from Stage 3" },
  "agreementReviewAcknowledged": true,
  "withdrawalDisbursementAcknowledged": true
}
```

Both acknowledgements are stored separately with the owner address and timestamp. The second acknowledgement states that the exact executed agreement expressly permits the Fireblocks-held third-party funds to be used for external recipient withdrawals. The source wallet's v2 signature binds the same agreement digest. These are auditable source-consent and operator-review evidence only; the application does not certify the legal agreement, the source-of-funds record, or the source signer's authority to represent an organization.

The persistent record retains the exact 65-byte message signature as public consent evidence, its SHA-256 digest, the canonical-message hash, and the executed-agreement document digest alongside the authorization fields. Legacy v1 records may be displayed for historical evidence but cannot be newly registered by the v2 route. A TRON message signature is not a private key, seed phrase, or transaction-signing key. The API does not return the raw signature in ordinary list/detail responses. The same authorization ID or signature hash cannot be registered with conflicting terms. The authorization detail also displays whether the disbursement-use review was recorded. Older records default to no disbursement acknowledgement and are excluded from the withdrawal funding pool until a new valid authorization is registered with the explicit review.

The owner can inspect the sanitized record at:

```http
GET /api/treasury/third-party-funding/authorizations
GET /api/treasury/third-party-funding/authorizations/<authorizationId>
```

The owner can revoke an open authorization before any further deposit is recorded:

```http
POST /api/treasury/third-party-funding/authorizations/<authorizationId>/revoke
Authorization: Bearer <owner-session>
Origin: <configured-frontend-origin>
Content-Length: 0
```

A revocation is durable and retained in the audit log. Previously recorded chain evidence is not deleted.

## Stage 5 — manually fund and independently reconcile

Only after the organization has approved the agreement and the signed consent has been registered:

1. The authorized source-wallet owner independently reviews the exact vault address in Fireblocks.
2. That owner manually sends the approved genuine USDT and/or TRX to the Fireblocks vault. The source wallet owner pays the source-side network fee.
3. For each asset, the owner operator submits the transaction hash to the chain-verification route:

```http
POST /api/treasury/third-party-funding/authorizations/<authorizationId>/deposits
Authorization: Bearer <owner-session>
Origin: <configured-frontend-origin>
Content-Type: application/json

{ "asset": "USDT", "transactionHash": "<64-hex-transaction-id>" }
```

Use `TRX` for the native TRX funding leg. The service fetches the confirmed transaction body and SolidityNode receipt itself. For USDT it verifies the TRC-20 call data and the exact official Tether `Transfer` event; for TRX it verifies the native `TransferContract`. Sender, recipient, asset, amount, success receipt and solidified block must all match the stored authorization. An unconfirmed transaction remains `awaiting-solidification` and is not persisted as a verified deposit.

Only one USDT and one TRX transaction can be recorded per authorization. Each must be within its signed cap. An unrelated or reused transaction, an unexpected source/vault, a wrong asset, a failed receipt, or an over-cap deposit is rejected.

4. After the transfer is solidified, manually run the existing **Fireblocks read-only inventory sync and config export** workflow again from the repository's Actions tab. The inventory snapshot must be newer than the deposit and must independently confirm the same Fireblocks vault, both active assets, official USDT identity, provider balances and chain balances.
5. Then reconcile the chain evidence against that newer inventory:

```http
POST /api/treasury/third-party-funding/authorizations/<authorizationId>/deposits/fireblocks-reconcile
Authorization: Bearer <owner-session>
Origin: <configured-frontend-origin>
Content-Type: application/json

{ "asset": "USDT", "transactionHash": "<same-64-hex-transaction-id>" }
```

The backend checks that the verified provider-available balance and chain balance of that asset at the same configured vault each cover the recorded deposit, and records the inventory snapshot ID and Vault Account ID. This is an asset-inventory reconciliation, not permission to spend those funds.

The authorization detail endpoint then shows the on-chain record, the disbursement review marker and whether its Fireblocks inventory evidence has been recorded. A chain-confirmed deposit without a later matching Fireblocks snapshot is still awaiting inventory reconciliation.

The owner-only `GET /api/treasury/withdrawals/readiness` endpoint reports a sponsor-funded USDT principal pool. It counts only official USDT deposits that are chain-confirmed, reconciled to the configured vault in Fireblocks, attached to a non-revoked authorization with the explicit disbursement review marker, and backed by an executed-agreement hash. It subtracts every non-rejected USDT withdrawal request against that vault, including confirmed, failed and ambiguous records, so uncertain outflows are not automatically reused. The resulting `thirdPartyFunding.availablePrincipalBaseUnits` is a conservative funding ceiling for readiness; it is not a reservation, a legal determination or payout authorization. The withdrawal route repeats the calculation inside its database transaction and locks eligible authorization/deposit rows before accepting a reservation.

**Additional release blocker — complete Fireblocks outbound history:** this branch does not yet ingest and reconcile the full Fireblocks transaction history for the dedicated vault. The current committed-withdrawal subtraction only knows this application's withdrawal ledger; it cannot detect a separate outgoing transfer created directly in the Fireblocks console or by another API client. Fireblocks exposes workspace transaction history at `GET /v1/transactions`, filterable by `sourceType=VAULT_ACCOUNT` and `sourceId=<vaultAccountId>`, with cursor-based pagination. A complete implementation must start from the vault's verified creation-time baseline, process every page and supported asset-moving operation, match application-originated transactions to the existing withdrawal ledger, and fail closed on unknown or incomplete records. Until that independent history is persisted and reconciled, the readiness endpoint returns `fireblocks-vault-outbound-history-not-reconciled` and `thirdPartyFunding.externalOutboundHistoryVerified=false`; this is intentional and must not be overridden by configuration. See the [Fireblocks transaction-history API](https://fireblocks.readme.io/reference/gettransactions).

The signed consent is not a deposit and does not make funds available. A pending or failed transfer is not funding evidence.

## What this verifier does not authorize

- It does not authorize a withdrawal, grant access to the source wallet, or import a private key.
- It does not authorize Tron Token Studio to sign or broadcast a transaction.
- It does not establish Fireblocks production access, vault ownership, API permissions or transaction policy.
- It does not prove that the vault was funded or that any exchange credited a deposit.
- It does not turn a third-party external/watch-only address into a Fireblocks source vault.
- It does not activate a payout feature flag or override the hard-coded real-value execution lock.

Subsequent use of Fireblocks-held funds must be supported by the written agreement and the organization's Fireblocks policy and approvals. The owner checkbox records an operator assertion about the agreement; it is not an independent legal or corporate authority check. A successful signature check and inventory reconciliation are only evidence inputs. The hard-coded real-value payout lock remains enabled in this build, and all external approvals and production prerequisites remain outstanding until independently verified.
