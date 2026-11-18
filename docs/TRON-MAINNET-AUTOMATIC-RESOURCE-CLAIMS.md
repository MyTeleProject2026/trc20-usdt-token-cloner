# TRON Mainnet automatic resource-claim integration

## What this change adds

`server/resource-claim-orchestrator.mjs` provides a fail-closed orchestration contract for trusted provider adapters:

- provider health checks, with health explicitly separated from amount-specific grant eligibility;
- automatic grant requests through a provider-managed signer;
- independent Mainnet delegation verification before a grant is reported as usable;
- zero-cost eligibility enforcement (`userCostSun === "0"`);
- a zero-TRX-burn deployment gate requiring full Energy and Bandwidth coverage.

The module deliberately does not accept arbitrary provider URLs, create a provider wallet, hold private keys, sign provider transactions, or bypass provider authorization.

## Provider adapter contract

A production adapter must be installed in server code and implement:

- `id`: stable lowercase provider identifier;
- `network: "mainnet"`;
- `authorizationMode: "provider-managed-signer"`;
- `health()` -> `{ reachable: true }`;
- `checkEligibility({ ownerAddress, required, network })` -> explicit eligibility, Mainnet network, and exact user cost in SUN;
- `requestGrant({ ownerAddress, requestId, required, network })` -> accepted request and transaction ID;
- The application independently verifies every grant through `server/providers/tron-mainnet-delegation-verifier.mjs`; providers do not get to self-attest verification. The adapter must return a transaction ID, and the local verifier checks the solidified transaction body and receipt, exact delegation recipient, delegator/recipient record, and current aggregate Energy/Bandwidth coverage.

The provider's signer must already be authorized by the resource-owning account under the provider's own policy. The adapter must verify the actual solidified delegation on TRON Mainnet; a provider API success response alone is not sufficient.

## Credential-free public provider discovery\n\n`server/providers/tenergy-public-chain.mjs` integrates TEnergy\'s documented public Mainnet endpoints without API keys:\n\n- `GET https://api.tenergy.me/v1/status` for public service health;\n- `GET https://api.tenergy.me/v1/resources/{address}` for read-only Energy and Bandwidth observations.\n\nThe adapter validates the returned owner address, Mainnet identity, numeric resource fields, and observation timestamp. It labels these endpoints as read-only capabilities and explicitly reports that amount-specific free-grant eligibility, grant submission, and provider-managed delegation signing are unavailable. The owner readiness route exposes this under `publicProviderDiscovery`; it never promotes TEnergy to a grant provider. Public requests are rate-limited by TEnergy and may be unavailable.\n\nOther public API research: TRONAgg documents Energy and Bandwidth rental orders paid from a prefunded account and requires an API key; this is not a free grant and is not enabled.\n\n## Solidified Mainnet delegation verification\n\n`server/providers/tron-mainnet-delegation-verifier.mjs` implements a read-only verifier using TRON SolidityNode endpoints:\n\n- `POST /walletsolidity/gettransactionbyid` to confirm the exact transaction body is in solidified state;\n- `POST /walletsolidity/gettransactioninfobyid` to require a solidified receipt with `receipt.result === SUCCESS`;\n- `POST /walletsolidity/getdelegatedresourcev2` to confirm the Stake 2.0 delegation record for the transaction's actual delegator and the configured owner recipient;\n- `POST /walletsolidity/getaccountresource` to calculate currently available Energy and combined free/staked Bandwidth.\n\nThe verifier validates the transaction ID, transaction type, owner and receiver addresses, resource type, non-zero delegated stake, and matching delegation record amount. It returns `verified: true` only when the solidified delegation exists and current aggregate resources meet both exact requested deployment requirements. This confirms the deployment resource coverage; it does not imply that the provider grant itself was free unless a separate provider eligibility response confirms `userCostSun: "0"`. It never signs or broadcasts.\n\nThe orchestrator calls this application-side verifier after a provider returns an accepted grant. A provider's own API response cannot substitute for solidified Mainnet evidence.\n\n## Stage 4 — zero-TRX deployment workflow and broadcast recovery

