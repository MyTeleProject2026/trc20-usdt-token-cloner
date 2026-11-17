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
- `verifyDelegation({ ownerAddress, transactionId, required, network })` -> independently verified solidified delegation with actual ENERGY and BANDWIDTH amounts.

The provider's signer must already be authorized by the resource-owning account under the provider's own policy. The adapter must verify the actual solidified delegation on TRON Mainnet; a provider API success response alone is not sufficient.

## Current production status

No provider adapter is registered by this change. Therefore the orchestrator reports `no-authorized-provider-adapter` and does not claim resources. Even if a future adapter passes a health check, readiness remains `canRequestGrant: false` until an exact amount-specific request independently passes eligibility and zero-cost checks. The existing TEnergy promotional integration remains a separate, one-time Energy promotion and is not a general Energy-plus-Bandwidth deployment grant.

The read-only readiness module is mounted into the Express API. Public TRONGrid Mainnet RPC is used as a credential-free read-only fallback for resource snapshots when no TRONGrid API key is present; this does not provide grant authority. No Render environment variables, provider credentials, provider agreement, resource grant, deployment transaction, or contract verification are created by this commit.

## Deployment gate

Call `evaluateZeroBurnDeploymentGate` only after obtaining exact deployment Energy and Bandwidth requirements from a Mainnet deployment simulation and fresh on-chain resource reads. Supply available resources in the same units as the estimates. The gate returns ready only when:

1. available Energy >= required Energy;
2. available Bandwidth >= the full transaction Bandwidth requirement;
3. estimated TRX fallback is exactly zero.

A passing gate is a preflight result, not authorization to deploy. Keep the existing owner-wallet approval or separately authorized deployer-signing flow. After broadcast, wait for a solidified receipt and verify deployed bytecode and token metadata.

## Required next integration

Add a provider-specific adapter only after obtaining its official API documentation, server credentials, eligibility rules, and explicit provider-side signer authorization. Do not configure a guessed endpoint or private key. Until then, the system remains safely blocked rather than spending TRX or presenting unverified resources as available.
