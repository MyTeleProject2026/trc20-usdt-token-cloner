# TRON Transfer — meta-transaction relayer

## Current state

The application exposes a read-only readiness endpoint at
`GET /api/trax-relayer/status`. The submission endpoint,
`POST /api/trax-relayer/submit`, is deliberately hard-disabled and returns
HTTP 503. This branch does not create a sponsor wallet, load a private key,
sign a transaction, or broadcast to TRON Mainnet.

The current `Restricted1TRAX` and `OneTraxReserveVault` contracts use
`msg.sender` for owner authorization and do not implement
`isTrustedForwarder(address)` or effective-sender extraction. A standalone
forwarder cannot make those existing deployments gasless. Meta-transaction
support requires new recipient contract versions and a new deployment; deployed
contracts cannot be patched in place.

## Required architecture

1. The owner signs one exact, short-lived request in TronLink. The signed
   request must bind the TRON Mainnet chain, forwarder address, recipient
   contract, function calldata, nonce, deadline, and value.
2. A trusted forwarder verifies the owner's signature, checks and increments
   the owner's nonce before the external call, enforces expiry and chain/domain
   binding, and appends the signer address to recipient calldata as specified
   by TRC-2771.
3. The token and vault must implement trusted-forwarder discovery and resolve
   the effective sender before checking owner permissions. All privileged
   functions remain owner-only; the relayer must never become the owner.
4. The relayer submits only allowlisted calls from verified owner signatures.
   It must reject arbitrary targets, arbitrary calldata, duplicate nonces,
   expired requests, wrong-chain requests, and calls outside the owner's
   explicit authorization.
5. The sponsor account must be a dedicated operational wallet, separate from
   the owner and reserve vault. Keep only a bounded TRX/resource budget there;
   do not store token principal or reserve assets in the relayer account.
6. Production signing must use an isolated signer/KMS or an equivalently
   protected dedicated key. Never put a sponsor key in browser code, source
   control, logs, API responses, or a user-provided form.
7. Read sponsor Energy/Bandwidth and balance before accepting a request; apply
   per-transaction, per-day, and total budget limits; record an idempotency key;
   and verify the solidified receipt after submission.

## Deployment implications

The present token and vault constructors set `owner = msg.sender`. If a
sponsor deploys these exact contracts, the sponsor becomes owner. A relayed
version must instead accept an explicit, validated `initialOwner` and
trusted-forwarder address in its constructor, so sponsor-paid deployment does
not transfer administrative ownership to the sponsor. The token and vault
must be deployed as a matched, audited version with reciprocal address checks.

A relayer does not remove the cost of deployment or contract execution. It
moves the TRON Energy/Bandwidth cost to the sponsor. Since no sponsor wallet is
currently available, this project is not funded or ready to relay. Do not
enable live execution until a sponsor is provisioned and its funding and
resource budget are independently verified.

## Current safety boundary

- No Mainnet transaction construction, signature, or broadcast is performed by
  the new relayer endpoints.
- No owner permission is delegated to the sponsor.
- No USDT, TRӾ, or reserve principal is handled by the relayer.
- No private key is read by the readiness code.
- Existing sponsor-direct and Ripple diligence flows remain separate. Ripple
  Gas Station or another funded gas sponsor must not be represented as an
  unsecured principal-credit facility.
