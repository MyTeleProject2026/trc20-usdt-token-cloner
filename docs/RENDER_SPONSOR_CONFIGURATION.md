# Render configuration — Tron Transfer Owner Admin

Keep the existing `tron-transfer-resource-api` backend, frontend, and Neon database. Do not create replacement services.

Backend environment: NODE_ENV=production, DATABASE_URL (existing Neon connection), FRONTEND_ORIGIN (exact frontend origin), and optional TRONGRID_API_KEY. Do not configure Tatum, GasFree, WDK, Fincra, Fireblocks, third-party treasury, external Sponsor, or provider-payout credentials. Do not add a resource-rental or external Energy/Bandwidth provider. Never put wallet private keys or recovery phrases in Render variables.

Set `TRON_OWNER_ADDRESS` to the Owner wallet's public Mainnet address (or use `TRON_OWNER_WALLET_ADDRESS` as its alias). The API has no hard-coded Owner address fallback and stays blocked if this value is missing. Owner and Sponsor are two separate wallets owned by the platform owner. Owner signs Owner actions. Sponsor signs Sponsor actions. Sponsor staking/delegation and any TRX transfer to Owner require explicit Sponsor-wallet approval; neither wallet silently signs for the other.

Deploy only an approved commit to the existing services. Confirm migrations and authenticated enrollment readiness before enabling Sponsor writes. Verify Mainnet resources, delegation, transaction persistence, broadcast reconciliation, and recovery. CI success alone is not production readiness.
