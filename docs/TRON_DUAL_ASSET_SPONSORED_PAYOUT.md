# TRON Transfer — dual-asset sponsored payout

## Intended payout

A single authorized payout request can deliver two distinct assets to one
recipient address:

1. Native TRX from a separately funded native-TRX payout treasury.
2. Custom TRӾ from the TRӾ token contract.

These are not interchangeable. The native payout treasury is NOT the TRӾ
redemption reserve. The TRӾ token remains a separate TRC-20 asset.

## Contract suite added on this branch

- `TronMetaTxForwarder.sol`: EIP-712/TIP-712 owner-signed requests, chain
  domain, signer nonce, expiry, target allowlist, signature recovery, and
  appended signer address.
- `MetaTxContext.sol`: recipient-side trusted-forwarder sender extraction.
- `Restricted1TRAXMeta.sol`: TRӾ token version that preserves the specified
  owner when a relayer deploys it; supports trusted-forwarder owner calls and
  router-only atomic payout minting.
- `OneTraxReserveVaultMeta.sol`: separate TRX collateral for outstanding
  redeemable TRӾ supply.
- `NativeTRXPayoutTreasury.sol`: separately funded pool for native TRX sent
  directly to recipients.
- `TronTransferPayoutRouter.sol`: calls the native treasury payout and TRӾ
  mint in one EVM transaction. If either leg reverts, both legs revert.

All of these are new contract versions. They do not modify already deployed
contracts. Do not point this router at the legacy non-meta-aware TRӾ or vault.

## Deployment and configuration order

A future sponsor-operated deployment must follow this order, while passing
the configured platform owner explicitly to every constructor:

1. Deploy `TronMetaTxForwarder(initialOwner)`.
2. Deploy `OneTraxReserveVaultMeta(initialOwner, forwarder)`.
3. Deploy `Restricted1TRAXMeta(initialOwner, forwarder)`.
4. Deploy `NativeTRXPayoutTreasury(initialOwner, forwarder)`.
5. Deploy `TronTransferPayoutRouter(initialOwner, forwarder, token, treasury)`.
6. Through owner-signed forwarder calls, allowlist the vault, token, treasury,
   and router as forwarder targets.
7. Authorize the token in the reserve vault; configure the reserve vault in
   the token; set the router once in the token and native treasury.
8. Verify owner, trusted forwarder, target permissions, reciprocal addresses,
   token metadata, and bytecode on the solidified Mainnet.

The deploying sponsor is the transaction sender but is NOT the contract owner.
The supplied `initialOwner` remains the owner. Never omit or substitute that
constructor argument.

## GasFree compatibility

GasFree must not be treated as a generic smart-contract gas sponsor. Its
supported flow is provider-specific and primarily for eligible TRC-20 token
transfers; it does not mint custom TRӾ, deploy contracts, or provide the native
TRX principal sent to recipients. The dual-asset router therefore requires a
separate compatible relayer sponsor for contract execution and an actually
funded native-TRX payout treasury. Do not label this combined payout as
GasFree-supported unless the provider explicitly confirms support for the
exact custom token, contract call, network, and fee model.

## Funding model and solvency

Two different TRX pools are required:

- **TRӾ backing reserve:** must remain at least equal to total outstanding
  redeemable TRӾ supply (raw units, 6 decimals). It supports token redemption.
- **Native payout treasury:** contains the additional TRX that will actually
  be sent to recipients as native TRX.

For a payout of 10 TRX plus 100 TRӾ, the system needs at least 100 TRX of
unencumbered token backing and 10 TRX in the payout treasury, plus sufficient
sponsor resources for contract execution. Gas sponsorship does not create
either asset balance.

## Typed-data signing

The forwarder expects TIP-712/EIP-712 typed data with:
- domain name `TRON Transfer Meta Transaction`, version `1`, current TRON
  EVM chain ID, and the forwarder contract address;
- request signer, target, value, gas limit, nonce, deadline, and calldata.

The owner signs this exact typed request in TronLink. The backend must verify
the exact typed-data domain, signer address, on-chain nonce, request deadline,
allowlisted target, calldata, amounts, and sponsor policy before a relayer
submits it. The current repository does not yet include a production signer
or submission service.

## Current implementation boundary (deliberate)

- The existing readiness endpoint is read-only.
- `POST /api/trax-relayer/submit` is hard-disabled and returns 503.
- No private key is read by the readiness code.
- No transaction is created, signed, or broadcast by this branch's relayer.
- No sponsor wallet exists in the current setup, so sponsor funding/resource
  checks cannot pass.
- There is no audited on-chain deployment or live integration test yet.

## Required before real Mainnet use

1. Review the contracts independently; compile and run adversarial tests for
   signature malleability, nonce reuse, expiry, target changes, reentrancy,
   failed payout rollback, treasury exhaustion, and reserve accounting.
2. Verify TronLink's `tronWeb.trx._signTypedData(domain, types, message)`
   compatibility on the target mobile wallet version. Never silently fall
   back to a personal-message signature.
3. Provision a dedicated sponsor/relayer wallet or protected signer (KMS/HSM),
   with a strict TRX operating budget, limits, monitoring, and emergency stop.
4. Fund and verify the separate native payout treasury and TRӾ backing vault.
5. Deploy only the new matched contract versions with the intended owner.
6. Complete a reviewed testnet end-to-end run before considering Mainnet.
7. Keep production submission disabled until the owner explicitly authorizes
   the audited release.

This code is an implementation scaffold and compilation target, not an audited
production gasless service.
