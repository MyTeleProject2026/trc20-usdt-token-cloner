# TRӾ Mainnet source-verification handoff

The frontend build now generates a reproducible TRONSCAN verification bundle at:

`dist/trax-verification/tronscan-standard-json-verification.json`

Generate it without running the full frontend build:

```sh
npm run verification:bundle --prefix Frontend-Tron-Transfer
```

The generator compiles the repository's `contracts/Restricted1TRAX.sol` using the same pinned Solidity compiler and settings as the deployment artifact:

- Solidity compiler: 0.8.25
- EVM version: Paris
- Optimizer: enabled, 1 run
- Source unit: `Restricted1TRAX.sol`
- Constructor arguments: empty (the constructor takes no arguments)

The JSON contains the Solidity Standard JSON input, compiler metadata, and a SHA-256 digest of the compiled runtime bytecode. Keep this bundle with the deployment release so the source submitted to TRONSCAN can be reproduced exactly.

## After a confirmed Mainnet deployment

1. Obtain the contract address from the confirmed deployment receipt and verify it against the solidified transaction.
2. Open TRONSCAN's contract source-code verification flow for that exact address.
3. Submit the compiler version, EVM version, optimizer settings, source unit and Standard JSON input from the generated bundle.
4. Confirm the compiler's runtime bytecode matches the deployed contract.
5. Record the TRONSCAN verification result and URL in the release record.

The generator deliberately leaves `contractAddress` null and sets `verificationStatus` to `not-submitted-no-deployed-address`. It does not call TRONSCAN, deploy a contract, or claim that source verification is complete. Source verification remains pending until an actual Mainnet address exists and TRONSCAN confirms the submitted source.
