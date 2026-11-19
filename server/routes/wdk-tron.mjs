import { Router } from 'express'
import { createGasFreeClient } from '../gasfree-client.mjs'
import { createWdkTronReadOnlyService, OFFICIAL_MAINNET_USDT } from '../wdk-tron-readonly.mjs'
import { isValidTronAddress } from '../tron-address.mjs'

const NETWORKS = new Set(['mainnet', 'nile'])

export function createWdkTronRouter({
  gasFreeClient = createGasFreeClient(),
  inspectAccount = createWdkTronReadOnlyService(),
} = {}) {
  const router = Router()

  // Read-only WDK inspection. No POST/send route is mounted here.
  router.get('/tron/readiness', async (req, res) => {
    const network = typeof req.query.network === 'string' ? req.query.network : 'mainnet'
    const { address, recipientAddress, amountBaseUnits, serviceProvider } = req.query
    const tokenAddress = typeof req.query.tokenAddress === 'string'
      ? req.query.tokenAddress
      : network === 'mainnet' ? OFFICIAL_MAINNET_USDT : null

    if (!NETWORKS.has(network)) {
      return res.status(400).json({ success: false, status: 'invalid-network', message: 'network must be mainnet or nile for the combined WDK adapters.' })
    }
    if (!isValidTronAddress(address) || !isValidTronAddress(tokenAddress)) {
      return res.status(400).json({ success: false, status: 'invalid-address', message: 'Provide a valid TRON address and token contract.' })
    }
    if (network === 'mainnet' && tokenAddress !== OFFICIAL_MAINNET_USDT) {
      return res.status(400).json({ success: false, status: 'unapproved-mainnet-token', message: 'Mainnet WDK payout diagnostics are pinned to the official Tether USDT TRC20 contract.' })
    }
    const hasQuote = recipientAddress !== undefined || amountBaseUnits !== undefined
    if (hasQuote && (!isValidTronAddress(recipientAddress)
      || recipientAddress === address
      || typeof amountBaseUnits !== 'string'
      || !/^[1-9][0-9]{0,77}$/.test(amountBaseUnits))) {
      return res.status(400).json({ success: false, status: 'invalid-fee-quote', message: 'Provide a distinct valid recipient and a positive integer amountBaseUnits together.' })
    }

    let capabilities = { configured: false, reachable: false, providers: [] }
    try {
      capabilities = await gasFreeClient.getCapabilities(network)
    } catch {
      // GasFree is optional; standard WDK diagnostics remain available.
    }
    const providerListed = typeof serviceProvider === 'string'
      && Array.isArray(capabilities.providers)
      && capabilities.providers.some((provider) => provider.address === serviceProvider)
    if (serviceProvider !== undefined && !providerListed) {
      return res.status(400).json({ success: false, status: 'unlisted-gasfree-provider', message: 'serviceProvider must exactly match an address returned by authenticated GasFree provider discovery.' })
    }

    try {
      const result = await inspectAccount({
        network,
        address,
        tokenAddress,
        ...(hasQuote ? { recipientAddress, amountBaseUnits } : {}),
        ...(providerListed ? { serviceProvider } : {}),
      })
      return res.json({
        ...result,
        gasfreeProviderDiscovery: {
          configured: capabilities.configured === true,
          reachable: capabilities.reachable === true,
          providerSelected: providerListed,
          providerFundingVerified: false,
        },
        note: network === 'mainnet'
          ? 'Mainnet token balance is queried for official Tether USDT. This endpoint is read-only and never submits a transaction.'
          : 'Nile is a test network; any token balance returned here is testnet data, not genuine Mainnet USDT.',
      })
    } catch (error) {
      const invalidInput = error instanceof TypeError
      return res.status(invalidInput ? 400 : 503).json({
        success: false,
        status: invalidInput ? 'invalid-request' : 'wdk-read-only-unavailable',
        message: invalidInput ? error.message : 'WDK read-only inspection failed safely. No transfer was submitted.',
        transferSigningEnabled: false,
        transferSubmissionEnabled: false,
        transactionBroadcast: false,
      })
    }
  })

  return router
}

export default createWdkTronRouter()
