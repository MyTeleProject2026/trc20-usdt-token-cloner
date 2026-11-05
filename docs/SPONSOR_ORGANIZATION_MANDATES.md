# Sponsor organization onboarding and mandate controls

This workflow is integrated into the deployed `Frontend-Tron-Transfer` application and existing API. It introduces no new Render environment-variable requirements; it reuses the current database URL, Mainnet wallet-authentication origins, owner-wallet configuration, and Tatum Mainnet key.

## Workflow

1. A proposed sponsor connects its own TRON Mainnet wallet and completes the existing wallet-identity challenge.
2. The wallet signs the canonical organization application message. The API derives the sponsor address from the authenticated session and stores only the signature digest.
3. The configured platform owner moves the application through `in-review` and `accepted-for-due-diligence`. This is an internal workflow state, not external KYC or a legal conclusion.
4. Only after due-diligence acceptance can the sponsor submit a signed payout mandate. The sponsor selects the roles and provides the reference and SHA-256 digest of the signed agreement file. The PDF itself is hashed locally in the browser and is not uploaded to this API.
5. The owner records an agreement-evidence review, then makes a separate `authorize` decision with an external verification/case reference. The mandate must explicitly cover both USDT principal and network fees for this current direct-wallet payout path.
6. The existing sponsor wallet application must also be active under its separately configured payout caps.
7. At payout readiness and preparation, the API requires an authorized, unexpired mandate bound to the same sponsor wallet and accepted organization. The effective per-payout and daily limits are the lower of the wallet approval caps and mandate caps.
8. The API reads the sponsor's actual USDT balance and TRON resources through Tatum. It reserves requests, prepares the exact official USDT Mainnet transfer, and only the sponsor wallet may sign it with its own TronLink wallet. The API validates the signed payload before broadcasting through Tatum and verifies a solidified receipt and exact Transfer event.

## Fail-closed rules

- An application alone never authorizes payout.
- A sponsor declaration or wallet message signature is not proof of incorporation, beneficial ownership, source of funds, or independent signer authority.
- A signed mandate digest is an audit binding, not independent legal verification. Review references must point to separately retained evidence checked by the operator.
- A mandate marked `verified` is not yet spend-authorized; a distinct `authorized` review state is required.
- Payout preparation and broadcast fail closed if the mandate is missing, expired, not authorized, does not cover both principal and fees, or is for another wallet.
- Fresh Tatum Mainnet balance and resource checks remain mandatory. No balance is inferred from an application, agreement or owner setting.
- Every transaction still requires the sponsor's explicit wallet signature. This implementation does not create unattended signing or custody.
- Requester wallet USDT is not used. A genuine sponsor must provide all USDT principal and network-fee resources.
- On-chain settlement is not treated as exchange account credit.

## Current limitations / operational steps

- The workflow does not independently perform KYC, validate legal documents, establish a lawful funding source, or obtain a provider's authorization. Those checks must be completed by a qualified operator/provider outside this app and recorded by reference before the mandate is authorized.
- The organization PDF is not uploaded. The sponsor and operator must keep the signed original in a suitable document-management location and use its SHA-256 digest to bind the record.
- The existing wallet sponsor approval remains a separate step and must be activated by the owner with limits no greater than the signed mandate.
- No automatic provider payout API is wired. Sponsor-owned TronLink signing remains interactive.
- A real sponsor and genuine funding are still required. If no sponsor is willing and funded, withdrawal requests remain queued and cannot be paid.

## Routes

- `GET /api/tron/organizations/config`
- `POST /api/tron/organizations/applications`
- `GET /api/tron/organizations/me`
- `GET /api/tron/organizations/applications` (owner)
- `POST /api/tron/organizations/applications/:id/review` (owner)
- `POST /api/tron/organizations/applications/:id/mandates` (sponsor wallet)
- `GET /api/tron/organizations/mandates` (owner)
- `POST /api/tron/organizations/mandates/:id/review` (owner)
- `POST /api/tron/organizations/mandates/:id/revoke` (sponsor wallet)

No additional Render environment variables are required by this feature.
