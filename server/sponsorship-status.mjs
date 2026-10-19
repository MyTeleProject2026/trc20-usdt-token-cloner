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
    message: 'No verified sponsor provider is connected. Transfers still require sender authorization and the sender must cover any required network costs.',
  }
}
