# Direct sponsor-to-recipient Mainnet withdrawal model

## Target transaction path

The requester uses the existing TRON Token Studio account and withdrawal UI. The platform persists a request and presents it to the authorized sponsor. The sponsor's own TRON wallet signs a transaction whose sender is the asset-principal sponsor and whose recipient is the requested external wallet or exchange deposit address. The signed transaction is broadcast to TRON Mainnet only after the request, exact agreement scope, sponsor budget, signature, and transaction-specific fee/resource coverage have been checked.

The platform is not the owner of the sponsor wallet and does not hold the principal. The requester's identity wallet is not the sender and does not need USDT or TRX. The direct sponsor wallet must hold genuine official USDT; the sponsor or separately authorized fee sponsor must cover the network costs. The requested amount and fee amount are accounted for separately so the recipient amount is not silently reduced.

## Current repository checkpoint

The new diagnostic endpoint is:

- `GET /api/tron/sponsorship/mainnet-direct/readiness?refresh=1`

It reads the existing fee-sponsor and asset-principal sponsor snapshots on Mainnet, checks the official Tether TRC-20 contract, role separation, audited Energy/Bandwidth delegation, matching Mainnet agreement-scope allowlists, and database readiness. It does not return sponsor addresses or credentials.

This is a diagnostic checkpoint, not a withdrawal route. `preflightReady`, `canCreateSigningIntent`, and `canSubmitSponsoredTransfer` remain false. The source-level Mainnet execution gate is hard-coded closed; environment variables cannot open it.

## Still required for real execution

1. Build a Mainnet-specific request reservation and approval state machine that binds the requester's authenticated identity, recipient, official USDT contract, exact amount, sponsor scope, expiry, replay nonce, and idempotency key.
2. Add an asset-sponsor wallet signing flow. Signing happens in the sponsor's connected wallet; private keys and seed phrases must never enter the API or browser storage. The server must validate the exact persisted unsigned transaction, sender, recipient, contract, amount, fee limit, transaction expiry, signature permission, and sponsor approval before submission.
3. Verify transaction-specific Energy and Bandwidth capacity for the exact transaction, with a distinct fee-sponsor budget and resource reservation. An observed delegation or a current resource balance alone is not a guarantee of zero TRX burn.
4. Add fixed-origin Mainnet broadcast, durable single-transaction claim, ambiguous-timeout handling, and retries restricted to the same transaction ID.
5. Reconcile the exact USDT Transfer event and successful receipt from solidified TRON chain data, then verify the receiver's balance delta and settle the sponsor principal and fee ledgers once.
6. Independently review the sponsor's legal authority, account ownership, source of funds, agreement scope, wallet signing policy, emergency pause, production database backup/restore, and security posture.
7. Complete a funded low-value Mainnet acceptance transfer under the sponsor's authority. A successful TRON transfer proves on-chain receipt, not an exchange's internal deposit credit; that must be checked separately with the exchange.

## Guardrails

- No fabricated balances, simulated Mainnet receipts, fake transaction IDs, or claims that an exchange credited a deposit without exchange evidence.
- No private key, seed phrase, API secret, or Fireblocks signing material is accepted through these APIs.
- No fallback to the requester's funds is allowed.
- Do not enable Mainnet execution from an environment flag alone. The source-level gate stays closed until the implementation, independent reviews, and acceptance evidence are complete.

## Mainnet request-intake checkpoint

A separate Mainnet request intake is now available for authenticated Mainnet wallet identities:

- `POST /api/tron/sponsorship/mainnet-direct/requests`
- `GET /api/tron/sponsorship/mainnet-direct/requests/:idempotencyKey`
- `GET /api/tron/sponsorship/mainnet-direct/requests?limit=50` (server-only sponsor-review token)

It accepts only the official Tether Mainnet USDT contract, six-decimal positive integer base units, a valid recipient distinct from the requester, and an idempotency key. Requests are persisted in a dedicated table, separate from the testnet intake queue. The requester can retrieve only their own request. The sponsor review queue requires the server-side admin token.

The status is always `pending-sponsor-review`. This intake does not establish sponsor authority, reserve principal or fee budget, create a signing intent, sign, broadcast or settle. It deliberately has no approve/execute endpoint yet. Mainnet execution remains hard-disabled.

### User interface and verification

The existing Mainnet read-only panel now includes a separate requester identity and request form. It requires TronLink to be manually set to the official HTTPS TRON Mainnet node (`api.trongrid.io`), signs only the server's short-lived wallet-identity challenge, and keeps the resulting session token in component memory. The form submits recipient, USDT amount and a browser-generated idempotency key to the Mainnet request API. Editing the recipient or amount generates a new request key; retrying an unchanged request reuses the same key.

The form is not connected to the testnet sender wallet or testnet transfer flow. It does not request a transaction signature, and the request receipt is labelled `No transfer sent`. A user must sign in again after a page refresh because the Mainnet requester session token is not persisted in browser storage.

