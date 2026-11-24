# Provider-independent Sponsor System — Owner-controlled two-wallet model

This platform has two independently controlled TRON Mainnet wallets owned by the platform owner.

- **Owner workspace:** deploys the existing TRӾ contract and signs Owner-authorized transactions.
- **Sponsor workspace:** stakes and unstakes its own TRX, delegates its own Energy and Bandwidth directly to the Owner address, and may explicitly transfer its own TRX to Owner.
- Each wallet signs only its own transactions locally. The Sponsor never signs as Owner.
- Private keys and recovery material remain encrypted locally and are never sent to the API or stored in Neon.
- Both workspaces use the existing Resource API and one configured TronGrid Mainnet RPC connection.

No external sponsor, public Energy/Bandwidth provider, GasFree relay, Fincra payout, Fireblocks custody, Tatum RPC, or alternate resource supplier is part of this design.

Transaction intents must be persisted before broadcast and reconciled by transaction ID before any retry. Staking and delegation are complete only after fresh Mainnet state confirms them. The TRӾ Solidity contract is unchanged.

Removing legacy code does not enroll wallets, initialize production tables, deploy Render services, or broadcast transactions; those remain explicit release and owner-enrollment steps.
