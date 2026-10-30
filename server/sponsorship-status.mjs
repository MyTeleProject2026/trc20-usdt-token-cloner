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
    // The selected business rule is external-sponsor-only. The user must never be
    // charged by the platform for sponsor fees or sponsor-funded asset grants.
    // Until a sponsor has actually agreed and funded the program, no such flow runs.
    fundingPolicy: {
      mode: 'external-sponsor-only',
      userFundsRequiredForSponsoredFlow: false,
      externalSponsorConfirmed: false,
      sponsorFundingVerified: false,
      paidProviderPurchasesAllowed: false,
      feeSponsorshipAvailable: false,
      sponsorFundedAssetTransfersAvailable: false,
      unpaidFallbackToUserFunds: false,
    },

    // No network is active while sponsorship is not integrated.
    network: null,
    provider: null,
    // Both integration models are supported as design targets, but neither is
    // connected or authorized by configuration alone. Each requires its own
    // independently verified consent, funding, and signing path.
    integrationModels: {
      thirdPartyProvider: {
        supportedAsDesign: true,
        configured: false,
        adapterVerified: false,
        sponsorAccountVerified: false,
        submissionEnabled: false,
      },
      sponsorOrganization: {
        supportedAsDesign: true,
        configured: false,
        identityVerified: false,
        spendingMandateVerified: false,
        submissionEnabled: false,
      },
      sharedRequirements: [
        'explicit-sponsor-consent',
        'fresh-on-chain-principal-funding',
        'fresh-on-chain-network-fee-funding-or-verified-resource-coverage',
        'separate-principal-and-fee-reservations',
        'cryptographic-intent-bound-authorization-and-replay-protection',
        'operator-approval-and-emergency-pause',
        'independent-solidified-chain-verification',
        'no-user-funded-fallback',
      ],
    },
    // Research findings are exposed as diagnostics, not live provider configuration.
    // Candidate listing and public API documentation do not establish a sponsor agreement,
    // funded account, permission to spend, or permission to submit.
    providerResearch: {
      assessedAt: '2026-10-24',
      status: 'research-only-no-verified-public-full-sponsor',
      selectedArchitecture: 'dual-sponsored-roles',
      publicSponsorVerifiedForPrincipalAndNetworkFees: false,
      candidates: [
        {
          id: 'gasfree',
          role: 'provider-relayed-trc20-transfer-and-native-gas',
          applicationIntegrated: false,
          productionEnabled: false,
          providesAssetPrincipal: false,
          feeAsset: 'transferred-token',
          documentedNetworks: ['mainnet', 'nile'],
          suitableForNoUserCostPolicyAlone: false,
          sourceUrl: 'https://docs.gasfree.io/',
        },
        {
          id: 'trontransfer',
          role: 'paid-energy-sponsored-usdt-transfer',
          applicationIntegrated: false,
          productionEnabled: false,
          providesAssetPrincipal: false,
          senderSignedFeeTransactionRequiredByPublishedFlow: true,
          suitableForNoUserCostPolicy: false,
          dueDiligenceRequired: true,
          sourceUrl: 'https://doc.trontransfer.com/',
        },
        {
          id: 'tron-stake-2.0-resource-delegation',
          role: 'bandwidth-and-energy-resource-delegation',
          applicationIntegrated: false,
          productionEnabled: false,
          providesAssetPrincipal: false,
          requiresSponsorStakedResourcesAndAuthorizedDelegation: true,
          suitableAsFeeResourceOnly: true,
          sourceUrl: 'https://developers.tron.network/docs/delegation',
        },
      ],
      conclusion: 'No reviewed candidate is verified to provide this application both arbitrary asset principal and full network-fee coverage without user-funded fallback. Provider discovery alone does not enable submission.',
    },
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
      'provider-specific-signing-authorization',
      'explicit-sponsor-consent-and-funded-budget',
      'server-side-authorization-and-per-transfer-limits',
      'idempotent-sponsor-ledger-and-reconciliation',
      'finalized-on-chain-evidence-and-idempotent-ledger-transitions',
      'separate-network-fee-and-asset-principal-budgets',
      'testnet-end-to-end-and-security-review',
      'mainnet-operator-approval-and-emergency-pause',
    ],

    message: 'No verified sponsor provider is connected, and no funded sponsor account is verified. External-sponsor-only policy is selected. Sponsored fees and sponsor-funded TRX/USDT grants remain unavailable, and the platform must never fall back to charging the user. The app must not display sponsor budget or pending credits as receiver wallet balance. Spendable balance must come from verified on-chain assets; exchange credit requires evidence from that exchange. A normal USDT/TRX transfer cannot impose spend restrictions on the receiver wallet; restrictions require an audited escrow/vesting contract or enforcement by the receiving platform. Sender authorization and valid token funds remain required for sender-funded transfers.',
  }
}
