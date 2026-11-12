# Tron Transfer 1TRAX — testnet architecture

## Selected configuration

- Redemption policy: owner-only. A holder cannot redeem directly or call the burn function.
- Wallet visibility target: automatic discovery, subject to each wallet provider's indexing/listing rules. Bitpie support is not verified and is not promised.
- Deployment: TRON testnet only (Nile or Shasta). The deployment script rejects Mainnet.
- Token: 1TRAX, a separate 6-decimal TRC-20-style token. It is not native TRX and cannot be merged into the native TRX balance row.

## Restricted token rules

contracts/Restricted1TRAX.sol implements the read methods used by TRC-20 wallets (name, symbol, decimals, totalSupply, balanceOf, allowance) plus standard transfer, approve, and transferFrom selectors. The three holder transfer/approval methods always revert. Holders can view balanceOf but cannot transfer, approve, or spend 1TRAX.

Only the immutable contract owner can mint. Minting starts disabled and the contract starts paused; the owner must explicitly unpause and enable minting on testnet. Only the owner can burn a holder's balance through burnForOwnerRedemption, and a non-zero redemption reference is required. The burn function does not send TRX or verify a payout. Operationally, the owner must verify and record the separate TRX payout first, then burn the corresponding 1TRAX amount. Keep minting disabled except during a specifically approved test issuance.

## Separate TRX reserve accounting

The token contract does not hold, mint, or transfer native TRX. The reserve must be a separately controlled TRON address/account. Track these values independently:

1. Actual reserve: confirmed native TRX balance of the dedicated reserve address, read from the selected testnet.
2. 1TRAX liability: totalSupply() from the 1TRAX contract.
3. Owner redemption records: external TRX payout transaction ID, recipient, amount in SUN, 1TRAX amount burned, and an idempotent redemption reference.

Never add reserve TRX and token supply together. A 1:1 backing ratio is only a reconciliation target; it is not established by token metadata or minting. A Mainnet value promise requires real collateral, an enforceable redemption process, independent reconciliation, and security review. Testnet TRX has no real value.

## Wallet visibility and Bitpie boundary

A TRC-20 contract exposes token metadata and balances on-chain. That does not force a wallet to discover, list, display, or price the token automatically. TRON's official issuance guide documents token metadata recording and wallet token-addition workflows. Bitpie's automatic custom-token discovery and portfolio-price support have not been officially confirmed for this project. Treat Bitpie as unverified until Bitpie support provides written confirmation for the exact contract and listing process.

Even if a wallet displays 1TRAX, it will be a separate token asset, not native TRX. Wallet UI may still show a Send action even though the contract rejects transfer transactions. Do not describe a displayed 1TRAX quantity as spendable TRX or a guaranteed USD value.

## Testnet deployment

Compile both contracts with npm run build. To deploy 1TRAX, use a dedicated testnet key and explicitly set:
- TRON_NETWORK=nile (or shasta)
- TRON_PRIVATE_KEY (testnet key only; never commit it)
- DEPLOY_1TRAX_TESTNET=YES

Then run npm run deploy:1trax:testnet. The script contains no Mainnet endpoint and refuses any network other than Nile or Shasta. Deployment requires testnet TRX for Energy/Bandwidth. A returned address is not proof of success: verify a solidified successful receipt and deployed bytecode before recording the address. No deployment was run by this code change.

## Build and verification limits

These changes add source, compile-time ABI checks, and a guarded testnet deployment command. They do not deploy a contract, create a TRX reserve, issue tokens, connect Bitpie, establish a market price, or enable Mainnet operations. Mainnet deployment requires testnet validation, independent security review, Bitpie written confirmation, and explicit owner approval.
