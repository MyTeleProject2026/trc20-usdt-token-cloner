# Production environment — Owner/Sponsor-only Mainnet architecture

The deployed Owner Admin application uses two independently controlled TRON Mainnet wallets and one TronGrid RPC connection.

Required backend settings: NODE_ENV=production, DATABASE_URL (existing Neon connection), FRONTEND_ORIGIN (exact frontend origin), and optional TRONGRID_API_KEY. Store secrets only in the backend secret manager.

Owner and Sponsor are independent wallets. Each signs only its own transactions locally from its encrypted local vault. No private key, seed phrase, or recovery phrase is sent to Render or Neon. Owner deploys the existing TRӾ contract and signs Owner operations. Sponsor stakes and unstakes its own TRX, delegates its own Energy and Bandwidth directly to Owner, and may explicitly transfer its own TRX to Owner.

TronGrid is the only configured TRON RPC node. It provides blockchain reads and signed-transaction broadcast; it does not provide Energy, Bandwidth, TRX, liquidity, custody, or fee sponsorship. No public resource supplier, external Sponsor, GasFree relay, payout processor, custodian, or alternate RPC provider is part of this architecture.

Mainnet only. Validate wallet identity, network, resource state, transaction parameters, and fee limit before signing. Persist transaction intent before broadcast and reconcile ambiguous submissions by transaction ID before retrying. Confirm staking/delegation from fresh Mainnet chain state. Do not enable production Sponsor writes until Owner bootstrap, Sponsor enrollment, persistence, recovery, and independent signing tests pass.

The existing TRӾ Solidity contract is preserved. Cleanup does not itself enroll wallets, initialize production database tables, deploy Render services, or authorize Mainnet transactions.
