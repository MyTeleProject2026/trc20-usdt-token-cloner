// The provider-independent sponsor-wallet signer is implemented for Shasta/Nile.
// Sponsorship remains fail-closed until real sponsor consent/funding, fee settlement,
// and end-to-end evidence are verified. Mainnet signing/broadcast is not implemented.
// Environment flags alone must never make the UI claim that funds are sponsored.
//
// IMPORTANT: fee sponsorship and giving a receiver USDT/TRX are separate products.
// A fee sponsor can pay eligible network fees; it does not create or transfer the
// sender's USDT/TRX asset. Only a verified chain balance is an on-chain balance.
export function getSponsorshipStatus() {
  return {
    enabled: false,
    status: 'testnet-wallet-signer-integrated-mainnet-disabled',
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

    // The sponsor wallet is the signer. Fireblocks is not part of this workflow.
    // The adapter is implemented for testnet only; Mainnet remains read-only.
    network: null,
    provider: null,
    signerArchitecture: {
      mode: 'sponsor-controlled-wallet-signature',
      providerIndependent: true,
      fireblocksRequired: false,
      backendStoresSponsorPrivateKeys: false,
      explicitWalletSignaturePerTransfer: true,
      supportedNetworks: ['nile', 'shasta'],
      mainnet: {
        readOnlyDiagnosticsAvailable: true,
        signingAdapterImplemented: false,
        submissionEnabled: false,
      },
    },
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
        walletSigningAdapterImplemented: true,
        walletSigningNetworks: ['nile', 'shasta'],
        mainnetWalletSigningAdapterImplemented: false,
        fireblocksRequired: false,
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
      'verified-mainnet-sponsor-wallet-signing-and-broadcast-adapter',
      'transaction-bound-sponsor-wallet-signature-and-replay-protection',
      'explicit-sponsor-consent-and-funded-budget',
      'server-side-authorization-and-per-transfer-limits',
      'idempotent-sponsor-ledger-and-reconciliation',
      'finalized-on-chain-evidence-and-idempotent-ledger-transitions',
      'separate-network-fee-and-asset-principal-budgets',
      'testnet-end-to-end-and-security-review',
      'mainnet-operator-approval-and-emergency-pause',
    ],

    message: 'The provider-independent sponsor-wallet signing adapter is implemented for Shasta and Nile, but sponsored submission remains disabled until sponsor consent, funding, fee/resource coverage, reconciliation, and end-to-end review are verified. Fireblocks is not required for this sponsor-wallet workflow. Mainnet sponsor-wallet signing and broadcast are not implemented, and Mainnet remains disabled. The platform must never fall back to charging the user or display sponsor budgets/pending credits as receiver wallet balance. Spendable balance must come from verified on-chain assets; exchange credit requires evidence from the receiving exchange. A normal USDT/TRX transfer cannot impose app-defined restrictions after receipt; such restrictions require an audited escrow/vesting contract or enforcement by the receiving platform.',
  }
}