The existing TronLink deployment flow remains in Frontend-Tron-Transfer/src/trax-mainnet.mjs and Frontend-Tron-Transfer/src/TRXMainnetPanel.jsx. It is intentionally owner-wallet signed; the server does not custody the owner's private key.

Before opening TronLink, the deployment flow:
- checks the configured owner account and Mainnet network;
- reads live Energy, free Bandwidth, staked/delegated Bandwidth, chain fee parameters, and owner permission threshold;
- simulates the exact compiled contract creation bytecode through wallet/estimateenergy, falling back only to the read-only wallet/triggerconstantcontract simulation when estimateenergy is unsupported;
- constructs the canonical unsigned CreateSmartContract transaction with wallet/deploycontract;
- budgets a 25% Energy safety margin and exact transaction-byte Bandwidth;
- blocks the wallet prompt if either resource source is insufficient or any TRX fallback is estimated.

Immediately before and after the wallet signature, it re-reads resources. It validates transaction integrity, raw-data hash, signer recovery, permission weight, and unchanged transaction bytes before broadcasting. After broadcast it waits for a solidified successful receipt, checks deployed runtime bytecode against the compiled artifact, and checks on-chain owner().

### Recovery for ambiguous broadcast responses

Added verifyExistingMainnetDeployment and recoverMainnetDeployment exports. If TronLink's broadcast request times out after the network may have accepted the transaction, the operator can preserve the original transaction ID and re-check it. Recovery derives the contract address from the original transaction ID and owner, then verifies the solidified successful receipt, exact runtime bytecode, owner address, and TRӾ name/symbol/6-decimal metadata. The recovery path is read-only: it never signs or rebroadcasts and therefore avoids accidentally creating a second token.

Tests in Frontend-Tron-Transfer/tests/trax-deployment-recovery.test.mjs cover successful recovery and rejection of failed receipts, runtime mismatch, owner mismatch, and metadata mismatch.

This workflow is deploy-ready only when a fresh live preflight proves the full resource requirement with zero TRX fallback. It does not create free Energy or Bandwidth. At this stage no Mainnet deployment has been broadcast by this implementation work.
## Current production status

No grant-capable provider adapter is registered. TEnergy is integrated only as a credential-free read-only observer. The application-side solidified delegation verifier is implemented and is invoked automatically after any future authorized provider grant. Therefore the orchestrator reports `no-authorized-provider-adapter` and does not claim resources. Even if a future adapter passes a health check, readiness remains `canRequestGrant: false` until an exact amount-specific request independently passes eligibility and zero-cost checks. The existing TEnergy promotional integration remains a separate, one-time Energy promotion and is not a general Energy-plus-Bandwidth deployment grant.

The read-only readiness module is mounted into the Express API and now includes public TEnergy resource and service-health discovery. The endpoint intentionally does not expose a grant-request action while no verified provider adapter is installed. Public TRONGrid Mainnet RPC is used as a credential-free read-only fallback for resource snapshots when no TRONGrid API key is present; this does not provide grant authority. No Render environment variables, provider credentials, provider agreement, or resource grant are created by this commit.

The TRӾ deployment screen now supports a single-click preflight-and-deploy flow: clicking the deploy action runs a fresh Energy/Bandwidth simulation and owner-permission check, then the existing deployment routine repeats the checks before opening TronLink. The one-time TEnergy promo is not inserted into this flow because it requires a separate message signature, covers Energy only, and this configured owner was previously rejected as ineligible. The deployment proceeds only if existing on-chain resources cover the complete transaction with zero estimated TRX fallback.

## Deployment gate

Call `evaluateZeroBurnDeploymentGate` only after obtaining exact deployment Energy and Bandwidth requirements from a Mainnet deployment simulation and fresh on-chain resource reads. Supply available resources in the same units as the estimates. The gate returns ready only when:

1. available Energy >= required Energy;
2. available Bandwidth >= the full transaction Bandwidth requirement;
3. estimated TRX fallback is exactly zero.

A passing gate is a preflight result, not authorization to deploy. Keep the existing owner-wallet approval or separately authorized deployer-signing flow. After broadcast, wait for a solidified receipt and verify deployed bytecode and token metadata.

## Required next integration

