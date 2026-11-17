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
- `verifyDelegation({ ownerAddress, transactionId, required, network })` -> `{ verified: true, solidified: true, network: "mainnet", ownerAddress, transactionId, ENERGY, BANDWIDTH }`. The returned transaction ID must exactly match the grant request, and the actual solidified resource amounts must meet or exceed both requested amounts.

The provider's signer must already be authorized by the resource-owning account under the provider's own policy. The adapter must verify the actual solidified delegation on TRON Mainnet; a provider API success response alone is not sufficient.

## Credential-free public provider discovery\n\n`server/providers/tenergy-public-chain.mjs` integrates TEnergy\'s documented public Mainnet endpoints without API keys:\n\n- `GET https://api.tenergy.me/v1/status` for public service health;\n- `GET https://api.tenergy.me/v1/resources/{address}` for read-only Energy and Bandwidth observations.\n\nThe adapter validates the returned owner address, Mainnet identity, numeric resource fields, and observation timestamp. It labels these endpoints as read-only capabilities and explicitly reports that amount-specific free-grant eligibility, grant submission, and provider-managed delegation signing are unavailable. The owner readiness route exposes this under `publicProviderDiscovery`; it never promotes TEnergy to a grant provider. Public requests are rate-limited by TEnergy and may be unavailable.\n\nOther public API research: TRONAgg documents Energy and Bandwidth rental orders paid from a prefunded account and requires an API key; this is not a free grant and is not enabled.\n\n## Current production status

No grant-capable provider adapter is registered by this change. TEnergy is integrated only as a credential-free read-only observer. Therefore the orchestrator reports `no-authorized-provider-adapter` and does not claim resources. Even if a future adapter passes a health check, readiness remains `canRequestGrant: false` until an exact amount-specific request independently passes eligibility and zero-cost checks. The existing TEnergy promotional integration remains a separate, one-time Energy promotion and is not a general Energy-plus-Bandwidth deployment grant.

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
