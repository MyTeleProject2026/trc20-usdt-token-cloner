# TRON Mainnet free-delegation resource policy

Policy owner: `TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp`

- Network is fixed to TRON Mainnet. Testnet endpoints are not used by this policy.
- Resource status is read server-to-server through supported TRON FullNode endpoints. The backend prefers authenticated TRONGrid when `TRONGRID_API_KEY` is configured, then uses Tatum Mainnet FullNode when `TATUM_API_KEY` is configured. If no TRONGrid key is configured, public TRONGrid is a read-only fallback and may be rate limited.
- The reader calls `wallet/getaccountresource`, `walletsolidity/getdelegatedresourceaccountindexv2`, and `walletsolidity/getdelegatedresourcev2` to report aggregate resources and on-chain incoming Stake 2.0 delegation records. It never treats a provider's reachability as proof of Energy.
- TRON protocol free Bandwidth is a renewable account quota (currently 600, controlled by chain parameters). TRON has no protocol-level free Energy quota. Energy comes from stake or a real incoming delegation; otherwise the chain can burn TRX if the transaction is allowed and funded.
- No verified unconditional free-Energy provider API is configured. The service does not invent one, scrape web pages, request a secret key, or claim that GasFree / paid rental products are free.
- No sponsor account, paid rental, automatic delegation, user-funded fallback, private key custody, signing, or broadcast is enabled by this policy. The deployment and contract-call preflights also require a zero native TRX balance and full resource coverage; they reject known Energy or Bandwidth shortfalls even if the wallet has TRX.
- TRON requires a positive caller Energy budget (`fee_limit`) to consume staked/delegated Energy. The app therefore keeps the configured fee cap but requires the native TRX balance to be exactly zero before deployment or contract calls. This prevents the chain from burning TRX if resource availability changes before execution; if resources are insufficient, the transaction fails instead of falling back to payment.
- The connected wallet must be `TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp`. Wallet approval remains required for every on-chain transaction. The backend only performs read-only diagnostics.
- If Energy is zero and there is no incoming delegation, deployment and contract calls must stop before the wallet prompt. Free Bandwidth alone cannot execute TVM contract code.

## API

`GET /api/tron/resources/free-delegation/status?address=TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp`

Optional `refresh=1` bypasses the short cache. The endpoint returns sanitized resource counters, a server-verified deployment resource snapshot (including current fee parameters and native TRX balance), inbound delegation evidence, policy flags, and explicit false values for signing/broadcast actions. It rejects any other address.

## Server environment

Optional, backend-only provider keys:

- `TRONGRID_API_KEY`
- `TATUM_API_KEY`

Never expose either key through a `VITE_*` variable. Keys improve authenticated read access only; neither key supplies Energy or authorizes transactions.
