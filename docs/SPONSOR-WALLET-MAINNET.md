# Sponsor Wallet Mainnet readiness

The Sponsor Console is integrated into the existing Owner Admin application. Its status endpoint reads the configured Sponsor address and the Owner recipient address from server environment, then queries the Sponsor's TRON Mainnet TRX balance and account resources.

## Initial limits

- Stake 2.0 minimum: 1 TRX per operation.
- Initial automatic staking ceiling: 10 TRX total, configurable by the operator.
- Protected liquid reserve: 2 TRX, configurable by the operator.
- Automatic unstaking: disabled.

These are conservative application defaults, not TRON protocol maximums. The 10 TRX ceiling is an aggregate application policy; a live transaction service must also verify available balance, fees, existing stake, and the chain's maximum delegatable resource before preparing an operation.

## Signing boundary

The status endpoint never returns a private key or secret. Sponsor staking and delegation remain disabled in this release. A future transaction service must authenticate an Owner Admin session, load the Sponsor signing key only from a server-side secret manager, verify the derived address against SPONSOR_MAINNET_ADDRESS, enforce aggregate stake and reserve limits, simulate/estimate fees, persist an idempotency record, sign only Sponsor-authorized Stake 2.0 operations, broadcast to TRON Mainnet, and wait for solidified transaction confirmation. It must independently verify the resulting resource delegation to TRON_OWNER_ADDRESS before marking resources available.

No frontend-held private key, TronLink dependency, or browser-local Sponsor signer is acceptable for the target independent Sponsor architecture.

## Required production configuration

Configure these values only in the existing Resource API service's Render Environment settings:

- `SPONSOR_MAINNET_ADDRESS`: public TRON Mainnet address derived from the imported Sponsor wallet.
- `SPONSOR_MAINNET_PRIVATE_KEY`: Sponsor signing key, stored only as a secret environment variable; never commit it or submit it from the browser.
- `TRON_OWNER_ADDRESS`: the exact existing Owner Wallet recipient address.
- `SPONSOR_ADMIN_TOKEN`: a randomly generated high-entropy token for administrative transaction authorization (minimum 32 characters).
- `SPONSOR_STAKING_ENABLED`: keep `false` until the signer, authorization, transaction persistence, and recovery controls have passed independent review.
- `SPONSOR_MAX_AUTOMATIC_STAKE_TRX`: default 10 TRX; hard application ceiling.
- `SPONSOR_LIQUID_RESERVE_TRX`: default 2 TRX; excluded from staking.

Do not upload a mnemonic, private key, or keystore to a normal web form or browser local storage. The Sponsor wallet import process for this architecture is an operator-controlled secret provisioning step into Render, followed by a public-address match check. Wallet replacement requires disabling automation, removing the old secret, configuring the new key/address pair, verifying the derived address, and then re-enabling service. Logout/lock in the UI must revoke the current administrative session; it must not delete or expose the server secret.

## Release boundary

This source increment provides the Sponsor dashboard and a read-only Mainnet status API only. It does not yet implement or enable private-key import, transaction signing, Stake 2.0 broadcast, delegation broadcast, or automatic top-up. Those capabilities must not be shown as available until the server-side transaction service has durable idempotency, owner authentication, spend approval, signed-transaction verification, solidified receipt checks, and recovery handling.
