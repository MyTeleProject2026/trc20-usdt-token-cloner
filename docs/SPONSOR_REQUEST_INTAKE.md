# Sponsor request intake

The sponsor request queue collects and validates requests; it does not commit any sponsor funds or trigger a Mainnet USDT payout.

The intake service must:
- validate the applicant and requested scope;
- preserve the request as pending until an authorized sponsor operator reviews it;
- record explicit approval/rejection and the approved budget;
- keep sponsor credentials and private keys outside the application;
- never represent a request, approval or budget reservation as a completed on-chain transfer.

The Fincra payout flow is a separate owner-authorized Mainnet payout route. It uses Fincra's funded business payout account and Tatum for blockchain reads and verification. This intake queue does not create USDT principal or provide an automatic sponsor credit facility.
