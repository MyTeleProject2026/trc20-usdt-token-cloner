# External sponsor operating policy — official Tether USDT only

## Supported asset and network

The asset-principal product scope is **official Tether USDt (USDT), TRC-20, on TRON Mainnet only**.

The official contract is pinned in backend code:
- Network: `mainnet`
- Contract: `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`
- Decimals: `6`

No other token contract, testnet token, symbol, or independently deployed TRC-20 asset can be represented as Tether USDT or used for an official-USDT payout. Nile and Shasta remain development networks for read-only checks and TRX fee/resource diagnostics; they are not Tether USDT payout networks.

Native TRX may be used for network fees or resource delegation. It is not the payout principal.

## Funding model

The project owner does not need to hold the USDT personally when an actual treasury-owning organization has contractually agreed to fund the payout program and has independently authorized the exact transfers.

Two different requirements must be satisfied:
1. **USDT principal:** an organization-owned production treasury vault must hold genuine official Mainnet USDT.
2. **Network fees/resources:** the authorized treasury or a separately contracted fee/resource sponsor must cover the required TRX/Energy/Bandwidth costs under an approved policy.

A fee sponsor does not supply USDT principal. A funded balance does not prove consent or authority. An API key, environment variable, pending request, database row, or UI display cannot create funds or authorize a transfer.

## No-charge and fail-closed requirements

- Never debit the end user's wallet as a hidden fallback for a sponsor-funded request.
- Never fabricate a token balance, transaction ID, receipt, or exchange deposit.
- Never classify a testnet token or another TRC-20 contract as official Tether USDT.
- Reject a request if the treasury or sponsor is unavailable, paused, depleted, unauthorized, or cannot cover the exact USDT amount and approved fee reserve.
- Bind every request to the Mainnet network, official token contract, six decimals, exact recipient, integer base-unit amount, owner authorization and unique idempotency key.
- Keep sponsor credentials and Fireblocks API authentication material on the backend only.
- Reconcile principal and fee/resource costs using independently verified, solidified chain evidence.
- A solidified TRON transfer is not proof that an exchange credited a deposit. The receiving exchange's own deposit record is required.

## Production activation gates

All gates are mandatory and must be evidenced independently:

1. Written approval from the actual treasury-owning legal organization, with a named authorized adult representative and clear authority to use the treasury.
2. A production Fireblocks workspace and dedicated TRON vault owned by that organization.
3. Verified Fireblocks asset metadata for official TRON USDT and native TRX, matching the exact vault address.
4. A dedicated, least-privilege Fireblocks API user, completed approval quorum, secure RSA API authentication file, and restrictive transaction policies.
5. Genuine official USDT and adequate native TRX in the vault, verified independently through Fireblocks and TRON Mainnet.
6. Per-transfer and daily limits, recipient controls, owner authorization, atomic budget reservation, idempotency, emergency stop, monitoring, and failure recovery.
7. A controlled test and independent security review, followed by written production release approval.

## Current application state

The Mainnet wallet UI can create a signed **payout request for organization review**. The new API pins the request to official Tether Mainnet USDT and records it as `pending-organization-review`.

That request does not reserve a budget, issue a Fireblocks instruction, create a blockchain transaction, sign a transfer, or send funds. The existing backend constant `REAL_VALUE_PAYOUT_EXECUTION_DISABLED = true` remains in place. Both payout environment flags remain false.

There is no verified external sponsor agreement, Fireblocks production approval, vault funding, or production release approval recorded in this project. Therefore genuine Mainnet payout execution remains unavailable.

## Exchange settlement

A real, solidified Mainnet transfer proves only that the token contract transferred USDT to the recipient address. Exchange credit depends on the receiving exchange's accepted network/asset, minimum deposit, required confirmations, memo/tag requirements, compliance review, and its own deposit-processing status. The application must not claim an exchange credit without an authorized exchange record.
