# Stage 8H — FYStack API contract audit (read-only)

Audit parent PR #151 HEAD: `6467d73c4597bbadc873e6b9580fa11a60f30c3b`.

## Official documentation findings

Sources reviewed on 2026-11-10:
- API index: https://docs.fystack.io/
- SDK guidance: https://docs.fystack.io/sdks
- Withdrawal API: https://docs.fystack.io/withdrawals
- Policy semantics: https://docs.fystack.io/policies
- SDK repository: https://github.com/fystack/platform-sdk

Confirmed:
1. Fystack publishes an official TypeScript SDK, `@fystack/sdk`, and documents Production and Sandbox environments.
2. API authentication uses an API key, timestamp, and HMAC-SHA256 signature (or documented Ed25519 client-key authentication in newer releases). Credentials must remain server-side and outside source control.
3. The documented withdrawal-creation endpoint is `POST /wallets/:wallet_id/request-withdrawal`; it accepts an asset identifier, decimal amount, and recipient address, and may create a pending approval request. This is a state-changing operation and is expressly outside this read-only stage.
4. The documented withdrawal-status endpoint is `GET /withdrawals/:withdrawal_id`.
5. Fystack documents approval queues and policy evaluation. Its policy documentation says a matching `ALLOW` rule can bypass normal transaction approval and proceed to signing. No policy changes are proposed or made here.
6. Fystack documentation describes wallet, asset, workspace, and balance resources, but this audit did not establish the exact documented read-only wallet-balance method, response schema, or the account's API entitlement. Do not infer these from dashboard screenshots or invent a method name.

## Integration decision

The Stage 8G injected-client boundary remains a placeholder. It is not a live Fystack connection. Do not implement a guessed `getWalletUsdtSnapshot` network call until the precise official read-only endpoint/SDK method and response schema are confirmed from the current API reference or SDK types.

Before a server-side read-only adapter can be enabled, an authorized workspace administrator should independently confirm:
- API access is available for this workspace and which authentication mode is enabled;
- the exact wallet ID and workspace ID;
- the official TRON Mainnet USDT asset ID and contract metadata;
- the documented read-only wallet/asset balance method and whether its balance is available, total, or held;
- whether the workspace is Sandbox or Production.

Secrets must be stored only in server-side secret configuration. Never paste API keys, API secrets, Ed25519 private keys, cosigner material, recovery phrases, or authentication codes into chat or commit them.

## Preserved invariants

- No API call was made to Fystack.
- No withdrawal request, approval, policy, wallet, asset, key, or credential was created or changed.
- No database migration or historical-record mutation.
- The 1,000 USDT minimum remains unchanged.
- No balance is credited to Tron Transfer or treated as spendable based on provider display data.
- Signing, broadcasting, sweeping, and transfers remain disabled.
- No merge or deployment.

## Exit criteria for a future implementation stage

A read-only integration may be considered only after the exact documented endpoint/SDK method is established, an authorized operator supplies server-side credentials through the deployment secret manager, the workspace and asset identities are confirmed, and tests prove provider errors/stale data/identity mismatches fail closed. Any future withdrawal-creation capability requires a separate explicit authorization and independent review; it is not implied by this audit.
