# Platform-owned self-custody treasury architecture

**Status:** target architecture / implementation plan  
**Product scope:** single-owner TRON Token Studio  
**Default funding model:** platform-owned treasury; no external sponsor required  
**Default signing model:** owner-controlled TRON wallet provider; no Fireblocks vault required

## 1. Decision

The best fit for a platform that does not want a third-party sponsor organization or custody-provider vault is a **platform-owned, self-custody TRON treasury**.

The platform owner controls a dedicated treasury wallet and funds it with genuine TRON Mainnet USDT and enough TRX for network costs. The application never treats an empty login wallet as a source of funds. A separate wallet-provider connection to the treasury wallet supplies the transaction signature when the owner authorizes a payout.

This is a non-custodial, owner-operated signing model. It is not an unattended server signer. If fully unattended/server-side signing is later required, that is a separate custody design requiring a properly secured HSM/KMS or a managed custody provider, independent access controls, and an explicit security review. Do not replace Fireblocks with a raw private key in Render environment variables or a database.

## 2. Wallet roles must remain separate

### Identity wallet

- Connects to the login page and signs a fresh, one-time authentication challenge.
- Proves control of a public TRON address.
- May have zero TRX and zero USDT.
- Does not receive, store, or submit a private key to the backend.
- Its login signature is not a transaction signature and must not authorize a payout.

### Treasury wallet

- Is a separate, platform-owner-controlled TRON address.
- Holds the actual official USDT principal and enough TRX for transaction costs, unless an independently verified resource/fee arrangement is explicitly configured.
- Is connected only when the owner is preparing to approve a payout.
- Must be matched against a server-side configured/approved treasury address before the application prepares a transfer.
- Signs the specific transfer through the owner's wallet provider; the user sees and approves the transaction in that wallet.

The same wallet may only serve both roles if the owner intentionally configures that arrangement, but the architecture must not assume that the login address is automatically the treasury or that signing in grants spend authority.

## 3. Component architecture

1. **Frontend wallet connection**
   - Uses the wallet provider's public-address and signing interfaces.
   - Requests a message signature for login.
   - Requests a separate transaction signature for each payout.
   - Never renders a private-key import form and never transmits private keys or seed phrases to the app.

2. **Wallet-authentication API**
   - Issues a cryptographically random, single-use challenge bound to address, network, origin, purpose, and expiry.
   - Verifies the returned signature and consumes the challenge atomically.
   - Stores only public identity details and a hash of the session token.
   - Keeps login authentication separate from payout authorization.

3. **Treasury read adapter**
   - Reads the configured treasury's TRX balance and official USDT balance from TRON Mainnet.
   - Pins the official TRON USDT contract to `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`.
   - Treats provider data as observations, not signing authority.
   - Uses independent/solidified chain evidence for final transaction verification.

4. **Withdrawal policy and ledger**
   - Validates destination, network, asset, amount, limits, owner session, and a fresh transaction-specific owner authorization.
   - Reserves funds atomically in PostgreSQL before requesting a signature.
   - Uses a unique idempotency key bound to the exact sender, recipient, token contract, and amount.
   - Keeps pending or ambiguous requests reserved until reconciled.
   - Records auditable status changes without logging secrets.

5. **Owner-wallet signer**
   - Builds an unsigned transfer for the official USDT contract.
   - Requires the connected treasury wallet address to equal the approved treasury address.
   - Presents the exact network, contract, sender, recipient, amount, and network fee to the owner.
   - Requests an explicit wallet-provider transaction signature.
   - Returns/broadcasts only the signed transaction that matches the server-authorized intent.
   - Does not have access to the owner's private key.

6. **Broadcast and verification**
   - Broadcasts the owner-signed transaction through a supported TRON node/provider.
   - Verifies the returned transaction ID against solidified chain state.
   - Checks sender, recipient, official USDT contract, exact base-unit amount, successful receipt, and exactly matching TRC-20 Transfer event.
   - Separately reports exchange-deposit credit; a chain confirmation is not an exchange credit.

## 4. End-to-end workflow

1. The operator opens the application and connects the **identity wallet**.
2. The application verifies a one-time message signature. The identity wallet does not need funds.
3. The dashboard reads the configured treasury address and displays chain-observed USDT and TRX balances with a clear timestamp and network.
4. For a withdrawal, the owner connects the **treasury wallet** through the wallet provider.
5. The backend verifies the owner session, approved treasury address, destination format, asset contract, available balance, pending reservations, fee reserve, limits, and idempotency.
6. The backend creates a short-lived, single-use withdrawal intent. The intent binds the network, treasury, official token contract, recipient, amount, expiry, and idempotency key.
7. The frontend builds or receives the unsigned transaction and asks the treasury wallet provider to sign it. The owner must approve the exact transaction in the wallet.
8. The signed transaction is checked against the authorized intent and broadcast. A timeout or ambiguous response must be reconciled using the same transaction/idempotency reference; never submit a duplicate transfer blindly.
9. The backend observes the transaction until a solidified receipt is available and independently verifies the exact Transfer event.
10. The application reports one of: awaiting owner signature, broadcast pending, confirmed on-chain, verified failure, or broadcast outcome unknown. It must not show success before chain verification.
11. For exchange destinations, the user must select the correct TRON/TRC-20 deposit network and satisfy the exchange's address, minimum-deposit, memo/tag (if applicable), and account requirements. The app must show exchange credit as unverified unless it receives authenticated exchange-side evidence.

## 5. Funding and fee realities

