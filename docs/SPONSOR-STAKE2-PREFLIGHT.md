# Sponsor Stake 2.0 policy preflight

The Sponsor API now has a pure policy planner for a prospective Stake 2.0 operation. It uses integer SUN arithmetic and checks the Sponsor and Owner addresses are valid and distinct, the resource is ENERGY or BANDWIDTH, the amount is at least 1 TRX, the amount does not exceed the configured automatic ceiling, and the Sponsor retains the protected liquid reserve.

The planner is deliberately side-effect-free. It does not create a transaction, sign, broadcast, delegate, or claim that a resource is available. Stake 2.0 signing and delegation remain disabled pending the authenticated transaction service, key custody review, idempotency persistence, chain simulation, solidified receipt verification, and an operator-approved transaction authorization flow.

The 1 TRX minimum is an application policy floor, not a statement of a universal TRON protocol minimum. The default 10 TRX ceiling and 2 TRX reserve are conservative configurable application limits.
