# Mainnet Tether USDT payout requests

## Asset scope

This request workflow accepts only genuine Tether USDt (TRC-20) on TRON Mainnet.

The asset identity is hard-pinned in code:
- Network: `mainnet`
- Token contract: `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`
- Symbol: `USDT`
- Decimals: `6`

No caller-supplied token contract or asset symbol can override this identity. Nile and Shasta contracts, arbitrary TRC-20 tokens, and VTRC are rejected by this Mainnet request endpoint. Testnet assets are not Tether Mainnet USDT.

Official identity references:
- Tether supported protocols: https://tether.to/en/supported-protocols/
- Official Tether TRON token explorer link: https://tronscan.org/#/token20/TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
- TRON token information API: https://developers.tron.network/reference/get-trc-20-token-information

## Requester workflow

The Organization payouts page requires:
- the locally unlocked Mainnet owner wallet;
- an active backend wallet-auth session;
- `OWNER_WALLET_ADDRESS` and `TREASURY_OWNER_ADDRESS` configured to the same valid TRON Mainnet owner address;
- the owner wallet to sign a short-lived, domain-separated **request-for-review** message.

This message is not a transfer authorization. It cannot be used by the payout submission route, cannot create an unsigned TRON transaction, and does not authorize Fireblocks to move funds.

### Submit a review request

`POST /api/treasury/payout-requests`

Headers:
- `Authorization: Bearer <Mainnet owner wallet session token>`
- `Content-Type: application/json`
- Exact allowed browser origin.

JSON body:
```json
{
  "idempotencyKey": "random-32-character-key",
  "recipientAddress": "T...",
  "amountUsdt": "25.000001",
  "requestExpiresAt": 1800000000000,
  "ownerRequestSignature": "0x..."
}
```

The backend derives the requester address from the authenticated session. It does not accept a caller-supplied network, asset symbol, token contract, decimals, Fireblocks instruction, or execution flag. It verifies:
- the session belongs to the configured Mainnet treasury owner;
- the exact application origin;
- a valid TRON recipient different from the requester;
- a positive USDT decimal amount with at most six decimal places;
- the request-only signature against a canonical message;
- a signature expiry no more than two minutes in the future;
- database idempotency and a maximum of ten new requests per requester per hour.

A successful response is only `pending-organization-review`. It reports:
- `payoutAuthorized: false`
- `transferSubmissionEnabled: false`
- `providerSubmissionAttempted: false`
- `transactionCreated: false`
- `transactionBroadcast: false`

### Retrieve a request

`GET /api/treasury/payout-requests/:idempotencyKey`

Requires the same configured Mainnet owner session. No other requester can read the record.

## Separate organization review queue

The organization's authorized reviewer can read pending requests from a trusted server using:

```http
GET /api/treasury/payout-requests?limit=50
Authorization: Bearer <TREASURY_PAYOUT_REVIEW_API_TOKEN>
```

`TREASURY_PAYOUT_REVIEW_API_TOKEN` is a distinct, server-only review credential. It is not the sponsor admin token and is not a Fireblocks API key. An authorized adult administrator of the actual treasury-owning organization must generate it with an approved secret manager and configure it only in the backend Render environment. Minimum length: 32 characters. Never put it in frontend variables, a URL, GitHub, logs, or chat.

This endpoint is read-only. It does not approve, reject, reserve, initiate, sign, or broadcast transfers. The responsible organization must separately confirm the legal authority, recipient policy, source of funds, budget and transaction approval before any future execution workflow is considered.

## Mainnet payout execution boundary

The existing backend constant `REAL_VALUE_PAYOUT_EXECUTION_DISABLED = true` remains unchanged. Environment variables cannot override it. Real-value withdrawals are unavailable in this build.

A genuine Mainnet payout still requires:
1. Written authorization from the actual treasury-owning organization.
2. An approved and funded production Fireblocks TRON vault with genuine official USDT and sufficient native TRX for network fees.
3. Verified Fireblocks API-user permissions, vault/asset metadata and transaction policies.
4. A separately reviewed transaction authorization, limits, approval quorum, emergency stop and reconciliation workflow.
5. Independent security review and production release approval.
6. Verification of the successful solidified TRON receipt and exact official-USDT Transfer event.

A solidified chain transfer is not proof that an exchange credited the deposit. Exchange credit must be confirmed by the receiving exchange's own deposit records.
