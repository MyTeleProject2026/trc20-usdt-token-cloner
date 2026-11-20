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

  res.setHeader?.('Cache-Control', 'no-store')
  res.setHeader?.('Pragma', 'no-cache')

  const balanceTrx = Number(account?.trx || 0)
  const reserveTrx = Number(process.env.SPONSOR_LIQUID_RESERVE_TRX || 2)
  const maxAutomaticStakeTrx = Number(process.env.SPONSOR_MAX_AUTOMATIC_STAKE_TRX || 10)
  const reserveConfigured = Number.isFinite(reserveTrx) && reserveTrx >= 0
  const maxStakeConfigured = Number.isFinite(maxAutomaticStakeTrx) && maxAutomaticStakeTrx >= 1
  const spendableTrx = Math.max(0, balanceTrx - (reserveConfigured ? reserveTrx : 2))
  const identityReady = Boolean(sponsorAddress && ownerAddress && sponsorAddress !== ownerAddress)

  return res.json({
    success: true,
    network: 'TRON Mainnet',
    mode: 'read-only-until-signer-and-admin-auth-are-configured',
    readiness: {
      sponsorOwnerIdentityVerified: identityReady,
      sponsorBalanceRead: Boolean(account),
      resourcesRead: Boolean(resources),
      spendableTrxAfterReserve: Number(spendableTrx.toFixed(6)),
      canStakeNow: false,
      canDelegateNow: false,
      canDeployOwnerContractNow: false,
      blockers: [
        ...(!sponsorAddress ? ['Sponsor Mainnet address is not configured.'] : []),
        ...(!ownerAddress ? ['Owner Mainnet address is not configured.'] : []),
        ...(sponsorAddress && ownerAddress && sponsorAddress === ownerAddress ? ['Sponsor and Owner addresses must be independent.'] : []),
        ...(!account ? ['Sponsor Mainnet balance could not be verified.'] : []),
        ...(!resources ? ['Sponsor resource capacity could not be verified.'] : []),
        ...(!privateKeyConfigured ? ['Server-side Sponsor signer is not configured.'] : []),
        ...(!adminAuthConfigured ? ['Sponsor administrator authorization is not configured.'] : []),
        ...(!stakingEnabled ? ['Sponsor staking engine is not explicitly enabled.'] : []),
        ...(!reserveConfigured || !maxStakeConfigured ? ['Sponsor spending policy configuration is invalid.'] : []),
      ],
    },
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
      maximumAutomaticStakeTrx: maxStakeConfigured ? maxAutomaticStakeTrx : 10,
      protectedLiquidReserveTrx: reserveConfigured ? reserveTrx : 2,
      currentlySpendableAfterReserveTrx: Number(spendableTrx.toFixed(6)),
      automaticUnstakeEnabled: false,
    },
  })
})

export default router