Add a provider-specific adapter only after obtaining its official API documentation, provider-side eligibility rules, and explicit provider-side signer authorization. This user requested no environment-variable setup, so an adapter may use only a genuinely public, documented provider interface or a provider-managed public integration; do not embed private credentials, invent an endpoint, or rely on an unauthenticated undocumented API. Until a provider actually authorizes and funds a grant, automatic free Energy/Bandwidth claiming is unavailable and the deployment gate must continue to block any shortfall.

## Stage 5 — Mainnet deployment authorization and transaction verification

Deployment remains an explicit TronLink owner-wallet action. The backend never holds the private key and does not bypass owner permission thresholds. Before signature, deployContractFromTronLink verifies the configured owner against the connected app account and injected TronLink signer, checks the on-chain owner permission threshold and connected signer weight, validates the node-issued CreateSmartContract payload and transaction ID, checks the compiled artifact, simulates exact creation Energy, calculates the 125% resource budget and transaction Bandwidth, and blocks any TRX fallback. It re-reads resources before prompting and again after the user signs, immediately before broadcast.

Added verifySolidifiedDeploymentTransaction. After broadcast (and during recovery), it independently reads the transaction from the SolidityNode and checks the exact txID, exactly one CreateSmartContract operation, the intended owner, exact compiled creation bytecode, and exact compiled ABI. Only then does the flow accept a solidified successful execution receipt and verify the deployed runtime bytecode, owner(), and TRӾ / TRӾ / 6-decimal metadata.

Expanded Frontend-Tron-Transfer/tests/trax-deployment-recovery.test.mjs with rejection tests for a different transaction owner, altered creation bytecode, altered ABI, and an unexpected contract operation. No Solidity source or token parameters were changed.

Stage 5 code and CI are not considered complete until all workflows for the latest commit pass. This is authorization and verification hardening, not a live deployment: no wallet signature was requested and no Mainnet transaction was broadcast by this implementation.

## Stage 6 — final deployment verification and TRONSCAN activation

Stage 6 implementation status: the final acceptance checklist and safe verification path are documented, but no live deployment or explorer verification can be completed by CI or a backend without the owner's TronLink approval and an actual Mainnet transaction.

### Mandatory release gates

1. All GitHub Actions workflows must pass on the same latest branch commit. A green workflow on an earlier commit is not sufficient.
2. Connect the intended owner wallet to TRON Mainnet and confirm the configured owner address.
3. Run a fresh exact-bytecode deployment simulation and read current Energy, free/delegated Bandwidth, chain fee parameters, and owner permission state.
4. Require the calculated Energy and Bandwidth budget (including the configured safety margin) to be covered with zero TRX burn/fallback. If this condition is not met, stop; do not sign or broadcast.
5. Review the exact unsigned CreateSmartContract transaction in TronLink and explicitly approve its signature. No backend or CI job may sign on the owner's behalf.
6. After broadcast, retain the transaction ID. Verify it on a solidified node: transaction type, owner, exact creation bytecode/ABI, successful receipt, deployed address, runtime bytecode, owner(), and token metadata.
7. Open TRONSCAN Mainnet using the confirmed contract address and transaction ID. Confirm the contract page and deployment transaction match the solidified-node results. Submit source verification only with the exact compiler version, optimizer settings, source files, constructor arguments, and metadata used for that deployed bytecode. Do not mark source verified merely because the contract page exists.

### Live status

- Code-level authorization and verification: implemented in the feature branch; latest test fixture correction commit: 5884d7dce6ab858321cbb0386c159e8e65254086.
- Latest CI on commit 359e391913c5e6836063f22e8308b4c4e9fbc2fb: core CI passed, but Owner Admin Frontend CI and Tron Transfer Frontend failed on the metadata-mismatch recovery test fixture. The fixture has been corrected in the newer commit; fresh CI for that commit must be observed before declaring CI green.
- Free Energy/Bandwidth coverage: not confirmed from a live owner wallet or provider grant.
- Zero-TRX preflight: not run against the owner's currently connected wallet in this implementation session.
- TronLink signature and Mainnet broadcast: not performed.
- Contract address, solidified receipt, and TRONSCAN source verification: unavailable until a real successful deployment exists.

TRONSCAN Mainnet explorer: https://tronscan.org/

