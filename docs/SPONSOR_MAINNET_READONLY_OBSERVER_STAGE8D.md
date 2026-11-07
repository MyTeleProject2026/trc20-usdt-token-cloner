# Stage 8D — authenticated read-only TRON observation and authorization boundary

## Implemented in this stage

- `server/sponsor-mainnet-readonly-observer.mjs` uses the existing server-side Tatum credential contract: `TATUM_MAINNET_API_KEY` first, then the existing `TATUM_API_KEY` fallback.
- Requests are pinned to `https://tron-mainnet.gateway.tatum.io`, use the `x-api-key` header, reject redirects, have bounded timeouts, and expose no arbitrary URL or RPC-method parameter.
- The adapter calls only read-only methods: `walletsolidity/getnowblock`, `walletsolidity/getaccount`, `wallet/getaccountresource`, and `walletsolidity/triggerconstantcontract`.
- It validates the returned sponsor address, solidified block ID/height, official Tether TRON USDT contract, six-decimal balance result, native TRX balance and resource readings.
- Missing credentials, provider errors, malformed responses, address mismatches, invalid block metadata and invalid resource values fail closed.
- `tests/sponsor-mainnet-readonly-observer.test.mjs` exercises successful mocked reads, credential selection, redirect policy, no-credential behavior, provider errors and malformed observations.

## Evidence and trust limitations

- The Tatum API key authenticates the application to Tatum over HTTPS. The returned observation is **not** a Tatum-signed cryptographic attestation; the adapter sets `sourceCryptographicallyAttested: false`.
- Account and USDT balance reads use SolidityNode endpoints. TRON resource readings use the current resource endpoint and are labelled `latest-node-resource-snapshot`; they are not asserted to be part of the same solidified block snapshot.
- The adapter is an internal module and is not mounted as a public route. It does not make any request unless explicitly called by server code with an existing Tatum credential.
- No actual provider API request was made while implementing or testing this change. Tests inject a mock fetch implementation.

## Custody-provider adapter decision

No supported custody-provider API adapter or provider-specific credential contract was found in this branch. Fystack and Valtu are not integrated in the repository. Fireblocks is excluded from this project scope. Consequently, no custody-provider HTTP adapter was invented or connected. Stage 8C must continue to receive no custody observation unless a separately selected provider supplies an approved API contract and credentials through an existing or separately approved server-side configuration path.

## Sponsor identity, mandate, signer and revocation boundaries

Existing governance modules and tests remain authoritative for this stage:

- `server/sponsor-organization-authorization.mjs` is a pure non-production evidence evaluator. It does not itself verify legal identity, documents, signer policies, or funding; those evidence flags must originate from trusted independent verifiers.
- `server/sponsor-organization-governance.mjs` evaluates append-only revocation events against sponsor representative and trusted security-officer authority.
- `server/sponsor-governance-registry.mjs` requires versioned digest-pinned reviewer and security-officer registries, with distinct addresses.
- Existing tests cover cross-organization/wallet/mandate binding, missing legal-entity and beneficial-ownership evidence, signer-policy evidence, expired mandates, emergency revocation, invalid signatures and untrusted revocation actors.
- These checks do not establish a live institutional signer or authorize a transaction. The Stage 8B adapter remains test-only and non-broadcast.

## Preserved hard boundaries

- The platform withdrawal minimum remains 1,000 USDT (1,000,000,000 base units).
- The Stage 8C reconciler remains `verified: false` until both observations have an independently authenticated provenance contract.
- No custody provider, signer, wallet, transaction, or broadcast service is contacted.
- No signing, transaction creation, Mainnet broadcast, merge, deployment, Render change, production database change, or fund movement is performed by this stage.
