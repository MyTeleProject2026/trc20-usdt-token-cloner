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
5. Whether and how the Fireblocks-held funds may be used for later customer/recipient withdrawals.
6. Maximum principal, maximum fee funding, permitted network and token contract, time period, recipient policy and approval authority.
7. Reconciliation, reporting, fees, disputes, sanctions/compliance responsibilities, revocation and return-of-funds terms.

The manifest's `agreementReference` is only an identifier that points to the separately retained agreement. The verifier cannot inspect or certify the legal document, identity of a corporate signatory, source of funds or legal enforceability. Those require independent organizational and legal review.

## Stage 2 — create and verify the real Fireblocks destination

The authorized organization's Fireblocks administrator must independently:

1. Establish an eligible, approved production workspace.
2. Create a dedicated TRON Mainnet Vault Account.
3. Activate native TRX and the official TRON USDT TRC-20 asset.
4. Verify the USDT contract is exactly `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` and that both assets resolve to the intended vault deposit address.
5. Configure the organization's own transaction policy, independent approvers, destination controls and risk limits.
6. Provide the non-secret vault ID, actual asset IDs and exact vault address to the authorized integration operator through a controlled channel.

The organization must set `TREASURY_ADDRESS` to the actual Fireblocks vault address. Never set it to the third-party source address just because that address displays a balance.

## Stage 3 — create the signed consent manifest

Create a local JSON file, kept outside Git, with these fields:

```json
{
  "format": "tron-token-studio/third-party-funding-authorization/v1",
  "authorizationId": "funding-consent-2026-001",
  "network": "mainnet",
  "sponsorAddress": "SOURCE_WALLET_CONTROLLED_BY_AUTHORIZED_ORG",
  "vaultAddress": "ACTUAL_FIREBLOCKS_TRON_VAULT_ADDRESS",
  "usdtContract": "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  "maxUsdtBaseUnits": "25000000",
  "maxTrxSun": "8000000",
  "agreementReference": "ORG-AGREEMENT-2026-001",
  "issuedAt": "2026-11-01T00:00:00.000Z",
  "expiresAt": "2026-11-04T00:00:00.000Z",
  "signature": "ADD_SIGNATURE_AFTER_THE_SOURCE_WALLET_OWNER_SIGNS"
}
```

The example limits mean at most 25 USDT (25,000,000 base units at six decimals) and 8 TRX (8,000,000 SUN at six decimals). They are examples only. The real organization must choose the limits that match its separately approved agreement.

The signed text is reconstructed from the manifest fields in a fixed order. To print the exact text to present to the source wallet owner:

```bash
TREASURY_ADDRESS=ACTUAL_FIREBLOCKS_VAULT_ADDRESS npm run funding:authorization:message -- ./third-party-funding-authorization.json
```

The authorized wallet owner should connect their own wallet on TRON Mainnet, inspect the complete message and sign that exact text using the wallet's plaintext `signMessageV2` message-signing feature. For TronLink, the browser-side signing call is:

```js
const signature = await window.tron.tronWeb.trx.signMessageV2(message)
```

This is an off-chain message signature, not an on-chain transfer. It should not require network fees. The signer must never send a seed phrase, private key, wallet password or signing secret to the application or ChatGPT. A watch-only wallet cannot create this signature.

Put the returned `0x`-prefixed 65-byte signature into the manifest's `signature` field. The signature binds the source address, destination vault, official token contract, amount caps, agreement reference and expiry.

The manifest's validity is limited to seven days from issue time. Generate a fresh consent if it expires or any bound field changes.

## Stage 4 — verify locally

Run the verifier from the project root with `TREASURY_ADDRESS` set to the verified Fireblocks vault address:

```bash
TREASURY_ADDRESS=ACTUAL_FIREBLOCKS_VAULT_ADDRESS npm run funding:authorization:verify -- ./third-party-funding-authorization.json
```

The verifier checks:

- Canonical manifest format and supported fields only.
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
  "agreementReviewAcknowledged": true
}
```

The owner acknowledgement is stored with the owner address and timestamp. It is an auditable operator assertion only. The application does not certify the legal agreement, the source-of-funds record, or the source signer's authority to represent an organization.

The persistent record stores the authorization fields and SHA-256 hashes of the signature/message, not the wallet signature itself. The same authorization ID or signature hash cannot be registered with conflicting terms. The owner can inspect the record at:

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

The authorization detail endpoint then shows the on-chain record and whether its Fireblocks inventory evidence has been recorded. A chain-confirmed deposit without a later matching Fireblocks snapshot is still awaiting inventory reconciliation. A successful inventory reconciliation does not authorize later withdrawals.

The signed consent is not a deposit and does not make funds available. A pending or failed transfer is not funding evidence.

## What this verifier does not authorize

- It does not authorize a withdrawal, grant access to the source wallet, or import a private key.
- It does not authorize Tron Token Studio to sign or broadcast a transaction.
- It does not establish Fireblocks production access, vault ownership, API permissions or transaction policy.
- It does not prove that the vault was funded or that any exchange credited a deposit.
- It does not turn a third-party external/watch-only address into a Fireblocks source vault.
- It does not activate a payout feature flag or override the hard-coded real-value execution lock.

Subsequent use of Fireblocks-held funds must be supported by the written agreement and the organization's Fireblocks policy and approvals. A successful signature check is only one evidence item in that larger process.
