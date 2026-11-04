# TRON Token Studio

TRON Token Studio is a single-owner TRON wallet and treasury application. It reads public chain state, authenticates wallet ownership by signature, and maintains a server-side withdrawal/reconciliation ledger.

## Important current status

The implementation branch now includes an initial platform-owned self-custody USDT withdrawal path using a separately connected TronLink treasury wallet. **The new route is disabled by default** using `PLATFORM_TREASURY_SELF_CUSTODY_ENABLED=false`. It has not yet passed the full test suite, an end-to-end wallet-provider test, independent security review, or a controlled Mainnet acceptance transfer.

The original Fireblocks-backed route remains separate and hard-disabled in this build. No source change here has enabled a real payout or changed Render deployment settings.

The repository does not create USDT, manufacture spendable balances, or supply funding. Real TRON Mainnet USDT requires the official Tether TRC-20 contract and an actually funded, authorized treasury wallet.

## Selected architecture

The preferred no-third-party-custody architecture is a **platform-owned, self-custody TRON treasury**:

- Authenticate the operator with the existing signed wallet challenge. The identity wallet may have zero TRX and zero USDT.
- Keep the identity wallet separate from the platform treasury wallet.
- Connect the platform treasury wallet using TronLink; each transfer requires the wallet's explicit signing prompt.
- Keep request policy, limits, PostgreSQL reservations, broadcast state, and independent on-chain verification in the backend.
- Verify official USDT contract, sender, recipient, exact base-unit amount, successful solidified receipt, and exact TRC-20 Transfer event.
- Show exchange-deposit credit as unverified until the destination exchange confirms it through an authorized source.

This target does not require a third-party sponsor or Fireblocks vault. It does require the platform to own/control and fund its treasury. A zero-balance treasury cannot send principal. The treasury also needs TRX or independently verified transaction-resource coverage for network costs.

See [Platform-owned treasury architecture](docs/PLATFORM_OWNED_TREASURY_ARCHITECTURE.md), [Current implementation status](docs/CURRENT_IMPLEMENTATION_STATUS.md), and the [Self-custody treasury runbook](docs/PLATFORM_TREASURY_SELF_CUSTODY_RUNBOOK.md).

## Documentation

Start at [docs/README.md](docs/README.md) for the documentation map, retained provider references, operational controls, and release checklist.

## Security boundary

Never commit private keys, seed phrases, recovery phrases, API secrets, bearer tokens, or provider credentials. Wallet authentication signatures are identity proof only; they do not authorize treasury spending. The backend must not claim a payout succeeded until the chain evidence is independently verified.

## Development

- Install: `npm ci`
- Tests: `npm test`
- Production build: `npm run build`
- Environment validation: `npm run check:env`

These commands validate code and configuration. They do not create a funded treasury, obtain provider authorization, enable the execution flag, or prove a Mainnet payout.
