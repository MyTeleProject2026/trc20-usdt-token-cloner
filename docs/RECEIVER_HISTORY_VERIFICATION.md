# Receiver History and Transfer Verification

## Purpose

This document defines a read-only, evidence-based receiver history flow. It must never create balances locally, fabricate transaction IDs, or label a token as official USDT unless its contract address is verified against the official issuer's published information for the selected network.

## 1. Discover transfer history

Use a TRON indexer only to discover candidate records:

`GET https://api.trongrid.io/v1/accounts/{address}/transactions/trc20?only_confirmed=true&limit=20&order_by=block_timestamp,desc`

Optional filters:
- `contract_address`: the exact token contract to inspect.
- `fingerprint`: opaque pagination value returned in `meta.fingerprint`; keep all other filters unchanged while paging.
- `only_to=true`: incoming transfers only.
- `only_from=true`: outgoing transfers only.

Keep provider credentials on the server. Validate the account and contract addresses before sending upstream requests. Bound page size (maximum 200), apply rate limits, and never let a caller provide an arbitrary upstream URL. Indexed history can be delayed and is not final settlement proof.

## 2. Verify final transaction state

For every candidate transfer, query a reliable TRON node's solidified state:
1. `/walletsolidity/gettransactionbyid` must return the transaction body.
2. For a smart-contract transaction, `/walletsolidity/gettransactioninfobyid` must return a receipt.
3. Require the top-level receipt result not to be `FAILED` and `receipt.result` to equal `SUCCESS`.
4. Inspect only a valid `Transfer(address,address,uint256)` event emitted by the expected, allow-listed token contract.
5. Decode and compare the sender, receiver, and raw integer amount. Convert using the token contract's actual decimals, not a hard-coded USDT assumption.
6. If the solidified transaction body or receipt is not available yet, report `pending-verification` and retry later. Do not infer failure from one empty response.

An indexer record alone, a broadcast acknowledgement, a transaction body without its receipt, or an event from an unreviewed contract is insufficient for marking a smart-contract transfer as complete.

## 3. Receiver balance display

A displayed token balance must be read from the actual token contract on the selected network, using a read-only contract call or a reputable indexer, and must show the network and full contract address. Never combine local demo balances with on-chain balances. Any simulator must be visibly labelled `SIMULATION ONLY` and `NOT ON-CHAIN`.

For USDT on TRON mainnet, use only the official contract address published by Tether and independently verify it before allow-listing. An independently deployed token with a similar name or symbol is not official USDT and cannot alter another wallet's USDT balance.

## 4. Security boundaries

- No server-side private keys, seed phrases, or signature requests that bypass the sender's wallet.
- No hidden mint, arbitrary balance override, fake transfer event, or spoofed transaction receipt.
- A genuine transfer requires a valid transaction authorized by the token holder (or an explicit, on-chain allowance/authorization mechanism).
- Sponsored fees remain disabled until a real provider or funded sponsor is configured, the sponsor's consent and budget limits are recorded, testnet lifecycle tests pass, and a security review approves the release.
- Do not claim a fee is sponsored if the sender or receiver is actually charged by a provider.

## 5. Acceptance tests

1. Invalid TRON address and malformed transaction ID are rejected before any upstream call.
2. Provider failure, timeout, rate limiting, or malformed response is surfaced as an error, not an empty successful history.
3. Pagination is bounded and forwards only the provider's opaque fingerprint.
4. Unconfirmed indexer records never display as completed transfers.
5. A missing solidified receipt yields `pending-verification`.
6. Failed contract execution yields `failed`, never `confirmed`.
7. An event emitted by the wrong contract, or with a different recipient or amount, is rejected.
8. Balance results show network, contract address, decimals, and source timestamp.
9. No endpoint accepts a private key or submits a transaction on behalf of a wallet holder.
10. Sponsor status remains disabled until provider, funding, and review gates pass.

## Official references

- TRC-20 history endpoint: https://developers.tron.network/docs/get-trc20-transaction-history
- Confirmation semantics: https://developers.tron.network/docs/confirmation-semantics
- Sign and broadcast lifecycle: https://developers.tron.network/docs/api-signature-and-broadcast-flow
