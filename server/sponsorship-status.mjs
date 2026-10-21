// Sponsorship remains fail-closed until a real provider adapter is integrated,
// sponsor consent/funding is verified, and the testnet flow passes review.
// Environment flags alone must never make the UI claim that fees are sponsored.
export function getSponsorshipStatus() {
  return {
    enabled: false,
    status: 'not-integrated',
    network: 'shasta',
    provider: null,
    mainnetEnabled: false,
    canSubmitSponsoredTransfer: false,
    receiverRestrictionsAvailable: false,
    message: 'No verified sponsor provider is connected. Sponsored fees are unavailable. A normal USDT/TRX transfer cannot impose spend restrictions on the receiver wallet; restrictions require an audited escrow/vesting contract or enforcement by the receiving platform. Sender authorization and valid token funds remain required.',
  }
}
