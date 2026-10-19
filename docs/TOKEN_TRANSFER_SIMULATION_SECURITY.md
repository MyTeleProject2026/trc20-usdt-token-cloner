# Token simulation and transfer authorization

## Important distinction

The Token Studio transfer simulator is an in-browser demonstration ledger. Its balances, reference IDs, and transfer records are fictional and are not written to any blockchain. The simulator does not connect to wallets, request private keys, submit transactions, or alter the balance of any real account.

A token contract controls only its own token ledger. A contract cannot rewrite the native ETH balance of an arbitrary Ethereum account or transfer official USDT from an address merely because it knows that address.

## Why the supplied Vyper pattern is unsafe

A function such as:

```python
assert msg.sender == admin
self.balanceOf[src] = 0
self.balanceOf[dst] += amount
log Transfer(src, dst, amount)
```

allows the privileged administrator to modify balances in that contract without checking the source holder's authorization or an allowance. The emitted `Transfer` event describes the state change in that contract only. It does not prove that native ETH or another issuer's token moved.

This design creates a privileged balance-manipulation backdoor. Do not deploy it for real users, label it as official USDT, or use its events to claim that real assets were transferred.

## Safe demonstration options

- Use the clearly marked **Transfer Simulator** tab for fictional 65 ETH-style examples.
- For contract-level education, deploy a separately named token to a testnet and use only test funds.
- For real ERC-20 transfers, use a conventional implementation that checks balances and requires the holder's transaction signature or a valid allowance.
- Keep the chain, token contract address, symbol, decimals, and explorer link visible when demonstrating a real testnet transaction.
- Never ask a user to disclose a private key or seed phrase. Do not put secrets in frontend source, logs, or server environment variables.

## Review checklist for a token contract

- `transfer` can spend only the caller's balance.
- `transferFrom` checks the sender's balance and a sufficient allowance, then decrements the allowance.
- Only intentionally authorized minting or burning paths can change total supply.
- No privileged function can arbitrarily erase or credit third-party balances.
- Tests cover unauthorized calls, insufficient balances, allowance exhaustion, and emitted events.
- The token has a distinct name and symbol and is not represented as an issuer's official asset.