The asset-principal sponsor and network-fee sponsor now have separate Mainnet wallet-authenticated review queues. Each must sign a separate request-bound approval from its own configured Mainnet wallet. These approvals do not prove the legal sponsor mandate by themselves, do not reserve assets/resources, and do not provide a TRON transaction signature.

## Mainnet direct sponsor approval checkpoint

The sponsor-side workflow now includes these additional endpoints:

- `GET /api/tron/sponsorship/mainnet-direct/review-queue` — authenticated by a short-lived TRON Mainnet wallet identity session. The session address must exactly match `SPONSOR_ASSET_MAINNET_ADDRESS`.
- `POST /api/tron/sponsorship/mainnet-direct/requests/:idempotencyKey/approval-challenge` — creates a one-use, 10-minute challenge for one persisted request.
- `POST /api/tron/sponsorship/mainnet-direct/requests/:idempotencyKey/approve` — consumes the challenge and verifies the signature recovered from the configured sponsor wallet.

The approval policy requires all of the following backend-only values:

- `SPONSOR_ASSET_MAINNET_ADDRESS`
- `SPONSOR_MAINNET_DIRECT_ORGANIZATION_REFERENCE`
- `SPONSOR_MAINNET_DIRECT_AGREEMENT_REFERENCE`
- `SPONSOR_MAINNET_DIRECT_AGREEMENT_SHA256`
- `SPONSOR_MAINNET_DIRECT_MAX_PAYOUT_USDT_BASE_UNITS`
- An exact matching `SPONSOR_APPROVED_AGREEMENT_REFERENCES` scope: `agreementReference|organizationReference|mainnet|assetPrincipalAddress|asset-grant|USDT|TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`

Before issuing a signing challenge, the backend also requires a fresh Mainnet sponsor snapshot, sufficient verified official USDT principal for the exact request, and a distinct, read-verified network-fee sponsor with positive TRX and a resource snapshot.

The challenge message binds the request ID/key, requester identity, sponsor organization and wallet, recipient, official contract, exact six-decimal base-unit amount, executed-agreement reference and SHA-256 digest, one-time nonce, and expiry. The API stores only the nonce hash and message/request digests; the raw nonce is returned once to the sponsor UI. The challenge is consumed before signature recovery, so invalid or replayed signatures cannot reuse it. The sponsor signature must recover to the configured asset-principal sponsor wallet.

A verified approval is stored separately from the immutable request and expires after 30 minutes. It authorizes only the exact USDT principal request at the approval layer. It does not approve network fees, reserve a balance, create a transaction, provide a TRON transaction signature, broadcast, or settle. The requester identity wallet and sponsor signer identity are held in separate UI states and require separate Mainnet sign-ins.

**Important:** environment references and a wallet signature do not independently prove legal authority, organizational ownership, source of funds, or the validity of the agreement. Those still require external review. A positive balance snapshot is not a reservation and may change after approval. Recheck funding and all spend controls immediately before any later signing/execution implementation.

## Separate Mainnet network-fee sponsor approval

The fee-sponsor workflow is separate from the asset-principal approval:

- `GET /api/tron/sponsorship/mainnet-direct/fee-review-queue`
- `POST /api/tron/sponsorship/mainnet-direct/requests/:idempotencyKey/fee-approval-challenge`
- `POST /api/tron/sponsorship/mainnet-direct/requests/:idempotencyKey/approve-fees`

It requires a different wallet from the asset-principal sponsor and a second exact `SPONSOR_APPROVED_AGREEMENT_REFERENCES` scope: `feeAgreementReference|feeOrganizationReference|mainnet|feeSponsorAddress|network-fee|TRX|-`.

Backend-only fee sponsor policy settings:

- `SPONSOR_FEE_MAINNET_ADDRESS`
- `SPONSOR_MAINNET_DIRECT_FEE_ORGANIZATION_REFERENCE`
- `SPONSOR_MAINNET_DIRECT_FEE_AGREEMENT_REFERENCE`
- `SPONSOR_MAINNET_DIRECT_FEE_AGREEMENT_SHA256`
- `SPONSOR_MAINNET_DIRECT_MAX_FEE_SUN`

The fee sponsor can only create a challenge after an active principal approval exists for that exact request. Before challenge creation, the backend rechecks a fresh role snapshot, sufficient official USDT principal, distinct sponsor addresses, positive verified fee-sponsor TRX, resource state, and audited Energy/Bandwidth delegation from fee sponsor to principal sponsor. The fee approval message binds the same requester, recipient, USDT contract and exact principal amount as the principal approval, plus a separate fee-sponsor organization, agreement digest and maximum fee budget in SUN. The fee signer must recover to `SPONSOR_FEE_MAINNET_ADDRESS`; one-time nonces are consumed before signature recovery and approvals persist separately in PostgreSQL.

**Limits:** fee approval is only a capped willingness to cover network costs. It does not transfer TRX, execute resource delegation, reserve TRX/Energy/Bandwidth, estimate the exact final fee, sign the USDT transaction, broadcast, or settle. A later execution checkpoint must reserve and recheck exact transaction fees/resources and keep principal and fee ledgers separate.
