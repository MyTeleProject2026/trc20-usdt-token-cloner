# Tron Transfer 1TRAX — testnet architecture

## Selected configuration

- Redemption policy: owner-only. Holders cannot redeem directly; the owner initiates an atomic redemption on a holder's behalf.
- Wallet visibility target: automatic discovery, subject to each wallet provider's indexing/listing rules. Bitpie support is not verified and is not promised.
- Deployment: TRON testnet only (Nile or Shasta). The deployment script rejects Mainnet.
- Token: 1TRAX, a separate 6-decimal TRC-20-style token. It is not native TRX and cannot be merged into the native TRX balance row.

## Restricted token and reserve contracts

The architecture uses two separate contracts:

1. contracts/OneTraxReserveVault.sol holds native TRX. It accepts deposits but has no owner withdrawal method. Once the owner authorizes the 1TRAX contract, only that token contract can release TRX for a redemption.
2. contracts/Restricted1TRAX.sol maintains the 1TRAX balances and supply. It exposes standard read methods (name, symbol, decimals, totalSupply, balanceOf, allowance) but transfer, approve, and transferFrom always revert.

The token starts paused with minting disabled. The owner must link the vault and explicitly unpause/enable minting. Each mint checks that vault native TRX balance is at least the post-mint 1TRAX supply, using matching 6-decimal base units. This prevents issuance above the on-chain reserve at mint time.

Only the owner can call redeemForOwner(holder, recipient, amount, reference). The token contract burns the holder's 1TRAX and calls the vault to pay the same amount of native TRX in the same transaction. If the vault cannot pay or the transfer fails, the whole transaction reverts and the burn is undone. Holders cannot invoke redemption themselves. The vault has no separate owner withdrawal path, so its reserve cannot be removed except through this owner-authorized token redemption path.

## Separate reserve accounting

The reserve and token liability remain separate on-chain:
- Native TRX reserve = address(this).balance in the dedicated OneTraxReserveVault.
- 1TRAX liability = totalSupply() in the Restricted1TRAX contract.
- Owner redemption = one atomic token burn plus native TRX release, with the same reference hash emitted by both contracts.

Never add reserve TRX and token supply together. Compare them as separate quantities in the reconciliation panel. A 1:1 backing target is enforced at mint time and maintained by the only vault release path, but it is not a market-price guarantee or USD oracle. The reserve address and token contract must be independently checked on the selected testnet.

The owner-only endpoint GET /api/ripple-custody/1trax/accounting reads the vault's native TRX balance and token totalSupply separately. Configure ONE_TRAX_NETWORK=nile or shasta, ONE_TRAX_RESERVE_ADDRESS (the vault contract address), and ONE_TRAX_CONTRACT_ADDRESS on the backend. It rejects Mainnet and returns a read-only node snapshot. Verify solidification and reserve contract ownership before relying on a displayed ratio.

## Wallet visibility and Bitpie boundary

A TRC-20 contract exposes token metadata and balances on-chain. That does not force a wallet to discover, list, display, or price the token automatically. TRON's official issuance guide documents token metadata recording and wallet token-addition workflows. Bitpie's automatic custom-token discovery and portfolio-price support have not been officially confirmed for this project. Treat Bitpie as unverified until Bitpie support provides written confirmation for the exact contract and listing process.

Even if a wallet displays 1TRAX, it will be a separate token asset, not native TRX. Wallet UI may still show a Send action even though the contract rejects transfer transactions. Do not describe a displayed 1TRAX quantity as spendable TRX or a guaranteed USD value.

## Testnet deployment

Compile all contracts with npm run build. To deploy the vault and token, use a dedicated testnet key and explicitly set:
- TRON_NETWORK=nile (or shasta)
- TRON_PRIVATE_KEY (testnet key only; never commit it)
- DEPLOY_1TRAX_TESTNET=YES

Then run npm run deploy:1trax:testnet. The script contains no Mainnet endpoint and refuses any network other than Nile or Shasta. It deploys the reserve vault and token, waits for solidified successful receipts, verifies bytecode, links both contracts, and checks that the token remains paused with minting disabled. Deployment requires testnet TRX for Energy/Bandwidth. No deployment was run by this code change.

After deployment, fund the dedicated vault with testnet TRX. Do not enable minting until reserve funding is verified. Test minting only up to the funded reserve, verify holder balance visibility, confirm transfer/approval calls revert, and test owner redemption paying native testnet TRX while burning the same amount of 1TRAX.

## Build and verification limits

These changes add source, compile-time ABI checks, read-only accounting, and a guarded testnet deployment command. They do not deploy contracts, fund the reserve, issue tokens, connect Bitpie, establish a market price, or enable Mainnet operations. Mainnet deployment requires testnet validation, independent security review, Bitpie written confirmation, and explicit owner approval.
