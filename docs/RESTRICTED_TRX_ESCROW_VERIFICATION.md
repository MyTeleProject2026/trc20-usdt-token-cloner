# Restricted TRX escrow verification and collateral reconciliation

## Implemented read-only verification

The backend route is `GET /api/restricted-trx/escrow/verify/:requestId/:txid`. It is mounted in `server/index.mjs` and requires the existing Mainnet owner wallet session. It reads the Bitpie beneficiary, audited escrow contract address, provider address stored immutably in the contract, transaction body and receipt, contract position, aggregate liabilities, and actual contract account balance from TRON solidified state.

The strict verifier in `server/restricted-trx-escrow-verifier.mjs` binds the evidence end to end:
- a matching transaction ID and positive solidified block receipt;
- successful smart-contract execution;
- exactly one native-TRX `TriggerSmartContract` calling `fundPosition(bytes32,address,uint64)`;
- exact escrow contract destination and the provider address returned by the contract's immutable `provider()` getter;
- matching request ID and beneficiary in the transaction calldata;
- matching `PositionFunded(bytes32,address,uint256,uint64)` event emitted by the escrow contract;
- exact equality of transaction `call_value`, event amount, and stored position amount;
- exact equality of event unlock time and contract position unlock time;
- unclaimed beneficiary position; and
- actual escrow contract TRX balance greater than or equal to `totalLockedSun()`.

Any missing, inconsistent, failed, or under-collateralized evidence is rejected and returns zero creditable amount. The UI now asks for both request ID and funding transaction ID and displays explorer links only after server-side verification.

## Owner and Mainnet configuration

Set server-side environment variables:
- `TREASURY_OWNER_ADDRESS`: must match the Mainnet address used to sign in to the private owner panel.
- `RESTRICTED_TRX_ESCROW_CONTRACT`: deployed and audited Mainnet contract address.
- `RESTRICTED_TRX_BENEFICIARY_ADDRESS`: exact recipient address (defaults in the route to the Bitpie address currently configured in the UI).
- `TRONGRID_API_ORIGIN=https://api.trongrid.io`.
- `TRONGRID_API_KEY`: optional for development, recommended for production quota and service reliability.

Never put TronGrid or provider keys in a `VITE_*` variable or commit their values. The public API adapter restricts requests to the approved HTTPS TronGrid origin and uses `/walletsolidity/` endpoints.

## Important limitation

This verifier proves a **contract-held restricted TRX position linked to the Bitpie address**. It does not create a normal Bitpie wallet deposit, change Bitpie's spendable account balance, or cause the Bitpie app to display an internal restricted balance. A separate Bitpie integration would require explicit support from Bitpie itself.

A contract-held TRX position requires real TRX principal deposited into the contract. The payable contract call also consumes network resources; the provider or another explicitly authorized sender/sponsor must pay the actual costs. A public TRON API cannot mint principal or pay fees.

## Not yet enabled

- No audited Mainnet escrow address is configured by this repository.
- No Ripple principal-credit agreement or native-TRX escrow fee-credit agreement is verified.
- No Ripple-specific signing/submission adapter is implemented.
- No escrow funding, direct payout, or release transaction is broadcast by the verification route.
- The existing live payout hard gate remains in place.

Do not mark a position funded until the API returns `verified: true` after solidified chain reads; do not treat a provider balance field or a normal Bitpie address balance as escrow credit.
