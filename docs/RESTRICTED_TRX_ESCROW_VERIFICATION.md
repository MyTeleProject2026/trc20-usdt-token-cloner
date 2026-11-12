# Restricted TRX escrow verification and collateral reconciliation

The owner panel must not mark a Bitpie-linked restricted position as credited from a dashboard entry, a normal address balance, or a transaction broadcast response.

The pure fail-closed verifier is `server/restricted-trx-escrow-verifier.mjs`. It requires:
- transaction ID and matching solidified receipt with a positive block number;
- successful contract execution;
- a native TRX `TriggerSmartContract` call with nonzero `call_value`;
- beneficiary-specific contract position, positive amount, valid unlock time, and unclaimed status;
- actual escrow contract TRX balance greater than or equal to aggregate locked liabilities.

Any missing evidence or under-collateralization returns `verified: false` and `creditableAmountSun: "0"`.

Important limitation: this is a pure evidence-validation building block, not a complete live chain fetcher, deployed contract, custody system, or Bitpie integration. The current contract ABI must be checked against the deployed audited contract before wiring it to production. Aggregate liabilities must come from an independently reconciled on-chain source, not an operator-entered number.

## Can this be funded without spendable TRX?

No. A contract-held TRX position requires actual TRX to be transferred into the contract. It can then be locked and non-spendable by the beneficiary until contract-defined conditions permit release. But the depositor/provider must supply real TRX, and the transaction needs Bandwidth/Energy or TRX fees paid by the sender or an authorized sponsor.

A public TRON API cannot mint principal, create a restricted Bitpie balance, or pay fees. A public explorer can verify existing on-chain state only.

## Bitpie display

An external TRON smart contract cannot change the ordinary balance displayed inside Bitpie for an address. The contract can hold TRX and expose a beneficiary-specific locked position that Tron Transfer displays. Bitpie's own app would need to add explicit support for that contract/token/position to show it natively. Do not claim a normal Bitpie wallet deposit has occurred.
