# Sponsor system and payout architecture

Tron Token Studio has two distinct capabilities with different funding and signing boundaries.

## Mainnet user withdrawal

Fincra is the only payout provider. It handles the business payout account and USDT TRC20 beneficiary settlement. Tatum provides TRON RPC, account/contract reads, history, and independent solidified-chain verification. The user's local owner wallet authenticates and authorizes the exact payout request; it is not the source of payout principal.

## Sponsor organization resources

Sponsor organizations, if separately onboarded, control their own TRON wallets and authorize resource delegation or testnet funding from their own wallet software. Tron Token Studio stores approved scopes, budgets, reservations, transaction intents, signatures where appropriate, transaction identifiers and reconciliation evidence. The platform must not request sponsor seed phrases or private keys.

The sponsor resource/delegation system is not interchangeable with Fincra stablecoin payouts. TRX, Energy, Bandwidth, and GasFree fee coverage do not constitute USDT principal.

## Provider policy

- Fincra only for USDT TRC20 payout settlement.
- Tatum only for application TRON chain API/RPC infrastructure.
- No Fireblocks organization, custody vault, signer, API, workflow or credential path.
- No public or automatic discovery mechanism can authorize the use of another party's funds.
- Provider acceptance and solidified chain evidence are separate payout states.
- Testnet assets never become Mainnet USDT.
