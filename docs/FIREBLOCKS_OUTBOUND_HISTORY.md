# Fireblocks outbound-history reconciliation

This facility records outgoing transfers from the configured Fireblocks TRON vault and reconciles them against the app's USDT/TRX withdrawal request tables. It is a read-only provider integration: it only calls Fireblocks GET endpoints and writes the resulting evidence to PostgreSQL. It never creates, approves, signs, cancels or broadcasts a transfer.

## Owner endpoints

Both endpoints require the existing mainnet owner wallet session, Authorization: Bearer <owner-session>, and the configured frontend Origin.

    GET /api/treasury/fireblocks/outbound-history/status

    POST /api/treasury/fireblocks/outbound-history/sync

The sync endpoint verifies the configured Fireblocks Vault Account ID and that the configured USDT and native TRX assets are active before it reads history. It starts the initial scan at after=1 millisecond (Unix epoch) and fixes an explicit before timestamp for the scan. The first scan therefore does not rely on an operator-entered vault-creation timestamp. Both time bounds are always supplied; the Fireblocks API otherwise applies a moving default 90-day window when after or before is omitted.

The request sets sourceType=VAULT_ACCOUNT, sourceId=FIREBLOCKS_VAULT_ACCOUNT_ID, orderBy=createdAt, sort=ASC and limit=500. It reads Fireblocks' next-page response header and supplies that cursor as the next request's next query parameter. The API permits a maximum page size of 500. See the official [Get transaction history API reference](https://fireblocks.readme.io/reference/gettransactions).

A single HTTP request reads at most 20 pages (up to 10,000 provider records). When another page remains, the API returns HTTP 202 with status=scanning and persists the cursor. Run the same sync endpoint again to continue. The status endpoint and payout readiness remain blocked while the scan is partial, blocked, stale, or otherwise incomplete.

## Reconciliation rules

The parser currently accepts only outgoing TRANSFER operations for the configured Fireblocks TRON USDT asset ID and native TRX asset ID. It validates:

- Provider transaction ID, source type and exact configured source vault ID.
- Supported asset ID and an exact decimal amount with at most six decimals.
- Provider status, transaction creation time and any supplied chain transaction hash.
- A recognized destination type and its destination identity. An application payout must match the app's one-time TRON destination.

App-created requests are matched by their external transaction ID (the app idempotency key) and/or the Fireblocks provider transaction ID. A match must have the same asset, amount and recipient. A committed app request with a provider transaction ID that is absent from Fireblocks history is a blocker. Mismatched, duplicate or ambiguous matches are blockers.

Any unmatched Fireblocks transfer from the configured vault is treated as an external outflow. The system totals USDT and TRX separately. External USDT outflows are added to the app's committed USDT withdrawals before calculating the remaining third-party principal ceiling. Fireblocks feeInfo.networkFee is also parsed in six-decimal native TRX units, and only fees identified as paid by this exact vault (or its explicitly identified local relay) are deducted from the authorized sponsor TRX fee pool. Third-party relay fees and fees paid by a different local vault are not charged to this vault's sponsor pool. A chain-hash-bearing transaction with missing feeInfo, an unknown fee currency, or ambiguous relay identity blocks the scan. External TRX transfer amounts and vault-paid network fees are reported separately; current Fireblocks-available and on-chain TRX balances remain additional live fee-reserve controls. Final Fireblocks failure/cancellation statuses without a chain hash are not counted as a completed asset outflow; all other unmatched transfers remain reserved conservatively.

A non-TRANSFER operation, unrecognized asset, malformed amount, invalid source, unknown destination or incomplete record blocks the whole scan. This conservative first version intentionally does not infer the asset effects of contract calls, raw transactions, staking operations or other unsupported operation types. Such activity must be reviewed and supported by an explicit parser before it can be treated as reconciled.

The latest completed scan is considered fresh for 10 minutes. Readiness and both payout POST handlers require a fresh completed scan. The readiness response exposes the checked time, age, transaction count, reconciliation digest and external outflow amounts. thirdPartyFunding.externalOutboundHistoryVerified is true only when the stored scan is complete, the treasury and vault identity still match, the configured asset IDs still match, no reconciliation blocker exists, and the scan is within the freshness window.

## Operational limitations

- The history scan covers the API history returned for the configured vault. The Fireblocks API role must have permission to read the workspace transaction history. If the provider rejects a history request or returns an unsupported record shape, the scan remains blocked.
- A status=complete response is provider-history reconciliation, not independent proof that each Fireblocks transaction has a successful solidified TRON receipt. The existing withdrawal verifier still performs separate chain receipt and exact transfer-event checks.
- A history scan is a point-in-time view. It is not a lock on the Fireblocks vault and cannot prevent an administrator from creating a new outgoing transaction immediately after the scan. For that reason it is only one prerequisite; it must never be interpreted as a replacement for Fireblocks transaction policy, dual approval, live available-balance checks, owner authorization and the remaining production release controls.
- The application currently retains the immutable build-time REAL_VALUE_PAYOUT_EXECUTION_DISABLED guard. Completing this scan does not enable real-value withdrawals. No production transfer has been tested or authorized by this change.
