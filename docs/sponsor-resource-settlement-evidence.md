# Sponsor resource-settlement evidence requirements

## Current status

The application can record a preflight resource-source snapshot and re-read the current solidified TRON account/delegation state after a transfer. That is useful for detecting a changed sponsor/recipient relationship, but it is not proof of the delegation state at the transfer's own block.

The current implementation calls:

- `/walletsolidity/getaccount`
- `/walletsolidity/getdelegatedresourcev2`

The TRON API documents these as solidified/current-state queries. The delegated-resource request takes the delegator address, recipient address, and address-format option; it does not accept a block number. Therefore, the response cannot establish that delegation remained continuously valid at an earlier transaction block. See the official references:

- [TRON GetDelegatedResourceV2 — SolidityNode](https://developers.tron.network/reference/getdelegatedresourcev2-1)
- [TRON HTTP API documentation](https://tronprotocol.github.io/documentation-en/api/http/)
- [TRON GetDelegatedResourceV2 reference](https://developers.tron.network/reference/getdelegatedresourcev2)

## Fail-closed settlement rule

Resource-budget settlement now requires a separate historical-delegation proof bound to the exact confirmed transaction. The proof must attest to:

- the exact network, transaction hash, block number, and block timestamp;
- the exact fee-sponsor and asset-principal addresses;
- a verified historical anchor and complete delegation-change history through the transfer block;
- no intervening delegate/undelegate change that breaks the source relationship; and
- the same resource-specific delegation/source snapshot captured at preflight.

A matching latest-state snapshot alone is insufficient. The existing current-state verifier explicitly reports `historicalDelegationStateVerified: false` and does not manufacture historical evidence. Without the new proof, a settlement attempt is routed to `manual-review`; sponsor resource spend is not charged and sponsored submission remains disabled.

## Work still required

A trusted history adapter is not yet implemented. It must obtain complete, independently verifiable delegation history (for example, from a properly indexed archival node or a trusted historical event index), prove the initial state at a known anchor, replay all relevant delegate/undelegate changes to the transfer block, and fail closed on missing blocks, incomplete indexing, conflicting providers, or uncertain finality. A current-state API response or an unverified caller-supplied boolean must never be substituted for that history proof.

The PostgreSQL integration fixture that exercises the successful settlement state machine supplies a synthetic verified-history attestation. It validates database invariants only; it is not evidence that a production history adapter or live sponsor delegation exists.

## Safety boundary

This work does not enable TRON Mainnet sponsorship, real-value payouts, Fireblocks withdrawals, or any production broadcast. No production credentials, sponsor funds, live delegations, deployments, merges, or blockchain transactions are configured or performed by this change.
