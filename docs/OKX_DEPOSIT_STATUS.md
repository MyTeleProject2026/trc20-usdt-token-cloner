# Authenticated OKX deposit-history integration

## Scope and trust boundary

The API adapter is read-only. It calls the official OKX endpoint `GET /api/v5/asset/deposit-history` and displays only records returned in a successful authenticated response. It does not read a recipient's separate exchange account, modify any account balance, create credit events, sign TRON transactions, or initiate withdrawals/transfers.

This integration is for the **single OKX account represented by the API credentials configured on the backend**. A user having a TRON wallet session does not prove ownership of that OKX account. Only the account owner or an operator authorized by that owner should use the status-access token.

Official references:
- [OKX API v5 documentation — Get deposit history](https://app.okx.com/docs-v5/en/#rest-api-funding-get-deposit-history)
- [OKX API key permissions and security](https://app.okx.com/docs-v5/en/)

## Configure on Render

Use the existing backend service `trc20-usdt-token-cloner-api` in the selected Render workspace. In **Environment**, add these variables to the backend service only:

| Variable | Value / rule |
| --- | --- |
| `OKX_API_KEY` | API key for the account owner’s OKX account |
| `OKX_API_SECRET` | Matching API secret |
| `OKX_API_PASSPHRASE` | Matching API passphrase |
| `OKX_STATUS_ACCESS_TOKEN` | Separately generated, high-entropy token with at least 32 characters |

Create the OKX key with **Read** permission only. Do not grant Trade or Withdraw. Bind it to the service’s allowed egress IP addresses if your hosting/network setup supports stable egress IPs. Never put any of these values in the Vite frontend environment, source code, GitHub, a URL, a screenshot, or a chat message.

The frontend page `#/okx-deposit-status` asks for only the separate status-access token. It keeps that token in component memory, sends it through an HTTPS Authorization header, disables caching, and does not write it to browser storage. Treat this token as a password to the configured account’s deposit-history endpoint.

If the integration should access different people's exchange accounts, do not share one account’s API key/token among them. Build and verify a per-user exchange authorization flow and account-level isolation first.

## Endpoint

`GET /api/okx/deposit-status`

Required header:

```http
Authorization: Bearer <OKX_STATUS_ACCESS_TOKEN>
```

Optional query parameters:
- `ccy`: currency code, for example `USDT`
- `txId`: exact transaction hash
- `limit`: integer from 1 to 100
- `after` and `before`: 13-digit millisecond timestamps as supported by OKX

Responses are marked `Cache-Control: no-store, private`. Missing server configuration returns `503`; a missing/incorrect status token returns `401`; invalid query parameters return `400`; invalid/upstream-unavailable OKX responses return `502`.

## Interpreting returned records

The status code is the OKX-reported deposit state:
- `0`: waiting for confirmation
- `1`: credited, but not yet withdrawable
- `2`: successful, which OKX defines as credited and withdrawable
- `8`: pending due to a temporary deposit suspension
- `11`: address blacklist match
- `12`: account or deposit frozen
- `13`: sub-account deposit interception
- `14`: KYC limit
- `17`: pending response from a Travel Rule vendor

The API's `ts` is the time the deposit record was created, not a guaranteed credit timestamp; the UI calls it **Record created**. A missing record is not proof that a transfer failed. Confirm the exact network, deposit address, any required memo/tag, and account status directly in OKX.

## Health checks and verification

The backend already exposes `GET /health` and `GET /api/readiness`. In Render, set the backend Web Service's **Health Check Path** to `/health` so Render performs an application-level probe. The static frontend does not need this backend health path.

The repository CI workflow on `main` runs `npm ci`, `npm test`, and `npm run build`. The OKX tests exercise the route over local HTTP with mocked OKX responses; they verify access gating, request signature, validation, actual-record mapping, upstream error handling and the absence of a transfer/signing path. These mocked tests do not constitute a live OKX account test.

Before enabling real status access, verify the latest GitHub Actions run and both Render deploys. Do not enable credentials or report a live OKX result until the owner has configured the server-side variables and the authorized request has returned a valid OKX response.
