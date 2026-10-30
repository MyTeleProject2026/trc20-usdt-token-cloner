# Dual-testnet VTRC deployment and sponsor configuration

## Important identity boundary

The repository's `contracts/IndependentTRC20.sol` is an independent test token. It is not Tether USDT, is not redeemable for USDT, and cannot credit a Mainnet exchange deposit.

The contract intentionally fixes:
- name: `TRC20`
- symbol: `VTRC`
- decimals: `18`

Its constructor is:

```solidity
constructor(
  string memory tokenName,
  string memory tokenSymbol,
  uint256 initialWholeTokenSupply,
  address recipient
)
```

The constructor accepts only `TRC20` as the name and `VTRC` as the symbol. The initial supply is a positive whole-token quantity and is minted once to the specified recipient.

## Deploy separately to each network

Each deployment produces a different contract address. Never copy the address from Nile into Shasta configuration or vice versa.

For each network, the organization-appointed testnet operator must:

1. Use a dedicated test-only TRON wallet. Do not use a production treasury wallet.
2. Select exactly one network in TronLink: Nile first, then repeat separately for Shasta.
3. Obtain testnet TRX from the corresponding official faucet and confirm the deployer has enough Energy/Bandwidth or test TRX to pay deployment costs.
4. Open the official TRON deployment workflow (TronIDE, TronBox, or a reviewed TronWeb deployment tool) and compile the repository's exact `IndependentTRC20.sol` source using Solidity 0.8.20-compatible settings.
5. Set the constructor arguments:
   - `tokenName`: `TRC20`
   - `tokenSymbol`: `VTRC`
   - `initialWholeTokenSupply`: a modest positive whole-token amount approved for the test
   - `recipient`: the dedicated testnet asset-principal wallet address
6. Review the selected network, compiled contract, constructor arguments, deployer, recipient, and fee limit in the wallet. The authorized operator signs the deployment transaction in their own wallet.
7. Record the transaction ID and the contract address returned by the actual deployment. Do not invent an address from the deployer address or transaction ID.
8. Independently verify on that network's explorer that the deployment is solidified and the deployed bytecode/source and constructor values match the reviewed source.
9. Read `name()`, `symbol()`, `decimals()`, `totalSupply()`, and `balanceOf(recipient)` from that same network. Require `TRC20`, `VTRC`, 18 decimals, the expected supply, and the expected recipient balance.
10. Save the actual network, deployer, recipient, contract address, transaction ID, block height, verification time, and operator approval reference in the organization's test evidence record. Do not place private keys or recovery phrases in that record.

Repeat the full process from step 1 on the other testnet. Each network needs its own deployment evidence.

## Backend allowlist configuration

After both contract deployments have been independently verified, an authorized sponsor administrator may add the exact addresses to the backend Render Web Service only:

```env
SPONSOR_VTRC_NILE_CONTRACTS=<actual-solidified-Nile-VTRC-contract-address>
SPONSOR_VTRC_SHASTA_CONTRACTS=<actual-solidified-Shasta-VTRC-contract-address>
```

Use comma-separated addresses only when the organization has approved more than one contract for that same network.

Do not put these VTRC addresses in `SPONSOR_USDT_NILE_CONTRACTS` or `SPONSOR_USDT_SHASTA_CONTRACTS`. Do not add them to Mainnet USDT configuration. The real Mainnet USDT contract is a different asset and remains pinned by the backend.

The backend request-intake route will accept a VTRC request only when the submitted address is present in the exact network's VTRC allowlist. This environment allowlist is an operator configuration control; it does not replace the deployment metadata and solidified-chain checks above.

## Admin credential handling

`SPONSOR_ADMIN_API_TOKEN` is a privileged server-only credential used by multiple sponsor administration routes, not merely this review queue. It must be generated and installed by the appointed adult administrator of the actual sponsor organization using its approved secret-management process.

Do not generate it in ChatGPT, a public password generator, a browser form that stores values, GitHub, or a frontend variable. Store it only in the Render backend environment and the organization's approved secret manager. Do not share it in chat.

The person who can view the sponsor queue is not automatically authorized to activate a budget, approve a transfer, sign a transaction, or use Fireblocks. Keep those roles and approval quorums separate.

## Acceptance criteria

A deployment is **not ready for use** until both network records include:
- exact network and chain identifier;
- real deployment transaction ID and contract address;
- solidified deployment proof;
- verified source/bytecode;
- `name = TRC20`, `symbol = VTRC`, `decimals = 18`;
- expected total supply and recipient balance;
- operator and organization approval reference;
- backend allowlist entry matching the exact same address.

Even after these checks, VTRC is testnet-only and has no Mainnet monetary value. This procedure does not enable transfer submission or Mainnet payout execution.
