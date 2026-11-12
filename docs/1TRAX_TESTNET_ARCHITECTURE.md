# Tron Transfer TRӾ (TRX ticker) — TRON Mainnet architecture

## Selected configuration

- Network: TRON Mainnet only. No testnet deployment path is provided by this deployment command.
- Token metadata: name `TRӾ`; symbol `TRX`; decimals 6.
- Important identity disclosure: this is a custom TRC-20 token. It is NOT native TRX, is not issued by the TRON network, cannot become the native TRX balance, and must never be represented as official TRX. The symbol collision can confuse users and wallet interfaces. Obtain legal/compliance review and consider a distinct ticker before any public issuance.
- Redemption: owner-initiated only. Holders cannot initiate redemption.
- Wallet visibility: Bitpie automatic discovery is unverified and cannot be guaranteed by contract code.
- Mainnet deployment is irreversible. The script requires a dedicated Mainnet key and an explicit acknowledgement string. This repository change does not run it.

## Restricted token and reserve contracts

The architecture uses two separate contracts:

1. contracts/OneTraxReserveVault.sol holds native TRX. It accepts deposits but has no owner withdrawal method. Only the linked TRӾ token contract can release native TRX for an owner-initiated redemption.
2. contracts/Restricted1TRAX.sol maintains the custom TRӾ token balances and supply. It exposes metadata and balance reads but transfer, approve, and transferFrom always revert.

The token starts paused with minting disabled. The owner must link the vault and explicitly unpause/enable minting. Each mint checks that vault native TRX balance is at least the post-mint token supply, using matching 6-decimal base units. This is an on-chain reserve check at mint time, not a market-price oracle.

Only the owner can call redeemForOwner(holder, recipient, amount, reference). The token burns the holder's custom TRӾ balance and the vault pays the same amount of native TRX atomically. If the vault cannot pay, the whole transaction reverts. Holders cannot invoke redemption themselves.

## Separate accounting

- Native TRX reserve = native TRX held by the dedicated vault.
- Custom TRӾ liability = totalSupply() of the TRC-20 contract.
- Never add these quantities together or describe the custom token as native TRX.
- A 1:1 reserve ratio is not a guaranteed market price, USD value, or wallet display promise.

The owner-only endpoint GET /api/ripple-custody/1trax/accounting reads Mainnet reserve and token supply separately. Configure ONE_TRAX_RESERVE_ADDRESS (vault contract) and ONE_TRAX_CONTRACT_ADDRESS (token contract) on the backend. The endpoint uses the official TRON Mainnet node endpoint and validates both addresses.

## Bitpie boundary

A TRC-20 contract cannot force Bitpie to discover or list a token automatically. Bitpie must confirm support for this exact contract, metadata, and listing/discovery process in writing. Even if displayed, this asset is a separate custom token, not native TRX. A wallet may expose a Send button while the contract rejects transfers.

## Mainnet deployment command

The script compiles and deploys both contracts to TRON Mainnet, links the vault and token, waits for solidified receipts, verifies bytecode, and checks that minting remains disabled. It requires:

- `TRON_PRIVATE_KEY`: dedicated Mainnet deployer key, stored only in a secure local secret manager.
- `DEPLOY_1TRAX_MAINNET=I_UNDERSTAND_MAINNET_DEPLOYMENT_IS_IRREVERSIBLE`: explicit deployment acknowledgement.
- Optional `TRON_MAINNET_DEPLOYER_ADDRESS`: expected address to guard against using the wrong key.

Run `npm run build` before considering deployment. The command `npm run deploy:trx-mainnet` broadcasts irreversible Mainnet transactions and must only be run after independent smart-contract audit, legal/compliance review of the TRX ticker collision, reserve and redemption operational controls, and explicit owner approval. No private key or secret should be committed or shared in chat.

## What remains external

- No deployment, reserve funding, mint, or redemption was performed by this code change.
- Bitpie automatic token discovery and pricing remain unverified.
- A reserve-backed contract does not establish a market price or guaranteed USD valuation.
- Ripple Custody authentication and writes remain separate from this token contract and are not enabled by this change.
