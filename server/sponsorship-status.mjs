// Sponsorship remains fail-closed until a real provider adapter is integrated,
// sponsor consent/funding is verified, and the testnet flow passes review.
// Environment flags alone must never make the UI claim that fees are sponsored.
//
// IMPORTANT: fee sponsorship and giving a receiver USDT/TRX are separate products.
// A fee sponsor can pay eligible network fees; it does not create or transfer the
// sender's USDT/TRX asset. Only a verified chain balance is an on-chain balance.
export function getSponsorshipStatus() {
  return {
    enabled: false,
    status: 'not-integrated',
    network: 'shasta',
    provider: null,
    mainnetEnabled: false,
    canSubmitSponsoredTransfer: false,
    receiverRestrictionsAvailable: false,

    // Balance-display contract for frontend clients. Never fabricate a balance
    // from sponsor budgets, pending grants, or UI-only credits.
    receiverBalance: {
      source: 'verified-on-chain-only',
      displayOnlySponsorCredit: false,
      spendableSource: 'on-chain-wallet-balance',
      sponsorAssetGrantEnabled: false,
      sponsoredFeeCoverage: 'none',
      exchangeCredit: 'exchange-confirmation-required',
    },

    requiredBeforeEnablement: [
      'verified-provider-adapter-and-account',
      'explicit-sponsor-consent-and-funded-budget',
      'server-side-authorization-and-per-transfer-limits',
      'idempotent-sponsor-ledger-and-reconciliation',
      'testnet-end-to-end-and-security-review',
      'mainnet-operator-approval-and-emergency-pause',
    ],

    message: 'No verified sponsor provider is connected. Sponsored fees and sponsor-funded USDT/TRX grants are unavailable. The app must not display sponsor budget or pending credits as receiver wallet balance. Spendable balance must come from verified on-chain assets; exchange credit requires evidence from that exchange. A normal USDT/TRX transfer cannot impose spend restrictions on the receiver wallet; restrictions require an audited escrow/vesting contract or enforcement by the receiving platform. Sender authorization and valid token funds remain required.',
  }
}
