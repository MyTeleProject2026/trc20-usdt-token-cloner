# GasFree SDK source audit and integration contract

**Reviewed:** 2026-10-24  
**Application:** TRON Token Studio / `trc20-usdt-token-cloner`  
**Purpose:** Record what the official GasFree docs and the Java, Swift, and JavaScript SDK sources support—and what they do not prove.

## Source repositories

- [GasFree developer docs](https://github.com/gasfreeio/developer-docs)
- [Official Java SDK](https://github.com/gasfreeio/gasfree-sdk-java)
- [Official Swift SDK](https://github.com/gasfreeio/gasfree-sdk-swift)
- [Official JavaScript SDK](https://github.com/gasfreeio/gasfree-sdk-js)
- [Application's JavaScript SDK copy](https://github.com/MyTeleProject2026/gasfree-sdk-js)

The user's JavaScript repository identifies `https://github.com/gasfreeio/gasfree-sdk-js.git` as its upstream and declares package version 1.1.4. Its `TronGasFree` implementation exposes deterministic GasFree address derivation and EIP-712 typed-data assembly/validation. The Java and Swift README files likewise describe address generation and message-hash functionality. These are useful wallet-side SDK building blocks; they are not proof of service-provider funding, transfer balance, or a working provider session.

## What GasFree documents

1. **Network support:** the provider API documentation lists TRON Mainnet and Nile testnet. The application must not advertise GasFree Shasta support without a documented and independently verified endpoint.
2. **Wallet authorization:** a wallet signs a `PermitTransfer` typed message containing `token`, `serviceProvider`, `user`, `receiver`, `value`, `maxFee`, `deadline`, `version`, and `nonce`. The private key remains in the user's wallet; the backend must never collect or store it.
3. **Provider API:** API Key and API Secret are issued through GasFree's developer program. Requests are authenticated by HMAC-SHA256 over the HTTP method, path, and timestamp. These credentials belong only on the backend.
4. **Fee model:** GasFree's service provider submits the authorized TRC-20 operation and pays its on-chain gas costs, but the documented activation and transfer handling fees are denominated in the token being transferred. Provider discovery and a valid signature do not mean these token fees are zero.
5. **Status and finality:** a successful provider response returns a trace ID. Provider trace states are not independent proof of a solidified transaction or exact Transfer event.

## Application implementation

The backend's current read-only API routes are:

- `GET /api/gasfree/config-status` — checks server-side credential presence without exposing values.
- `GET /api/gasfree/capabilities?network=mainnet|nile` — reads provider/token discovery and token-denominated fees.
- `GET /api/gasfree/account?network=...&address=...` — reads provider account metadata.
- `POST /api/gasfree/preflight` — validates the requested provider, token, sender, receiver, and exact base-unit amount, then reports provider/account/fee-policy facts. Only the documented fields are accepted; signatures and arbitrary extra fields are rejected.
- `GET /api/gasfree/trace?network=...&traceId=...` — reads a provider trace and independently checks a reported transaction against the selected network's solidified transaction body and receipt before persisting verification.
- `POST /api/gasfree/submit` — **intentionally returns HTTP 503**. It does not forward a signature, call GasFree, reserve a budget, sign, or broadcast.

Authenticated GasFree read requests now set `redirect: 'error'` so signed credentials cannot be forwarded through redirected provider requests.

## Preflight response semantics

`transferPolicyPreflightPassed: true` only means that the selected provider/token/account metadata and the observed token-denominated fee model pass that narrow read-only check. It does **not** mean a transfer is authorized or executable. The response deliberately keeps these flags false:

- `canPrepareWalletAuthorization`
- `canSubmitSponsoredTransfer`
- `submissionEnabled`
- `providerFundingVerified`

The preflight also reports blockers for independently verifying the GasFree account's on-chain token balance, completing the wallet EIP-712 authorization UX, verifying a suitable external-sponsor agreement and funded budget, and enabling a reviewed provider submission adapter. No sender-funded fallback is permitted.

## Release gates still outstanding

The SDK source alone cannot close these gates:

1. Apply for and configure GasFree provider credentials for the intended network, then verify live provider/token discovery.
2. Confirm the provider agreement and exact fee terms. For the product's external-sponsor-only policy, any token-denominated activation/transfer fee must be zero or explicitly paid by a separately approved sponsor without charging the sender.
3. Independently verify the relevant GasFree account's token balance and pending/frozen amounts against the solidified chain state.
4. Integrate wallet-side EIP-712 signing with exact chain ID, verifying contract, provider address, token contract, recipient, amount, fee cap, deadline, version, and nonce. Never send private keys to the backend.
5. Implement a reviewed submission adapter with strict request validation, provider selection/allowlists, replay protection, idempotency, rate limits, atomic sponsor-budget accounting, audit records, and safe retry semantics.
6. Reconcile provider trace IDs with solidified receipts, exact token contract and Transfer log, sender/receiver/amount, and post-transfer balances before settlement.
7. Complete Nile end-to-end tests using test assets, then conduct a separate security review and explicit operator approval before any Mainnet activation.
8. Treat any sponsor-funded TRX or token principal as a separate role and ledger. GasFree does not itself grant the application spendable TRX or official USDT principal.

## Verification status

The repository commits and regression tests described by the accompanying commits are recorded in GitHub. A passing CI result is **not** claimed here: recent Actions runs failed during runner allocation before any workflow step executed. No actual GasFree transfer, live fee quote, sponsor funding, Mainnet authorization, or Render configuration change is claimed by this source audit.
