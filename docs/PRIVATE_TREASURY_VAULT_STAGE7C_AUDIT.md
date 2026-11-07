# Private Treasury Vault Stage 7C — implementation audit

## Scope and conclusion

This audit distinguishes the existing Stage 7C **document-evidence vault** from a financial **Treasury Vault**. The former is implemented on PR #151; the latter does not yet have a defined gateway API or cryptographic balance-observation receipt in the repository. They must not be conflated.

No financial-vault provider integration is enabled by this change. No live service, credentials, trust keys, database, or deployment are configured or changed.

## Existing Stage 7C document custody

The existing implementation is:

- `server/sponsor-document-custody-v2.mjs`
- `server/sponsor-vault-receipt-v2.mjs`
- `server/sponsor-vault-trust-registry.mjs`
- `tests/sponsor-document-custody-v2.test.mjs`
- `tests/sponsor-vault-receipt-v2.test.mjs`

Its API is an independent scanner `POST /v1/scans`, followed by a private object gateway `PUT /v2/objects/{server-generated-object-key}`. Ed25519 attestations bind the uploaded document digest and byte size. The vault receipt binds an onboarding audience, organization, object key/version, digest, size, media type, SSE-KMS claim, Object Lock retention claim, and the scanner attestation.

This is evidence-file custody. The receipt verifier explicitly returns `payoutAuthorized: false`. A receipt does not establish TRON account ownership, a treasury address, official Mainnet USDT balance, TRX fee balance, Energy/Bandwidth, a spendable credit facility, a signer mandate, or authority to spend funds.

The gateway implementation is also an external prerequisite: repository code verifies the signed claims but does not itself query S3 to prove the gateway actually read back the exact version, encryption configuration, and Object Lock retention. The Stage 7C document correctly leaves that as an independent gateway acceptance requirement.

## Existing treasury components and gaps

### Funding ledger

`server/routes/owner-treasury-funding-ledger.mjs` is owner-session protected and Mainnet-only. It reads the configured treasury's current on-chain USDT/TRX observations, verifies exact inbound official-USDT Transfer evidence before recording an inflow, deduplicates by transaction hash plus log index, and subtracts active reservations. The ledger keeps payout submission disabled.

The current reservation query is still based on `sponsor_direct_payouts.sponsor_address`. That is an individual-sponsor lifecycle table, not a provider-independent private Treasury Vault reservation ledger. It must not be treated as satisfying the requested no-individual-sponsor architecture.

### Withdrawal and reconciliation

`server/routes/treasury-withdrawals.mjs` remains coupled to Fireblocks imports/configuration and has the source-level constant `REAL_VALUE_PAYOUT_EXECUTION_DISABLED = true`. Its existing request, reservation, fee-reserve, and chain-evidence logic is not a provider-independent vault gateway. The hard-disabled route is not to be re-enabled or adapted by this audit.

The current treasury funding ledger and Fireblocks withdrawal route also use different persistence tables. A single, transactionally consistent provider-independent reservation/reconciliation model has not been established by the inspected code.

### Minimum withdrawal amount

The required product policy remains **1,000 USDT** (1,000,000,000 six-decimal base units). The inspected Fireblocks treasury withdrawal route does not contain that minimum check. Since execution is hard-disabled, this audit does not enable a route that could bypass it. The minimum must be enforced in the future provider-independent withdrawal-intent boundary and covered by positive/negative tests before any operational review.

## Financial-vault gateway contract: not yet specified by existing source

The repository does not provide a financial-vault API contract or signed financial observation schema that can safely be wired to the funding ledger. In particular, no existing receipt schema binds all of:

- a unique vault identity and exact TRON Mainnet treasury address;
- official USDT contract and six-decimal token units;
- independently observed spendable USDT balance and native TRX balance;
- observation block number/hash and solidification/finality state;
- Energy and Bandwidth availability and observation time;
- source-of-truth identity, signer authority scope, and revocation state;
- receipt ID, issue/expiry times, idempotency/replay identifier, signing key ID, and a verifiable signature;
- reservation version or ledger sequence needed to prevent stale balance snapshots from releasing already-reserved funds.

The document-vault receipt v2 is not a substitute for this contract. Inventing a financial receipt format or treating a file-storage receipt as financial evidence would create a false-funding vulnerability. Therefore no financial-vault HTTP adapter, ledger credit path, or withdrawal authorization path is added here.

## Required next implementation sequence

1. Specify and independently review the financial-vault observation API and signed receipt schema before writing an adapter.
2. Keep its observer read-only. Verify signature/key status, issuer/audience, exact vault/address/network/token binding, freshness/expiry, finality, balance/resource fields, and replay/idempotency constraints.
3. Keep document custody, financial observations, funding ledger entries, and withdrawal authorization as separate evidence domains.
4. Replace individual-sponsor reservation accounting with one provider-independent treasury reservation ledger. Reconcile all pending, ambiguous, and terminal states atomically; never release an ambiguous reservation without independent chain outcome evidence.
5. Add and test the 1,000 USDT minimum at the withdrawal-intent boundary.
6. Keep Fireblocks excluded, Fincra excluded as a payout source, individual sponsors excluded, and all signing/broadcast routes hard-disabled until a separately authorized architecture and real funded source exist.

## Operational boundary

This work performs no provider contact, credential/key provisioning, signing, transaction creation, broadcast, deployment, production database mutation, or fund transfer. No balance or receipt is represented as proof of spendable funding or payout authority.