- No provider API, wallet login, smart contract, or application code creates genuine USDT.
- The treasury must receive genuine USDT from an owner-controlled and documented source before it can pay USDT principal.
- The official TRON USDT token uses six decimals and the fixed contract address stated above. Never identify an asset by symbol alone.
- TRC-20 transfers consume TRON network resources. The treasury needs adequate TRX for fees/burns, or a separately evaluated, explicitly authorized fee/resource service that supports the exact transaction. Fee sponsorship does not supply USDT principal.
- If the treasury has zero USDT, a payout of positive USDT cannot be made. If it has no TRX/resource coverage, the transfer may fail or be uneconomical. Return a precise insufficient-funds/fee-coverage status; do not fabricate an available balance or silently charge the identity wallet.
- The recipient's exchange may reject or delay a deposit even after an on-chain transfer is confirmed.

## 6. What is not required—and what is still required

| Item | Required in this target? | Explanation |
|---|---|---|
| External sponsor organization | No | The platform's own treasury is the funding source. |
| Fireblocks workspace or vault | No | The owner signs from the platform-owned treasury wallet provider. |
| Tatum or TronGrid API key | Not intrinsically | A read/broadcast provider can be selected; API keys improve service access but are not money or signing authority. |
| Login wallet funded with USDT | No | Login proves identity only. |
| Platform-owned funded treasury | Yes | It supplies the real USDT principal. |
| Treasury wallet signing authority | Yes | The owner must approve each real transfer. |
| TRX or verified resource coverage | Yes | Needed for network execution costs. |
| Database for reservations/idempotency | Yes for the production service | Prevents replay/duplicate payouts and supports reconciliation. |
| Security review and controlled Mainnet acceptance | Yes | Required before any real-value launch. |

## 7. Proposed application interfaces

These are target contracts, not a claim that all are currently implemented:

- `POST /api/auth/tron/challenge` and `POST /api/auth/tron/verify` — existing identity-wallet challenge flow.
- `GET /api/treasury/withdrawals/readiness` — read-only chain/provider, configuration, and fee readiness.
- `POST /api/treasury/withdrawals/prepare` — validate policy, atomically reserve, and issue a short-lived transfer intent.
- `POST /api/treasury/withdrawals/:id/submit` — accept only the transaction signed by the approved treasury wallet and matching the stored intent; validate signature/transaction fields before broadcast.
- `GET /api/treasury/withdrawals/:id` — current ledger/provider/chain status.
- `POST /api/treasury/withdrawals/:id/verify` — refresh and independently verify solidified chain evidence.

The current repository already uses some similar readiness, status, and verification concepts, but its current submit route is a Fireblocks integration with a hard-coded execution stop. The new wallet-provider signer and the prepare/submit contract must be implemented and tested before these target contracts can be described as operational.

## 8. Migration plan from the current code

1. Preserve the current wallet-auth protocol, PostgreSQL withdrawal ledger, idempotency/reservation utilities, official-USDT identity checks, chain-verification helpers, and security tests.
2. Introduce a signer interface so signing is not coupled to Fireblocks-specific API calls. Add an owner-wallet-provider adapter for the non-custodial target. Keep Fireblocks as an optional alternative adapter, not a mandatory dependency.
3. Implement treasury-wallet connection and address matching in the frontend. The login identity wallet remains separate.
4. Implement server-issued, short-lived withdrawal intents and validation of the owner-signed transaction before broadcast.
5. Bind the existing database reservation/idempotency ledger to the owner-wallet signer lifecycle, including rejected, expired, pending, and ambiguous outcomes.
6. Add tests for unauthorized treasury addresses, address/network switching, replay, wrong token contract, altered recipient/amount, expiry, concurrent reservation, insufficient USDT, insufficient TRX/resources, provider timeout, duplicate broadcast, failed receipt, missing/mismatched Transfer event, and exchange-credit-unverified state.
7. Complete a real wallet-provider test with test funds on a TRON testnet. Then conduct a deliberately small, owner-authorized Mainnet acceptance transaction only after code review, security review, funded-treasury confirmation, and operational approval.
8. Remove the compile-time production execution block only as part of a reviewed release that includes the actual signer, tests, and acceptance evidence. Never remove it merely to make the button appear active.

## 9. Production acceptance criteria

- [ ] Identity wallet signs a one-time login message; no private key is collected or stored.
- [ ] Empty identity wallet can access the dashboard without being treated as the funding source.
- [ ] A different, explicitly configured treasury wallet can be connected for payout authorization.
- [ ] Wrong wallet, wrong network, changed account, expired intent, and replay are rejected.
- [ ] Mainnet asset identity is fixed to the official Tether TRON contract.
- [ ] Live chain balances and all outstanding reservations are checked server-side.
- [ ] Positive USDT principal and adequate TRX/resource coverage are demonstrated.
- [ ] Each payout requires explicit owner wallet-provider transaction approval.
- [ ] The server validates the signed transaction against the stored intent before broadcast.
- [ ] Idempotency and reservations survive restarts and concurrent requests.
- [ ] Final status requires solidified receipt and matching Transfer event.
- [ ] Exchange credit is never inferred from chain confirmation.
- [ ] Testnet end-to-end, security, recovery, and monitoring checks pass.
- [ ] A controlled Mainnet acceptance payout is independently verified before production release.

## 10. Security prohibitions

Do not add a private-key login form. Do not accept a private key in an API payload, query parameter, database field, application log, GitHub file, Render environment variable, or browser storage. Do not create synthetic balances, fake transfer identifiers, fake exchange credit, unrestricted automatic payouts, or a fallback that spends an identity wallet's funds. Do not bypass a wallet-provider prompt, owner authorization, chain verification, or provider policy.
