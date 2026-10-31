# Sponsor resource-settlement evidence requirements

## Implemented on the draft PR

The testnet reconciliation path now has a block-bounded history scanner in `server/sponsor-delegation-history.mjs`. The preflight capacity verifier brackets its principal-account and exact fee-sponsor delegation reads with two SolidityNode `getnowblock` reads. It accepts the preflight snapshot only when both reads identify the same solidified block ID, height and timestamp. That anchor and the exact source snapshot are persisted in the resource reservation.

After the transfer is solidified, reconciliation loads that stored preflight evidence and calls the history scanner. The scanner:

1. Re-fetches the exact preflight anchor block by height and checks its block ID and timestamp against the stored anchor.
2. Fetches every intervening block, by exact height, from the SolidityNode `walletsolidity/getblockbynum` endpoint.
3. Checks the height prefix of each block ID, parent-hash continuity, and strictly increasing block timestamps.
4. Re-hashes every returned transaction's `raw_data_hex` and requires it to match the claimed transaction ID.
5. Requires the exact payout transaction ID to appear once, in the exact observed transfer block, with the block timestamp matching the transaction receipt.
6. Fails closed if any relevant Delegate/UnDelegate or freeze/unfreeze transaction changes the fee-sponsor or principal account's resource state during the interval.
7. Rejects intervals larger than 256 blocks; missing blocks, malformed transactions, unexpected contract data, provider errors and incomplete history cannot produce a verified result.

The resulting proof is combined with the post-transfer current source snapshot and checked against the exact preflight snapshot before the database settlement routine may charge resource units. PostgreSQL still enforces reservation ceilings, fee-burn checks, duplicate handling and transactional budget settlement. The default signing/submission gates remain closed.

## Important evidence limitation

This is a **provider-backed historical scan, not a trustless proof**. It uses one authenticated Tatum SolidityNode response stream. The scanner checks block heights, parent links, and transaction raw-data hashes, but it does not independently reconstruct the block-header protobuf hash, verify the witness signature, or prove the returned transaction list against the block's `txTrieRoot` Merkle commitment. These fields remain trusted to the configured node/provider.

For that reason, the code records the trust model explicitly and this adapter is not sufficient by itself for Mainnet release. Before any real-value sponsor settlement gate is opened, add an independently operated second-node comparison or full cryptographic block/transaction inclusion verification, review the supported stake-changing contract set against the active java-tron protocol, and perform a funded testnet pilot under independent review.

## Protocol and API behavior

TRON's `walletsolidity/getblockbynum` returns a block from the SolidityNode view; a returned block is considered solidified. Blocks expose their header, parent hash, timestamp and transaction list. TRON documents block IDs as a composite of block height and the trailing bytes of SHA-256 over the protobuf-serialized header raw data. Transactions expose `raw_data_hex`, and the transaction ID is SHA-256 of the protobuf-encoded raw data.

Official references:
- [GetBlockByNum — SolidityNode](https://developers.tron.network/reference/getblockbynum)
- [TRON block structure and block ID](https://developers.tron.network/docs/block)
- [GetBlockByNum — FullNode](https://developers.tron.network/reference/wallet-getblockbynum)
- [DelegateResourceContract and UnDelegateResourceContract](https://developers.tron.network/docs/delegation)
- [java-tron system contract definitions](https://tronprotocol.github.io/documentation-en/mechanism-algorithm/system-contracts/)

## Remaining work and release boundary

- Add a second independent solidified-node source or implement cryptographic header and transaction-Merkle inclusion verification.
- Review and extend resource-change scanning for any newly introduced stake/delegation contract types before upgrades.
- Add a production database migration, backup and restore rehearsal.
- Run independently supervised Nile/Shasta sponsored transfers with externally funded fee and asset-principal roles, then reconcile the receiver and resource use.
- Complete provider mandate, custody, risk and security review before any Mainnet decision.

This change does not enable Mainnet sponsorship, real-value payouts, Fireblocks withdrawals or any production broadcast. No provider credentials, sponsor funds, live delegations, deployment, merge or blockchain transaction have been configured or performed by this work.
