# Testnet sandbox preview

## Scope

The `#/testnet-sandbox` route is a browser-memory-only form validation and review tool. It supports Nile and Shasta labels only. Mainnet is explicitly rejected.

The sandbox does not:
- connect to TronLink or another wallet provider;
- request or store a seed phrase, private key, password, or signature;
- call a TRON RPC endpoint or token contract;
- query account balances, token deployment, or network state;
- create, sign, or broadcast a transaction;
- generate a transaction ID or persist a simulated payment record.

## Preview semantics

A successful preview means only that local input-format and decimal-precision checks passed. The TRON address check covers Base58 alphabet and length only; it is not a checksum or account-existence check. The selected token contract and token symbol are user-entered display values and are not verified on-chain.

The result always has `status=preview-only`, `signatureRequested=false`, `broadcasted=false`, `networkRequestMade=false`, and `transactionId=null`.

## Running checks

```sh
npm test
npm run build
```

Do not interpret a passing unit test or a local preview as proof of a successful testnet transaction. Any future network-connected test must be separately designed, isolated from Mainnet, and reviewed by an appropriately authorized adult operator.
