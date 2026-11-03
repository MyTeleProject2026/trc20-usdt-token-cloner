# TRON Token Studio

TRON Token Studio is a single-owner TRON wallet and treasury application. It reads public chain state, authenticates wallet ownership by signature, and maintains a server-side withdrawal/reconciliation ledger.

## Important current status

**The current build does not execute real-value withdrawals.** The treasury route contains a hard-coded execution stop, and the UI describes the treasury panel and wallet transfer review as read-only. A successful login, readiness response, deployment, displayed amount, provider request ID, or transaction preview is not proof that a transfer was sent.

The repository does not create USDT, manufacture spendable balances, or supply funding. Real TRON Mainnet USDT requires the official Tether TRC-20 contract and an actually funded, authorized treasury wallet.

## Intended production architecture

The preferred no-third-party-custody target is a **platform-owned, self-custody TRON treasury**:

- Authenticate the operator with a signed wallet challenge. Do not collect or upload the login wallet's private key.
- Keep the identity wallet separate from the treasury wallet. The identity wallet may have zero funds.
- Read the real treasury balance from TRON Mainnet.
- Have the authorized owner connect the treasury wallet through a supported wallet provider (for example, TronLink) and explicitly sign each payout.
- Keep request policy, limits, idempotency, audit records, and independent on-chain verification in the backend.
- Verify the official USDT contract, sender, recipient, base-unit amount, successful solidified receipt, and exact TRC-20 Transfer event.
- Show exchange-deposit credit as unverified until the destination exchange confirms it through an authorized source.

This target does not require a third-party sponsor or Fireblocks vault. It does require the platform to own/control and fund its treasury. A zero-balance treasury cannot send principal. The treasury also needs TRX or independently verified transaction-resource coverage for network costs.

See [Platform-owned treasury architecture](docs/PLATFORM_OWNED_TREASURY_ARCHITECTURE.md) and [Current implementation status](docs/CURRENT_IMPLEMENTATION_STATUS.md).

## Documentation

Start at [docs/README.md](docs/README.md) for the documentation map, retained provider references, operational controls, and migration plan.

## Security boundary

Never commit private keys, seed phrases, recovery phrases, API secrets, bearer tokens, or provider credentials. Wallet authentication signatures are identity proof only; they do not authorize treasury spending. The backend must not claim a payout succeeded until the chain evidence is independently verified.

## Development

- Install: `npm ci`
- Tests: `npm test`
- Production build: `npm run build`
- Environment validation: `npm run check:env`

These commands validate code and configuration. They do not create a funded treasury, obtain provider authorization, enable the current hard gate, or prove a Mainnet payout.
