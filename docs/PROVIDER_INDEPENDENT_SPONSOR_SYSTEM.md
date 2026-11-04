# Provider-independent sponsor wallet workflow

## Decision

The sponsor organization controls its own TRON wallet and explicitly signs each transaction in its own connected wallet. TRON Token Studio does not need a Fireblocks workspace, Fireblocks API key, vault account ID, Fireblocks asset IDs, or Fireblocks API RSA secret file for this workflow.

This is separate from the optional owner-only Fireblocks payout feature documented in [OWNER_TREASURY_PAYOUTS.md](./OWNER_TREASURY_PAYOUTS.md). Do not set `TREASURY_SIGNER_MODE=fireblocks` merely to use sponsor-wallet signing.

## Implemented code scope

The current provider-independent connected-wallet signing path is implemented for **Shasta and Nile testnets only**:

1. A wallet-authenticated requester creates an idempotent request for an allowlisted testnet asset and recipient.
2. A sponsor operator independently reviews the request and the relevant sponsor agreement scope.
3. The operator reserves the corresponding asset-principal budget and separately handles the network-fee/resource sponsor budget.
4. The backend persists the exact unsigned transaction and transaction ID for the reservation before returning the signing intent.
5. The relevant sponsor organization connects its own TronLink wallet and explicitly signs the exact transaction.
6. The backend checks the signed transaction against the persisted intent, validates the selected network's signature permission, checks current sponsor resource capacity, and locks the reservation to one transaction ID before broadcast.
7. The backend marks the transaction submitted only if the fixed Shasta/Nile node accepts that same transaction ID.
8. Solidified chain observation, receipt verification, receiver balance reconciliation, and sponsor cost settlement are separate follow-up operations. Node acceptance is not confirmation.

Relevant implementation:
- `src/SponsorSignerConsole.tsx` — sponsor operator wallet connection and approval UI.
- `server/sponsor-tron-submission.mjs` — unsigned transaction preparation, signature validation, resource checks and guarded broadcast.
- `server/routes/native-tron.mjs` — sponsor request, reservation, signing-intent and submit-signed routes.
- `server/routes/sponsor-request-intake.mjs` — testnet-only request queue.
- `server/sponsor-integration-readiness.mjs` — configuration and release blockers.
- `server/sponsorship-status.mjs` — public capability contract.

## Separate sponsor roles and balance accounting

The asset-principal sponsor must actually hold the token being transferred. The network-fee sponsor must separately provide the applicable TRX fee budget or approved Energy/Bandwidth resources. The role wallets and their budgets are separately monitored and reconciled; one role's balance is not silently counted as the other role's funding.

A balance snapshot or resource delegation is diagnostic evidence, not consent to spend. A sponsor budget becomes eligible only after the organization has approved the exact agreement scope and fresh funding checks pass. The end user is never used as a fallback source of principal or fees.

## Fireblocks dependency

Fireblocks is **not required** for the connected sponsor-wallet flow. The sponsor signs in its own wallet and its blockchain private key remains inside that wallet. No sponsor private key, seed phrase, or recovery phrase is sent to the backend or stored in Render.

The separate owner-treasury payout implementation is Fireblocks-specific and remains an independent optional feature. The environment preflight therefore checks Fireblocks settings only when that owner-payout signer is explicitly selected. Missing Fireblocks settings must not block the provider-independent sponsor-wallet workflow.

## What is not production-complete

The current sponsor-wallet signer is not a Mainnet withdrawal adapter. The following remain release blockers:

- Mainnet sponsor-wallet transaction construction, signing, submit/broadcast and exact transaction policy validation are not implemented by this path.
- Sponsor organization identity, account ownership, signed spending mandate and transaction-time consent are not independently verified by the application.
- Real asset-principal funding and full network-fee/resource coverage must be demonstrated from the authorized sponsor accounts for the exact network and asset.
- Post-transfer fee attribution/settlement for a **different** delegated Energy/Bandwidth sponsor is not complete. The existing direct-TRX-burn settlement is a narrow same-wallet testnet case.
- A supported Shasta/Nile end-to-end transfer with external sponsor approval, a real connected wallet signature, solidified transaction, exact recipient balance and fee/resource reconciliation has not yet been recorded.
- Independent application/security review, incident response, monitoring and explicit production release approval remain required.

The production readiness result intentionally remains `preflight-only-not-production-ready`; sponsored submission and Mainnet execution remain disabled. This is not a claim that a public sponsor has committed funds.

## Dashboard and balance-display rules

The application may show a combined **verified available sponsor capacity** only after it calculates the net eligible amount from independently verified, fresh sponsor snapshots and approved, unreserved ledger budgets for the same network and asset. It must not combine:
- different networks or token contracts;
- asset-principal USDT with TRX fee balances;
- fee-resource snapshots with USDT principal;
- paused/unapproved budgets, pending requests, reservations, or stale snapshots.

Keep the owner's personal wallet balance separate. Sponsor capacity is not the user's wallet balance and does not mean that the receiving exchange has credited a deposit. A recipient balance is spendable only after the recipient wallet's actual on-chain balance is verified; exchange credit requires the receiving exchange's own evidence.

## Release rule

Do not remove the Mainnet payout kill switch or enable a real-value withdrawal based on a code change, environment-variable presence, a connected wallet, an address, a budget record, or a UI balance. A real payout requires the sponsor organization's documented mandate, actual funds, explicit transaction approval, exact network/asset/recipient checks, secure signing, fee/resource coverage, independent solidified-chain verification and operational release approval.
