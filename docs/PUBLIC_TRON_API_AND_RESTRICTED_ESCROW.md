# Public TRON API integration (read-only)

## What it provides

The admin backend can query the official TRON solidified-node HTTP API through the public TronGrid node endpoint:
- `POST /walletsolidity/getaccount`: solidified native TRX account balance (returned in SUN).
- `POST /walletsolidity/getaccountresource`: solidified bandwidth and energy resource usage.
- `POST /walletsolidity/gettransactionbyid` and `POST /walletsolidity/gettransactioninfobyid`: transaction body and execution receipt.

Official API guide: https://developers.tron.network/docs/api

The implementation is in `server/public-tron-read-client.mjs`. It only performs read requests. It does not create wallets, sign transactions, broadcast transactions, provide TRX principal, sponsor fees, or make an ordinary Bitpie wallet balance restricted.

## HTTP routes

- `GET /api/public-tron/account/:address`
- `GET /api/public-tron/resources/:address`
- `GET /api/public-tron/transaction/:txid`

These are backend routes behind the existing owner/API credential guard. The API key is optional for initial low-volume tests, but production usage should use a TronGrid API key, respect quota/rate limits, and keep it server-side in `TRONGRID_API_KEY`.

## Restricted escrow accounting

A normal TRON address balance is not a restricted balance. Public chain APIs cannot mint, credit, or lock TRX. The escrow balance must be the real TRX balance held by an audited smart contract with beneficiary-specific locked accounting. A beneficiary UI can show that on-chain escrow position, but this is a separate display and is not the Bitpie app's ordinary spendable balance.

Do not credit a position based only on an account balance query. For escrow deposits, independently verify the solidified transaction receipt, successful contract execution, exact native TRX call value, expected contract event/request ID, beneficiary, and contract getter state. Reconcile total locked liabilities against the escrow contract's actual TRX balance.

## Funding and fees

Public node APIs are infrastructure, not a funding source. Any transaction that deposits TRX into escrow requires actual TRX principal. TRON transaction execution also consumes Bandwidth and, for contract calls, Energy; if the sending account lacks sufficient resources, the protocol charges TRX. The initiating account or an explicitly authorized fee sponsor must cover those costs. See https://developers.tron.network/docs/api and https://developers.tron.network/docs/account.

## Safety

- The read adapter only permits the official HTTPS TronGrid origin.
- Addresses and transaction IDs are validated.
- Reads use `/walletsolidity/` for solidified state.
- No private key, seed phrase, signing, broadcast, or withdrawal API is included.
- Provider principal-credit readiness and live payouts remain hard-disabled.

## Frontend display

`Frontend-Tron-Transfer/src/RestrictedTRXEscrow.jsx` now requests the configured Bitpie address through the owner-authenticated `/api/public-tron/account/:address` route and displays its solidified ordinary TRX balance separately from the contract-held escrow position. The UI explicitly labels the ordinary address balance as spendable and not restricted. The escrow viewer continues to read the contract's `getPosition(bytes32)` state and displays only a positive beneficiary-matched position.
