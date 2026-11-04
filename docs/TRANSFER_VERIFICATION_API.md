# TRON transfer verification API

The transfer-verification API reads transaction bodies and receipts from Tatum's TRON Mainnet, Shasta or Nile SolidityNode gateway. The application does not accept an arbitrary upstream URL or select a fallback RPC provider.

The `network` parameter is required in new clients and accepts `mainnet`, `shasta` or `nile`. All addresses must be hex encoded (20-byte hex, optionally prefixed with `41`). `amountSun` is the exact integer in the token's smallest unit.

## Required backend environment

- `TATUM_API_KEY`: backend-only Tatum API key. Never add it to a frontend `VITE_*` variable.
- `TRON_VERIFIED_TOKEN_CONTRACTS`: optional allowlist of reviewed token contracts in the expected hexadecimal form.

The API queries the matching network's Tatum SolidityNode for the solidified transaction body and receipt, then validates successful execution and the matching `Transfer(address,address,uint256)` event. Tatum API acceptance or an indexed transaction alone is not finality evidence.
