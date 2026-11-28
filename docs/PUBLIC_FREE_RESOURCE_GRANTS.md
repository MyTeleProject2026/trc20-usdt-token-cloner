# Public free TRON Mainnet resource grants — implementation audit

**Checked:** 2026-11-17  
**Scope:** TRON Mainnet Energy and Bandwidth grants only. The TRӾ Solidity contract, compiler artifact, ABI, deployment bytecode, token metadata, and owner controls are out of scope and must not be changed by this work.

## Decision

The application already has one real public promotional Energy integration: the conditional, one-time TEnergy Mainnet promo. No additional unrestricted public Mainnet Energy grant or external free Bandwidth delegation program was verified in this review.

Do not add a speculative provider adapter, fabricate a resource balance, or weaken the deployment zero-TRX-burn gate. The existing integration is the only verified public grant path found for this owner workflow. If the provider says the owner is ineligible, the application must stop that claim path and must not repeatedly request signatures.

## What is genuinely free at protocol level

- **Bandwidth:** TRON documents a renewable free quota of 600 Bandwidth per activated account. It is not an Energy allowance. The deployment's serialized transaction size and current remaining quota determine whether it is sufficient.
- **Energy:** TRON documents no protocol-level free Energy quota. Energy must come from stake, incoming delegation, or the TRX-burn fallback.
- **Delegation:** A resource delegation is backed by resources available to the delegating account. It is not created by calling a public RPC endpoint, and a server cannot manufacture Energy or Bandwidth from nothing.

Official references:
- https://developers.tron.network/docs/bandwidth-and-energy
- https://developers.tron.network/docs/resource-model
- https://developers.tron.network/docs/delegation
- https://developers.tron.network/docs/paying-for-resources

## Existing TEnergy Mainnet promo integration

The code is already present in this branch:

- Frontend claim flow: `Frontend-Tron-Transfer/src/trax-mainnet.mjs`, `claimTenergyPromoForDeployment`.
- Backend proxy: `Frontend-Tron-Transfer/resource-api/server.js`, under `/api/tron/tenergy/promo` and the free-delegation compatibility alias.
- Mainnet read-only resource and inbound-delegation verification: `server/free-delegation-resources.mjs`.
- Integration behavior and constraints: `docs/TENERGY_MAINNET_PROMO_CLAIM.md`.

The flow:
1. Reads a fresh owner resource baseline.
2. Checks the provider's current public Mainnet promo state and the owner's redemption record.
3. Requests a provider challenge only when the promotion is active.
4. The provider checks address eligibility before issuing a challenge. The owner signs the exact TIP-191 message in TronLink; this is an off-chain message signature, not a TRON transaction.
5. The backend forwards the address, nonce, and signature to TEnergy.
6. The app waits for delegation and verifies a fresh Mainnet Energy increase plus an active inbound Energy delegation.
7. The deployment's independent preflight still checks the exact deployment Energy requirement and Bandwidth coverage. The grant does not provide Bandwidth and does not override the zero-TRX-burn guard.

Provider outcomes:
- `3038 promo_not_eligible`: permanent address ineligibility; no retry and no signature.
- `3039 promo_already_redeemed`: one-time grant already claimed.
- `3040 promo_redeem_unavailable`: promotion is not currently open or available; retry only when the provider says its state may change.
- `granting` is pending, not proof of delivery.
- Only a fresh on-chain resource snapshot and inbound delegation record count as successful delivery.

Official provider references:
- https://tenergy.me/docs/api/promo
- https://tenergy.me/docs/errors
- https://tenergy.me/docs/environments

The TEnergy `tenergy.dev` personal promo code is not a Mainnet Energy grant; its documented benefit is a fee discount on paid orders.

## Provider screening result

| Candidate | Mainnet resource grant? | Result |
|---|---|---|
| TRON protocol free quota | Bandwidth only | Verified: 600 renewable Bandwidth per activated account; no Energy |
| TEnergy public promo | Conditional one-time Energy | Verified integration exists; address eligibility and active promo required |
| TEnergy paid rental / refill | Energy or Bandwidth for payment | Excluded: not free |
| Nile / Shasta faucets | Testnet assets/resources | Excluded: not Mainnet |
| Generic Energy rental / delegation APIs | Usually paid or backed by a sponsor | Excluded unless a public, no-cost grant, eligibility terms, and actual on-chain delivery are independently demonstrated |
| Binance Wallet gas promotion | Wallet-specific sponsored USDT transfer flow, not an arbitrary contract-deployment Energy grant | Excluded from this deployment workflow |

No other public provider was accepted as a free grant source in this review. This is a bounded research result, not proof that no private or invitation-only programs exist.

## Production safety and acceptance criteria

- Keep the TRӾ contract and its generated artifacts unchanged.
- Keep paid rentals and paid fallbacks disabled.
- Never collect wallet private keys, seed phrases, or passwords.
- Do not treat a provider API response, a UI badge, or a pending claim as delivered resources.
- Do not sign or broadcast a deployment as part of a grant claim.
- Require a fresh owner resource snapshot, actual inbound delegation evidence where applicable, exact deployment Energy estimation, and sufficient Bandwidth coverage.
- Keep the zero-TRX-burn deployment gate fail-closed. If either resource is short, do not open a deployment wallet prompt.
- Recheck provider terms and current promotion state before any future integration; do not hard-code a temporary promo as guaranteed.

## Implementation outcome

No new provider adapter is justified by the evidence available on 2026-11-17. The existing TEnergy conditional-grant integration and TRON free-Bandwidth accounting are the supported implementation. This change records the current grant boundary and prevents paid, testnet, or unverified services from being mislabeled as free Mainnet grants. It does not modify or deploy the TRӾ contract.
