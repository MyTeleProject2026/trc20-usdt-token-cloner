# No-real-USDT development and testnet workflow

## Goal

Develop, test, and demonstrate TRON Token Studio without buying, depositing, or holding real USDT. Use local mocks for automated tests, and use TRON testnet only for on-chain integration checks. A testnet token is not Tether USD and must never be presented as real USDT.

## Supported safe modes

### 1. Automated tests (no crypto, no provider credentials)

Run locally:

```sh
npm ci
npm test
npm run build
```

The OKX route tests use a mocked HTTP response and validate the authenticated request, HMAC signature, validation, status mapping, and upstream failures. They do not require an OKX account, API credentials, TRX, or USDT. A mocked response is test data, not a real exchange deposit.

### 2. TRON testnet (test assets only)

Use Shasta or Nile endpoints for testnet work. Obtain testnet TRX from the network's official faucet if transaction fees are needed. Testnet tokens have no guaranteed market value and are not redeemable for mainnet USDT.

- Use a dedicated test wallet; never paste a private key or recovery phrase into the frontend, chat, GitHub, or Render.
- Use a token contract deployed to the same testnet and identify it by its actual contract address.
- Do not label an arbitrary test token as official Tether USDT. UI copy should say **test token** and display the network and contract address.
- Verify a test transaction against the selected testnet's solidified transaction receipt and exact TRC-20 Transfer event.
- The existing `GET /api/tron/sponsorship/testnet-pilot-readiness?network=nile` and `?network=shasta` routes are read-only preflight diagnostics. Their response explicitly keeps `submission.enabled`, `canSubmitSponsoredTransfer`, and `userFundedFallbackAllowed` false. A readiness response is not proof that a transfer will be submitted.
- The existing `GET /api/tron/verify-trc20-transfer/:hash` endpoint is verification-only. It does not create or broadcast a transaction and does not prove an exchange has credited a deposit.

### 3. Production read-only verification (no transfer initiated)

The platform can query public chain data and, when an account owner explicitly configures it, read that owner's OKX deposit-history records using a read-only OKX API key. This does not require the platform itself to hold USDT. It does require the exchange account owner to authorize access to their own records.

Never share one operator's OKX API key with unrelated users. A TRON wallet login does not authenticate an OKX account. The current OKX integration is scoped to one configured account; it is not a per-user exchange connection system.

## What does not work without real assets

A real mainnet USDT transfer requires a sender with sufficient USDT and the network fee, or a correctly authorized and funded third-party sponsorship arrangement. A testnet token, mock response, database row, or UI display cannot create a real mainnet USDT balance or make an exchange credit a deposit. Exchange credit is controlled by the exchange after its own deposit checks.

No implementation should fabricate an exchange balance, create a false deposit receipt, or tell a recipient that funds arrived when the exchange has not confirmed them.

## Deployment checks

1. Confirm the latest GitHub Actions run passed `npm ci`, `npm test`, and `npm run build`; a successful Render frontend build alone does not prove all backend tests passed.
2. Confirm both Render services deployed the same intended `main` commit.
3. Set the backend Render Web Service Health Check Path to `/health`.
4. Keep the OKX API key, secret, passphrase, and status-access token in backend-only environment variables. Use an OKX key with **Read** permission only.
5. Keep production signing and broadcast disabled until authorization, fee funding, transaction validation, monitoring, and incident recovery have been independently tested and reviewed.

## Honest status reporting

- **Mocked test:** simulated fixture only.
- **Testnet transaction:** test-network transaction only.
- **Solidified chain verification:** a matching transaction receipt and token event were found on the named network.
- **Exchange deposit record:** returned by the configured exchange account's authenticated API.
- **Exchange credit:** claim only when the exchange's own record indicates the relevant credit state.

These statuses are distinct and must not be collapsed into a single "payment successful" label.
