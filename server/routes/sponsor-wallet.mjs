import { Router } from 'express'
import { TronWeb } from 'tronweb'

const router = Router()
const MAINNET = 'https://api.trongrid.io'
const SUN = 1_000_000

function configuredAddress(value) {
  return typeof value === 'string' && /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value) ? value : ''
}

router.get('/sponsor/status', async (_req, res) => {
  const sponsorAddress = configuredAddress(process.env.SPONSOR_MAINNET_ADDRESS)
  const ownerAddress = configuredAddress(process.env.TRON_OWNER_ADDRESS || process.env.TRON_OWNER_WALLET_ADDRESS)
  const privateKeyConfigured = Boolean(process.env.SPONSOR_MAINNET_PRIVATE_KEY)
  const adminAuthConfigured = Boolean(process.env.SPONSOR_ADMIN_TOKEN)
  const stakingEnabled = process.env.SPONSOR_STAKING_ENABLED === 'true'
  const tronWeb = new TronWeb({ fullHost: MAINNET, headers: process.env.TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY } : {} })
  let account = null
  let resources = null
  let readError = null

  if (sponsorAddress) {
    try {
      const [balanceSun, accountResources] = await Promise.all([
        tronWeb.trx.getBalance(sponsorAddress),
        tronWeb.trx.getAccountResources(sponsorAddress),
      ])
      account = { address: sponsorAddress, trx: Number(balanceSun) / SUN }
      resources = {
        energyLimit: Number(accountResources.EnergyLimit || 0),
        energyUsed: Number(accountResources.EnergyUsed || 0),
        freeNetLimit: Number(accountResources.freeNetLimit || 0),
        freeNetUsed: Number(accountResources.freeNetUsed || 0),
        netLimit: Number(accountResources.NetLimit || 0),
        netUsed: Number(accountResources.NetUsed || 0),
      }
    } catch {
      readError = 'Mainnet account/resource query failed.'
    }
  }

  return res.json({
    success: true,
    network: 'TRON Mainnet',
    mode: 'read-only-until-signer-and-admin-auth-are-configured',
    sponsor: { configured: Boolean(sponsorAddress), account, resources, readError },
    owner: { configured: Boolean(ownerAddress), address: ownerAddress || null },
    capabilities: {
      serverSignerConfigured: privateKeyConfigured,
      adminAuthorizationConfigured: adminAuthConfigured,
      stakingEnabled,
      canStake: false,
      canDelegate: false,
      reason: 'Signing and broadcast operations remain disabled until the authenticated Sponsor transaction service is installed, reviewed, and explicitly enabled.',
    },
    limits: {
      minimumStakeTrx: 1,
      maximumAutomaticStakeTrx: Number(process.env.SPONSOR_MAX_AUTOMATIC_STAKE_TRX || 10),
      protectedLiquidReserveTrx: Number(process.env.SPONSOR_LIQUID_RESERVE_TRX || 2),
      automaticUnstakeEnabled: false,
    },
  })
})

export default router
