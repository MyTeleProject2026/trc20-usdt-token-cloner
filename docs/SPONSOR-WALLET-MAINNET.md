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
