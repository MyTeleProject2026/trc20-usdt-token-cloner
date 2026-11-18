# Mainnet resource Sponsor Connection Center

## Owner workflow

The owner admin navigation includes **Resource sponsors**. The page reads the existing read-only endpoint:

`GET /api/tron/resources/claims/readiness?address=<configured-owner>&refresh=1`

It displays the latest owner resource snapshot and independent provider observations. It can prepare a JSON request for a prospective sponsor to review and send manually.

The generated request identifies:
- TRON Mainnet as the network;
- the configured beneficiary owner address;
- the observed resource/provider status and observation timestamp;
- the requested action: independently review the deployment simulation and, if willing, delegate Energy/Bandwidth using the sponsor's own wallet;
- explicit safety boundaries and limitations.

The request is generated locally and copied or downloaded by the owner. The optional sponsor contact reference is local UI state only. The application does not automatically email, message, enroll, or contact any third party.

## Sponsor authorization model

A sponsor must be a real person or organization that voluntarily agrees to provide the resource delegation. The sponsor reviews the exact resource amount, duration, beneficiary address, and terms, then authorizes a delegation transaction from its own wallet. The owner platform independently verifies the resulting Mainnet delegation transaction and beneficiary resource increase.

Never request or accept a sponsor's private key, seed phrase, wallet password, or remote wallet access. Never describe provider discovery, a generated request, an application, or a pending response as a grant.

## Current limitations

- The existing resource-claims endpoint is read-only and restricted to the configured owner address.
- The TEnergy public resource/health integration does not expose a free Energy/Bandwidth grant operation.
- The Sponsor Connection Center does not persist requests on the server, maintain a sponsor directory, or send outreach messages.
- No sponsor has been enrolled or confirmed by this feature.
- The request does not reserve sponsor funds or authorize deployment.
- A real sponsor must independently approve and execute delegation.
- Deployment remains blocked until fresh Mainnet measurements and exact deployment simulation establish adequate resources and all wallet/contract authorization checks pass.

## Next integration gate

A provider-specific automated delegation adapter may be added only after an identified provider supplies documented API terms and an explicit server-side authorization model for its own delegation signer. Any sponsor signer must remain in an approved secret manager; no sponsor credential belongs in frontend code or Git. Provider success responses must be followed by independent Mainnet delegation verification.