### Stage 6 follow-up — CI regression repair and explorer navigation

CI on commit 6bd51e108b2e09aee883f92203bfd079f42666f2 exposed a recovery-test ordering issue: the test path attempted to validate a solidified transaction before checking whether the receipt was successful, and several recovery fixtures did not inject the solidified-transaction verifier. The implementation now checks the solidified successful receipt first, then verifies the matching CreateSmartContract transaction. Recovery fixtures explicitly mock that independent verification boundary.

Validation on commit 27d30754fdef3d29ba285b1b2ccf461808431c48: Tron Transfer Frontend passed and TRӾ Owner Admin Frontend CI passed; Main CI was still running at the time of the check. The explorer-link UI change is a subsequent commit and requires its own CI run.

The TRX Mainnet panel now displays a direct TRONSCAN contract-page link whenever a contract address is saved, alongside the existing transaction link. The UI explicitly warns that explorer visibility does not mean source code is verified. Source verification must use the exact compiler version, optimizer settings, source and constructor arguments for the deployed bytecode.

No deployment has been broadcast in this implementation session. Actual provider grants, wallet resource sufficiency, owner signature, contract address, and TRONSCAN source verification remain live-chain acceptance gates.


## Provider adapter transaction contract

A trusted provider adapter may delegate the two resources in one transaction or in separate transactions. Its `requestGrant` result must therefore return either:

- `{ accepted: true, transactionId }` when one solidified transaction contains both required resource operations; or
- `{ accepted: true, transactionIds: { ENERGY, BANDWIDTH } }` when the provider uses separate transactions.

The orchestrator verifies each resource transaction independently through the application's solidified TRON reader. For split transactions it checks the exact recipient, delegator, resource type, delegated stake record, successful solidified receipt and fresh owner resource coverage for the corresponding requested amount. A provider's own success or verification response is never trusted.

A provider adapter must also return exact-amount eligibility for the owner and Mainnet, including `userCostSun: "0"`, before submitting either transaction. Paid rentals, unknown costs, provider-side signer uncertainty, missing transaction IDs, and incomplete verification all fail closed.

No concrete free provider adapter is enabled by this interface-only change. An adapter may be installed only after the provider's documented API, zero-cost terms, server-side signer authorization, rate limits and delegation behavior have been reviewed.


## Ambiguous submission and retry safety

Provider grant submission is a side effect. A network timeout or lost response after the request is sent does not prove that the provider failed to broadcast its delegation. The orchestrator therefore distinguishes pre-submission eligibility failures from post-submission uncertainty:

- Health and exact-amount eligibility failures may move to another configured adapter because no grant was submitted.
- A submission exception returns `grant-submission-outcome-unknown` with `retrySafe: false`.
- An accepted response with missing transaction IDs or an unconfirmed zero-cost amount returns `grant-accepted-response-incomplete-or-not-zero-cost` with `retrySafe: false`.
- A submitted grant whose solidified verification is unavailable returns `grant-submitted-verification-unavailable` with `retrySafe: false`.
- A grant that fails independent verification is reported as unverified and is never followed by a second provider submission in the same request.

Operators must reconcile the original provider request using the stable request ID and provider-side transaction lookup before initiating a new request. This avoids accidental duplicate Energy/Bandwidth delegation when the provider broadcast succeeded but its response was lost. The adapter contract should make `requestId` idempotent at the provider boundary; local request IDs alone do not guarantee provider-side idempotency.


## Separate transaction identity for Energy and Bandwidth

The grant adapter must return two distinct 64-character transaction IDs:

```js
{
  accepted: true,
  userCostSun: '0',
  transactionIds: {
    ENERGY: '<energy-delegation-transaction-id>',
    BANDWIDTH: '<bandwidth-delegation-transaction-id>'
  }
}
```

The orchestrator rejects a response that reuses one transaction ID for both resource types. Each transaction is checked independently against a solidified Mainnet receipt, the exact owner recipient, the expected resource type, and the requested amount. A provider's aggregate success response is not evidence that both delegations occurred.

A provider that only delegates Energy must not be represented as an Energy-and-Bandwidth provider. Until both independently verified transactions exist, the zero-TRX deployment gate remains closed.
