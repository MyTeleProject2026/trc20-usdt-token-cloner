import { isValidTronAddress } from './tron-address.mjs'

export const OFFICIAL_MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

export const WDK_TRON_NETWORKS = Object.freeze({
  mainnet: {
    chainId: 728126428,
    provider: 'https://api.trongrid.io',
    gasFreeProvider: 'https://open.gasfree.io/tron/',
    verifyingContract: 'TFFAMQLZybALaLb4uxHA9RBE7pxhUAjF3U',
  },
  nile: {
    chainId: 3448148188,
    provider: 'https://nile.trongrid.io',
    gasFreeProvider: 'https://open-test.gasfree.io/nile/',
    verifyingContract: 'THQGuFzL87ZqhxkgqYEryRAd7gqFqL5rdc',
  },
})

const AMOUNT = /^[1-9][0-9]{0,77}$/

function asDecimal(value) {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value)) return value
  return null
}

function safeErrorStatus() {
  return { status: 'read-only-unavailable', available: false }
}

/**
 * WDK adapters deliberately instantiate read-only account classes only.
 * No mnemonic, seed, private key, signing method, transfer method or broadcast
 * method is accepted or called by this service.
 */
export function createWdkTronReadOnlyService({
  loadStandardModule = () => import('@tetherto/wdk-wallet-tron'),
  loadGasFreeModule = () => import('@tetherto/wdk-wallet-tron-gasfree'),
} = {}) {
  return async function readWdkTronAccount({
    network,
    address,
    tokenAddress,
    recipientAddress,
    amountBaseUnits,
    serviceProvider,
    env = process.env,
  } = {}) {
    const networkConfig = WDK_TRON_NETWORKS[network]
    if (!networkConfig) throw new TypeError('Unsupported WDK TRON network')
    if (!isValidTronAddress(address) || !isValidTronAddress(tokenAddress)) {
      throw new TypeError('Invalid WDK TRON account or token address')
    }
    const hasQuote = recipientAddress !== undefined || amountBaseUnits !== undefined
    if (hasQuote && (!isValidTronAddress(recipientAddress)
      || recipientAddress === address
      || typeof amountBaseUnits !== 'string'
      || !AMOUNT.test(amountBaseUnits))) {
      throw new TypeError('A fee quote requires a distinct valid recipient and positive base-unit amount')
    }

    const standard = await (async () => {
      let account
      try {
        const module = await loadStandardModule()
        if (typeof module.WalletAccountReadOnlyTron !== 'function') return safeErrorStatus()
        account = new module.WalletAccountReadOnlyTron(address, { provider: networkConfig.provider })
        const [trxBalance, tokenBalance, quote] = await Promise.all([
          account.getBalance(),
          account.getTokenBalance(tokenAddress),
          hasQuote
            ? account.quoteTransfer({
              token: tokenAddress,
              recipient: recipientAddress,
              amount: BigInt(amountBaseUnits),
            })
            : Promise.resolve(null),
        ])
        return {
          available: true,
          status: 'read-only-balance-and-fee-quote',
          trxBalanceSun: asDecimal(trxBalance),
          tokenBalanceBaseUnits: asDecimal(tokenBalance),
          ...(quote ? { estimatedNetworkFeeSun: asDecimal(quote.fee) } : {}),
          source: 'WDK standard TRON read-only account via configured TRON RPC',
        }
      } catch {
        return safeErrorStatus()
      }
    })()

    let gasfree
    if (network === 'mainnet' || network === 'nile') {
      if (!isValidTronAddress(serviceProvider)) {
        gasfree = {
          available: false,
          status: 'service-provider-not-selected',
          note: 'Select a service-provider address returned by the authenticated GasFree provider discovery endpoint.',
        }
      } else {
        try {
          const module = await loadGasFreeModule()
          if (typeof module.WalletAccountReadOnlyTronGasfree !== 'function') {
            gasfree = safeErrorStatus()
          } else {
            const gasFreeConfig = {
              chainId: networkConfig.chainId,
              provider: networkConfig.provider,
              gasFreeProvider: networkConfig.gasFreeProvider,
              serviceProvider,
              verifyingContract: networkConfig.verifyingContract,
              ...(typeof env.GASFREE_MAINNET_API_KEY === 'string'
                && typeof env.GASFREE_MAINNET_API_SECRET === 'string'
                && network === 'mainnet'
                ? { gasFreeApiKey: env.GASFREE_MAINNET_API_KEY, gasFreeApiSecret: env.GASFREE_MAINNET_API_SECRET }
                : {}),
              ...(typeof env.GASFREE_NILE_API_KEY === 'string'
                && typeof env.GASFREE_NILE_API_SECRET === 'string'
                && network === 'nile'
                ? { gasFreeApiKey: env.GASFREE_NILE_API_KEY, gasFreeApiSecret: env.GASFREE_NILE_API_SECRET }
                : {}),
            }
            const account = new module.WalletAccountReadOnlyTronGasfree(address, gasFreeConfig)
            const [trxBalance, tokenBalance, quote] = await Promise.all([
              account.getBalance(),
              account.getTokenBalance(tokenAddress),
              hasQuote
                ? account.quoteTransfer({
                  token: tokenAddress,
                  recipient: recipientAddress,
                  amount: BigInt(amountBaseUnits),
                })
                : Promise.resolve(null),
            ])
            gasfree = {
              available: true,
              status: 'read-only-balance-and-provider-fee-quote',
              trxBalanceSun: asDecimal(trxBalance),
              tokenBalanceBaseUnits: asDecimal(tokenBalance),
              ...(quote ? {
                estimatedTokenFeeBaseUnits: asDecimal(quote.fee),
                ...(quote.activationFee !== undefined
                  ? { estimatedActivationFeeBaseUnits: asDecimal(quote.activationFee) }
                  : {}),
              } : {}),
              feeCurrency: 'transferred-token',
              source: 'WDK GasFree TRON read-only account and provider quote',
            }
          }
        } catch {
          gasfree = safeErrorStatus()
        }
      }
    } else {
      gasfree = { available: false, status: 'network-not-supported-by-gasfree' }
    }

    return {
      success: true,
      status: 'wdk-read-only-inspection',
      network,
      address,
      tokenAddress,
      standard,
      gasfree,
      policy: {
        privateKeyHandling: false,
        mnemonicHandling: false,
        sponsorAuthorizationVerified: false,
        providerFundingVerified: false,
        transferSigningEnabled: false,
        transferSubmissionEnabled: false,
        transactionBroadcast: false,
        mainnetSettlementVerified: false,
        note: 'WDK balances and fee quotes are diagnostics only. They do not authorize a payout, establish sponsor consent or funding, or prove a solidified Mainnet receipt.',
      },
    }
  }
}

export default createWdkTronReadOnlyService()
