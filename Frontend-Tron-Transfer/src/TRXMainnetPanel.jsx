import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Coins, ExternalLink, LockKeyhole, RefreshCw, Rocket, ShieldCheck, Unlock, Wallet } from 'lucide-react'
import './trax-mainnet.css'
import {
  TRON_MAINNET_HOST, TRAX_TOKEN_ARTIFACT, TRAX_VAULT_ARTIFACT,
  addressesEqual, assertMainnetWallet, deployContractFromTronLink,
  formatTokenUnits, getMainnetAccountPermissionSnapshot, getMainnetAccountResourceSnapshot,
  loadSavedContracts, parseTokenUnits, saveContractAddresses,
  sendAndVerifyContractCall, sendNativeTrxFromTronLink,
} from './trax-mainnet.mjs'

const ZERO = '0x0000000000000000000000000000000000000000'
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/
const DEFAULT_RECIPIENT = 'TKmwZgALZPatKVJpcAx93XVNu6DiaauPFk'
const DEFAULT_FEE_CAP = '300'
const FREE_DELEGATION_OWNER = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const RESOURCE_API_BASE = (import.meta.env.VITE_API_BASE_URL || 'https://tron-transfer-resource-api.onrender.com').replace(/\/+$/, '')

function toSun(value) {
  const units = parseTokenUnits(value)
  const amount = BigInt(units)
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('TRX amount exceeds the safe UI input limit.')
  return Number(amount)
}

function makeReference() {
  const bytes = new Uint8Array(32)
  window.crypto.getRandomValues(bytes)
  return '0x' + Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
}

function shorten(value) {
  return value && value.length > 18 ? value.slice(0, 10) + '…' + value.slice(-7) : value || '—'
}

async function readServerFreeDelegationStatus(address, refresh = false) {
  const query = new URLSearchParams({ address, ...(refresh ? { refresh: '1' } : {}) })
  const response = await fetch(RESOURCE_API_BASE + '/api/tron/resources/free-delegation/status?' + query.toString(), {
    method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit', cache: 'no-store', redirect: 'error',
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.success !== true || !payload.deploymentResourceSnapshot) {
    throw new Error(payload?.message || payload?.error || 'Server-side Mainnet resource status is unavailable.')
  }
  return payload
}

async function readServerDeploymentResources(_tronWeb, address) {
  const status = await readServerFreeDelegationStatus(address, true)
  return status.deploymentResourceSnapshot
}

async function tenergyPromoRequest(path, method = 'GET', body = undefined) {
  const response = await fetch(RESOURCE_API_BASE + '/api/tron/resources/free-delegation/tenergy/' + path, {
    method, headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    credentials: 'omit', cache: 'no-store', redirect: 'error',
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.success !== true) throw new Error(payload?.message || payload?.error || 'TEnergy free-promo service is unavailable.')
  return payload
}

export default function TRXMainnetPanel({ wallet, onConnect }) {
  const initial = useMemo(() => {
    const saved = loadSavedContracts()
    // Never reuse the prefilled recipient wallet or numeric form values as contract addresses.
    const isPlausibleContractAddress = value => typeof value === 'string'
      && value !== DEFAULT_RECIPIENT && /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value.trim())
    return {
      tokenAddress: isPlausibleContractAddress(saved.tokenAddress) ? saved.tokenAddress.trim() : '',
      vaultAddress: isPlausibleContractAddress(saved.vaultAddress) ? saved.vaultAddress.trim() : '',
    }
  }, [])
  const [tokenAddress,setTokenAddress] = useState(initial.tokenAddress)
  const [vaultAddress,setVaultAddress] = useState(initial.vaultAddress)
  const [snapshot,setSnapshot] = useState(null)
  const [recipient,setRecipient] = useState(DEFAULT_RECIPIENT)
  const [amount,setAmount] = useState('100')
  const [fundAmount,setFundAmount] = useState('100')
  const [holder,setHolder] = useState(DEFAULT_RECIPIENT)
  const [redeemRecipient,setRedeemRecipient] = useState(DEFAULT_RECIPIENT)
  const [redeemAmount,setRedeemAmount] = useState('100')
  const [feeCap,setFeeCap] = useState(DEFAULT_FEE_CAP)
  const [busy,setBusy] = useState(false)
  const [error,setError] = useState('')
  const [notice,setNotice] = useState('')
  const [lastTx,setLastTx] = useState('')
  const [step,setStep] = useState('')
  const [resourceStatus,setResourceStatus] = useState(null)
  const [resourceLoading,setResourceLoading] = useState(false)
  const [resourceError,setResourceError] = useState('')
  const [freeDelegationStatus,setFreeDelegationStatus] = useState(null)
  const [freeDelegationError,setFreeDelegationError] = useState('')
  const [tenergyPromo,setTenergyPromo] = useState(null)
  const [tenergyBusy,setTenergyBusy] = useState(false)
  const [tenergyMessage,setTenergyMessage] = useState('')
  const [permissionStatus,setPermissionStatus] = useState(null)
  const [permissionLoading,setPermissionLoading] = useState(false)
  const [permissionError,setPermissionError] = useState('')

  useEffect(() => {
    try { saveContractAddresses({ tokenAddress, vaultAddress }) } catch {}
  }, [tokenAddress,vaultAddress])

  const run = useCallback(async (label, action) => {
    setBusy(true); setError(''); setNotice(''); setStep(label)
    try { return await action() }
    catch (cause) { const message = cause instanceof Error ? cause.message : String(cause); setError(message); return null }
    finally { setBusy(false); setStep('') }
  }, [])

  const connectedAddress = wallet?.address || ''
  const walletReady = Boolean(wallet?.tronWeb && connectedAddress)

  const refreshTenergyPromo = useCallback(async () => {
    if (!walletReady || connectedAddress !== FREE_DELEGATION_OWNER) { setTenergyPromo(null); return }
    try {
      const result = await tenergyPromoRequest('promo?address=' + encodeURIComponent(connectedAddress))
      setTenergyPromo(result)
    } catch (cause) {
      setTenergyPromo(null)
      setTenergyMessage(cause instanceof Error ? cause.message : 'TEnergy promotional status is unavailable.')
    }
  }, [walletReady, connectedAddress])

  const claimTenergyPromo = () => run('Requesting a free Energy promo · review the message in TronLink', async () => {
    if (!walletReady || connectedAddress !== FREE_DELEGATION_OWNER) throw new Error('Connect the configured TRON Mainnet owner wallet.')
    const tronWeb = assertMainnetWallet(wallet)
    const challengeResult = await tenergyPromoRequest('challenge', 'POST', { address: connectedAddress })
    const challenge = challengeResult.challenge
    if (!challenge || challenge.address !== connectedAddress || typeof challenge.message !== 'string') throw new Error('The provider returned an invalid wallet challenge.')
    if (typeof tronWeb.trx?.signMessageV2 !== 'function') throw new Error('This TronLink version does not expose signMessageV2. Update TronLink and retry.')
    const signature = await tronWeb.trx.signMessageV2(challenge.message)
    if (typeof signature !== 'string' || !/^(?:0x)?[0-9a-fA-F]{130}$/.test(signature)) throw new Error('TronLink did not return a valid message signature.')
    const redemption = await tenergyPromoRequest('redeem', 'POST', { address: connectedAddress, nonce: challenge.nonce, signature })
    setTenergyMessage(redemption.redemption?.status === 'delegated'
      ? 'TEnergy reports the promotional delegation as complete. Refresh Mainnet resources to verify the received Energy.'
      : 'The free promo claim was accepted and is being processed. Refresh claim status shortly.')
    await refreshTenergyPromo()
    return redemption
  })

  const checkTenergyRedemption = async () => {
    if (!walletReady || connectedAddress !== FREE_DELEGATION_OWNER) return
    setTenergyBusy(true)
    try {
      const result = await tenergyPromoRequest('redemption?address=' + encodeURIComponent(connectedAddress))
      setTenergyPromo(prev => ({ ...(prev || {}), redemption: result.redemption }))
      setTenergyMessage(result.redemption.status === 'delegated'
        ? 'Provider reports the grant delegated. Refresh resources to confirm the on-chain Energy balance.'
        : 'Provider claim status: ' + result.redemption.status + '.')
    } catch (cause) {
      setTenergyMessage(cause instanceof Error ? cause.message : 'Could not refresh the provider claim.')
    } finally { setTenergyBusy(false) }
  }

  const refreshWalletResources = useCallback(async () => {
    if (!walletReady || !connectedAddress) return
    setResourceLoading(true)
    setResourceError('')
    setFreeDelegationError('')
    try {
      try {
        const status = await readServerFreeDelegationStatus(connectedAddress)
        setFreeDelegationStatus(status)
      } catch (cause) {
        setFreeDelegationStatus(null)
        setFreeDelegationError(cause instanceof Error ? cause.message : 'Server-side delegation status is unavailable.')
      }
      // Keep the wallet-provider snapshot for display and independent cross-checking.
      // Deployment resource budgeting itself uses the server-side Mainnet reader below.
      const tronWeb = assertMainnetWallet(wallet)
      const resources = await getMainnetAccountResourceSnapshot(tronWeb, connectedAddress)
      setResourceStatus({
        network: 'TRON Mainnet',
        address: connectedAddress,
        checkedAt: new Date().toISOString(),
        energy: { available: resources.energyAvailable },
        bandwidth: {
          freeAvailable: resources.freeBandwidthAvailable,
          stakedOrDelegatedAvailable: resources.stakedBandwidthAvailable,
        },
        balanceSun: resources.nativeBalanceSun,
        chainParameters: {
          energyFeeSunPerUnit: resources.energyFeeSun,
          bandwidthFeeSunPerByte: resources.bandwidthFeeSun,
        },
        estimateNote: 'Live wallet-provider snapshot. Deployment resource budgeting uses the server-side Mainnet reader and separately simulates contract init bytecode.',
      })
    } catch (cause) {
      setResourceError(cause instanceof Error ? cause.message : String(cause))
      setResourceStatus(null)
    } finally {
      setResourceLoading(false)
    }
  }, [wallet, walletReady, connectedAddress])

  const refreshWalletPermissions = useCallback(async () => {
    if (!walletReady || !connectedAddress) return
    setPermissionLoading(true)
    setPermissionError('')
    try {
      const permissions = await getMainnetAccountPermissionSnapshot(assertMainnetWallet(wallet), connectedAddress)
      setPermissionStatus(permissions)
    } catch (cause) {
      setPermissionError(cause instanceof Error ? cause.message : String(cause))
      setPermissionStatus(null)
    } finally {
      setPermissionLoading(false)
    }
  }, [wallet, walletReady, connectedAddress])

  useEffect(() => {
    setResourceStatus(null)
    setPermissionStatus(null)
    refreshWalletResources()
    refreshWalletPermissions()
  }, [connectedAddress, refreshWalletResources, refreshWalletPermissions])

  useEffect(() => { refreshTenergyPromo() }, [refreshTenergyPromo])

  const configuredOwnerMatches = walletReady
  const feeCapSun = useMemo(() => {
    try { return toSun(feeCap) } catch { return 0 }
  }, [feeCap])

  const assertOwner = useCallback(async (token, tronWeb) => {
    const owner = await token.owner().call()
    if (!addressesEqual(tronWeb, owner, connectedAddress)) throw new Error('The connected TronLink wallet is not the on-chain TRӾ owner.')
    return owner
  }, [connectedAddress])

  const getContracts = useCallback(async () => {
    const tronWeb = assertMainnetWallet(wallet)
    if (!tronWeb.isAddress(tokenAddress) || !tronWeb.isAddress(vaultAddress)) throw new Error('Enter both deployed TRӾ token and reserve-vault addresses.')
    const token = await tronWeb.contract(TRAX_TOKEN_ARTIFACT.abi).at(tokenAddress)
    const vault = await tronWeb.contract(TRAX_VAULT_ARTIFACT.abi).at(vaultAddress)
    return { tronWeb, token, vault }
  }, [wallet,tokenAddress,vaultAddress])

  const refresh = useCallback(async () => run('Reading solidified Mainnet state', async () => {
    const {tronWeb,token,vault} = await getContracts()
    const [owner,vaultOwner,name,symbol,decimals,totalSupply,tokenVault,authorizedToken,paused,mintingEnabled,reserveSun,ownerBalance,ownerTrxSun] = await Promise.all([
      token.owner().call(), vault.owner().call(), token.name().call(), token.symbol().call(), token.decimals().call(),
      token.totalSupply().call(), token.reserveVault().call(), vault.authorizedToken().call(),
      token.paused().call(), token.mintingEnabled().call(), tronWeb.trx.getBalance(vaultAddress),
      token.balanceOf(connectedAddress).call(), tronWeb.trx.getBalance(connectedAddress),
    ])
    const metadataValid = name === 'TRӾ' && symbol === 'TRX' && Number(decimals) === 6
    const ownerMatches = addressesEqual(tronWeb, owner, connectedAddress)
    const vaultOwnerMatches = addressesEqual(tronWeb, vaultOwner, connectedAddress)
    const linksValid = addressesEqual(tronWeb, tokenVault, vaultAddress) && addressesEqual(tronWeb, authorizedToken, tokenAddress) && ownerMatches && vaultOwnerMatches
    const backed = BigInt(String(reserveSun)) >= BigInt(String(totalSupply))
    const next = {
      owner:String(owner),vaultOwner:String(vaultOwner),name,symbol,decimals:Number(decimals),totalSupply:String(totalSupply),
      tokenVault:String(tokenVault),authorizedToken:String(authorizedToken),paused:Boolean(paused),
      mintingEnabled:Boolean(mintingEnabled),reserveSun:String(reserveSun),
      ownerBalance:String(ownerBalance),ownerTrxSun:String(ownerTrxSun),
      metadataValid,ownerMatches,vaultOwnerMatches,linksValid,backed,
      shortfall: backed ? '0' : (BigInt(String(totalSupply))-BigInt(String(reserveSun))).toString(),
      surplus: backed ? (BigInt(String(reserveSun))-BigInt(String(totalSupply))).toString() : '0',
    }
    setSnapshot(next)
    if (!metadataValid) throw new Error('The deployed contract metadata does not match TRӾ / TRX / 6 decimals.')
    if (!ownerMatches || !vaultOwnerMatches) throw new Error('The connected wallet must own both the TRӾ token and reserve vault. Reconnect the deploying wallet to administer these contracts.')
    if (!linksValid) throw new Error('The token and reserve vault are not linked to each other correctly.')
    setNotice('Mainnet contracts read successfully. Metadata and reciprocal reserve authorization are verified at the latest node state.')
    return next
  }), [run,getContracts,connectedAddress,vaultAddress])

  // Re-check saved contracts automatically when the configured owner reconnects.
  // This is read-only: it never deploys, links, funds, mints, or signs transactions.
  useEffect(() => {
    if (!walletReady || !configuredOwnerMatches || !tokenAddress || !vaultAddress) return
    if (!wallet.tronWeb.isAddress(tokenAddress) || !wallet.tronWeb.isAddress(vaultAddress)) {
      setSnapshot(null)
      setError('Saved contract address is invalid. Clear the address fields and recover the verified Mainnet contract addresses.')
      return
    }
    refresh()
  }, [walletReady, configuredOwnerMatches, tokenAddress, vaultAddress, wallet, refresh])

  const deployMissingContracts = () => run('Deploying missing TRӾ contracts · approve each prompt in TronLink', async () => {
    if (!walletReady) throw new Error('Connect a TronLink Mainnet wallet.')
    if (connectedAddress !== FREE_DELEGATION_OWNER) throw new Error('Free-delegation policy is restricted to ' + FREE_DELEGATION_OWNER + '. Connect that wallet in TronLink.')
    if (!configuredOwnerMatches) throw new Error('Connect a TronLink Mainnet wallet.')
    if (tokenAddress && !wallet.tronWeb.isAddress(tokenAddress)) throw new Error('The saved TRӾ token address is invalid. Clear it and retry.')
    if (vaultAddress && !wallet.tronWeb.isAddress(vaultAddress)) throw new Error('The saved reserve-vault address is invalid. Clear it and retry.')
    if (tokenAddress && (addressesEqual(wallet.tronWeb,tokenAddress,connectedAddress))) {
      throw new Error('The TRӾ token field contains your owner wallet address, not a smart-contract address. Clear that field so the TRӾ token contract can be deployed.')
    }
    if (vaultAddress && (addressesEqual(wallet.tronWeb,vaultAddress,connectedAddress))) {
      throw new Error('The reserve-vault field contains your owner wallet address, not a smart-contract address. Clear that field so the reserve vault can be deployed.')
    }
    for (const [label,address] of [['TRӾ token',tokenAddress],['reserve vault',vaultAddress]]) {
      if (!address) continue
      const deployedContract = await wallet.tronWeb.trx.getContract(address)
      if (!deployedContract?.bytecode) throw new Error('The saved '+label+' address has no verified deployed contract bytecode. Clear it and deploy the contract; do not use a wallet address here.')
    }
    const deployed = []
    if (!vaultAddress) {
      const result = await deployContractFromTronLink(wallet,TRAX_VAULT_ARTIFACT,'OneTraxReserveVault',feeCapSun,{ readResources: readServerDeploymentResources })
      setVaultAddress(result.address); setLastTx(result.txID); deployed.push('reserve vault')
    }
    if (!tokenAddress) {
      const result = await deployContractFromTronLink(wallet,TRAX_TOKEN_ARTIFACT,'Restricted1TRAX',feeCapSun,{ readResources: readServerDeploymentResources })
      setTokenAddress(result.address); setLastTx(result.txID); deployed.push('TRӾ token')
    }
    setNotice(deployed.length
      ? 'Deployment complete and solidified: '+deployed.join(' and ')+'. Both contract addresses have been saved automatically. Continue with the two reciprocal authorization steps.'
      : 'Both contract addresses are already present. Continue with reciprocal authorization.')
  })

  const deployVault = () => run('Deploying reserve vault · approve in TronLink', async () => {
    if (!walletReady) throw new Error('Connect a TronLink Mainnet wallet.')
    if (connectedAddress !== FREE_DELEGATION_OWNER) throw new Error('Free-delegation policy is restricted to ' + FREE_DELEGATION_OWNER + '. Connect that wallet in TronLink.')
    if (!configuredOwnerMatches) throw new Error('Connect a TronLink Mainnet wallet.')
    const result = await deployContractFromTronLink(wallet,TRAX_VAULT_ARTIFACT,'OneTraxReserveVault',feeCapSun,{ readResources: readServerDeploymentResources })
    setVaultAddress(result.address); setLastTx(result.txID)
    setNotice('Reserve vault deployed and solidified. Continue by deploying the TRӾ token.')
  })

  const deployToken = () => run('Deploying TRӾ token · approve in TronLink', async () => {
    if (!walletReady) throw new Error('Connect a TronLink Mainnet wallet.')
    if (connectedAddress !== FREE_DELEGATION_OWNER) throw new Error('Free-delegation policy is restricted to ' + FREE_DELEGATION_OWNER + '. Connect that wallet in TronLink.')
    if (!configuredOwnerMatches) throw new Error('Connect a TronLink Mainnet wallet.')
    const result = await deployContractFromTronLink(wallet,TRAX_TOKEN_ARTIFACT,'Restricted1TRAX',feeCapSun,{ readResources: readServerDeploymentResources })
    setTokenAddress(result.address); setLastTx(result.txID)
    setNotice('TRӾ token deployed and solidified. Next authorize the token in the vault.')
  })

  const authorizeVault = () => run('Authorizing TRӾ in reserve vault · approve in TronLink', async () => {
    if (!configuredOwnerMatches) throw new Error('Connect a TronLink Mainnet wallet.')
    const {tronWeb,token,vault} = await getContracts()
    await assertOwner(token,tronWeb)
    if (!addressesEqual(tronWeb,await vault.owner().call(),connectedAddress)) throw new Error('Connected TronLink wallet is not the reserve-vault owner.')
    const abiMethod = vault.setAuthorizedToken(tokenAddress)
    const result = await sendAndVerifyContractCall(tronWeb,abiMethod,feeCapSun,connectedAddress)
    setLastTx(result.txID); setNotice('Vault authorization is confirmed. Next link the vault in the TRӾ token contract.')
  })

  const linkToken = () => run('Linking reserve vault in TRӾ token · approve in TronLink', async () => {
    if (!configuredOwnerMatches) throw new Error('Connect a TronLink Mainnet wallet.')
    const {tronWeb,token,vault} = await getContracts()
    await assertOwner(token,tronWeb)
    if (!addressesEqual(tronWeb,await vault.authorizedToken().call(),tokenAddress)) throw new Error('Authorize this TRӾ token in the vault first.')
    const result = await sendAndVerifyContractCall(tronWeb,token.setReserveVault(vaultAddress),feeCapSun,connectedAddress)
    setLastTx(result.txID); setNotice('Token-to-vault link is confirmed. Refresh the on-chain status before funding or enabling minting.')
  })

  const fundVault = () => run('Funding native TRX reserve · approve in TronLink', async () => {
    if (!configuredOwnerMatches) throw new Error('Connect a TronLink Mainnet wallet.')
    const {tronWeb,vault} = await getContracts()
    await assertOwner(await tronWeb.contract(TRAX_TOKEN_ARTIFACT.abi).at(tokenAddress),tronWeb)
    const [vaultOwner,authorizedToken, linkedVault] = await Promise.all([vault.owner().call(),vault.authorizedToken().call(),(await tronWeb.contract(TRAX_TOKEN_ARTIFACT.abi).at(tokenAddress)).reserveVault().call()])
    if (!addressesEqual(tronWeb,vaultOwner,connectedAddress)) throw new Error('Connected TronLink wallet is not the reserve-vault owner.')
    if (!addressesEqual(tronWeb,authorizedToken,tokenAddress)||!addressesEqual(tronWeb,linkedVault,vaultAddress)) throw new Error('Complete and verify both one-time vault links before funding.')
    const result = await sendNativeTrxFromTronLink(wallet,vaultAddress,toSun(fundAmount))
    setLastTx(result.txID); setNotice('Native TRX reserve deposit is solidified. Refresh to verify the actual vault balance.')
  })

  const activate = () => run('Enabling TRӾ issuance · two owner approvals', async () => {
    if (!configuredOwnerMatches) throw new Error('Connect a TronLink Mainnet wallet.')
    const {tronWeb,token,vault} = await getContracts()
    await assertOwner(token,tronWeb)
    const [name,symbol,decimals,tokenVault,authorizedToken,supply,reserve,paused,enabled,vaultOwner] = await Promise.all([
      token.name().call(),token.symbol().call(),token.decimals().call(),token.reserveVault().call(),
      vault.authorizedToken().call(),token.totalSupply().call(),tronWeb.trx.getBalance(vaultAddress),
      token.paused().call(),token.mintingEnabled().call(),vault.owner().call(),
    ])
    if(name!=='TRӾ'||symbol!=='TRX'||Number(decimals)!==6) throw new Error('Token identity mismatch.')
    if(!addressesEqual(tronWeb,tokenVault,vaultAddress)||!addressesEqual(tronWeb,authorizedToken,tokenAddress)) throw new Error('Reserve links are incomplete or incorrect.')
    if(!addressesEqual(tronWeb,vaultOwner,connectedAddress)) throw new Error('Connected TronLink wallet is not the reserve-vault owner.')
    if(BigInt(String(reserve))<BigInt(String(supply))) throw new Error('Native TRX reserve is below outstanding TRӾ liability.')
    if(enabled) throw new Error('Minting is already enabled. Use Disable minting to turn it off.')
    if(paused) {
      const unpause=await sendAndVerifyContractCall(tronWeb,token.setPaused(false),feeCapSun,connectedAddress)
      setLastTx(unpause.txID)
    }
    const enable=await sendAndVerifyContractCall(tronWeb,token.setMintingEnabled(true),feeCapSun,connectedAddress)
    setLastTx(enable.txID)
    setNotice('TRӾ issuance is enabled. Each mint still requires its own separate approval and reserve preflight.')
    await refresh()
  })

  const issue = () => run('Issuing restricted TRӾ · approve in TronLink', async () => {
    if (!configuredOwnerMatches) throw new Error('Connect a TronLink Mainnet wallet.')
    const {tronWeb,token,vault} = await getContracts()
    await assertOwner(token,tronWeb)
    if(!tronWeb.isAddress(recipient)) throw new Error('Enter a valid TRON Mainnet recipient address.')
    const units = parseTokenUnits(amount)
    const [paused,enabled,supply,reserve,tokenVault,authorizedToken,recipientLocked,vaultOwner] = await Promise.all([
      token.paused().call(),token.mintingEnabled().call(),token.totalSupply().call(),
      tronWeb.trx.getBalance(vaultAddress),token.reserveVault().call(),vault.authorizedToken().call(),
      token.isLocked(recipient).call(),vault.owner().call(),
    ])
    if(paused||!enabled) throw new Error('Minting is paused or disabled. Complete the owner activation step first.')
    if(recipientLocked!==true) throw new Error('Recipient must be locked before minting. Use Lock recipient, then refresh and retry.')
    if(!addressesEqual(tronWeb,vaultOwner,connectedAddress)) throw new Error('Reserve vault owner does not match the connected deploying wallet.')
    if(!addressesEqual(tronWeb,tokenVault,vaultAddress)||!addressesEqual(tronWeb,authorizedToken,tokenAddress)) throw new Error('Token/vault authorization is not valid.')
    if(BigInt(String(reserve))<BigInt(String(supply))+BigInt(units)) throw new Error('Insufficient uncommitted native TRX reserve for this mint.')
    const result = await sendAndVerifyContractCall(tronWeb,token.mint(recipient,units),feeCapSun,connectedAddress)
    setLastTx(result.txID); setNotice(amount+' TRӾ issued to '+recipient+'. The recipient starts locked by contract default.')
    await refresh()
  })

  const setLock = (locked) => run((locked?'Locking':'Unlocking')+' recipient · approve in TronLink', async () => {
    if (!configuredOwnerMatches) throw new Error('Connect a TronLink Mainnet wallet.')
    const tronWeb = assertMainnetWallet(wallet)
    if (!tronWeb.isAddress(tokenAddress)) throw new Error('Enter a valid deployed TRӾ token contract address.')
    const token = await tronWeb.contract(TRAX_TOKEN_ARTIFACT.abi).at(tokenAddress)
    await assertOwner(token,tronWeb)
    const target = holder.trim()
    if(!tronWeb.isAddress(target)) throw new Error('Enter a valid recipient address.')
    const result=await sendAndVerifyContractCall(tronWeb,token.setRecipientLocked(target,locked),feeCapSun,connectedAddress)
    setLastTx(result.txID); setNotice('Recipient '+target+' is now '+(locked?'LOCKED':'UNLOCKED')+' on-chain.')
    await refresh()
  })

  const redeem = () => run('Redeeming TRӾ and releasing native TRX · approve in TronLink', async () => {
    if (!configuredOwnerMatches) throw new Error('Connect a TronLink Mainnet wallet.')
    const {tronWeb,token} = await getContracts()
    await assertOwner(token,tronWeb)
    if(!tronWeb.isAddress(holder)||!tronWeb.isAddress(redeemRecipient)) throw new Error('Enter valid holder and native-TRX recipient addresses.')
    const units=parseTokenUnits(redeemAmount)
    const [holderBalance,reserveSun,linkedVault,authorizedToken] = await Promise.all([
      token.balanceOf(holder).call(),
      tronWeb.trx.getBalance(vaultAddress),
      token.reserveVault().call(),
      (await tronWeb.contract(TRAX_VAULT_ARTIFACT.abi).at(vaultAddress)).authorizedToken().call(),
    ])
    if(BigInt(String(holderBalance))<BigInt(units)) throw new Error('Holder does not have enough TRӾ for this redemption.')
    if(BigInt(String(reserveSun))<BigInt(units)) throw new Error('Native TRX vault reserve is insufficient for this redemption.')
    if(!addressesEqual(tronWeb,linkedVault,vaultAddress)||!addressesEqual(tronWeb,authorizedToken,tokenAddress)) throw new Error('Token and reserve-vault links are not verified.')
    const reference=makeReference()
    const result=await sendAndVerifyContractCall(tronWeb,token.redeemForOwner(holder,redeemRecipient,units,reference),feeCapSun,connectedAddress)
    setLastTx(result.txID); setNotice('Owner redemption confirmed. The holder balance was burned and native TRX was released atomically.')
    await refresh()
  })

  const setPauseState = (pause) => run((pause?'Pausing':'Unpausing')+' TRӾ · approve in TronLink', async () => {
    const {tronWeb,token} = await getContracts()
    await assertOwner(token,tronWeb)
    const result=await sendAndVerifyContractCall(tronWeb,token.setPaused(pause),feeCapSun,connectedAddress)
    setLastTx(result.txID); setNotice(pause?'TRӾ is paused. Transfers, approvals, minting and redemption are blocked.':'TRӾ is unpaused. Minting still depends on the separate minting-enabled flag.')
    await refresh()
  })

  const disableMinting = () => run('Disabling TRӾ minting · approve in TronLink', async () => {
    const {tronWeb,token} = await getContracts()
    await assertOwner(token,tronWeb)
    const result=await sendAndVerifyContractCall(tronWeb,token.setMintingEnabled(false),feeCapSun,connectedAddress)
    setLastTx(result.txID); setNotice('TRӾ minting is disabled on Mainnet.')
    await refresh()
  })

  const readRecipient = () => run('Reading recipient balance and lock state', async () => {
    const tronWeb = assertMainnetWallet(wallet)
    if (!tronWeb.isAddress(tokenAddress)) throw new Error('Enter a valid deployed TRӾ token contract address.')
    const token = await tronWeb.contract(TRAX_TOKEN_ARTIFACT.abi).at(tokenAddress)
    const target = holder.trim()
    if(!tronWeb.isAddress(target)) throw new Error('Enter a valid TRON Mainnet recipient / holder address.')
    const [balance,locked]=await Promise.all([token.balanceOf(target).call(),token.isLocked(target).call()])
    setSnapshot(prev=>({...prev,recipient:target,recipientBalance:String(balance),recipientLocked:Boolean(locked)}))
    setNotice('On-chain balance and lock state loaded for '+target+'.')
    return {balance,locked}
  })

  const copy = async value => { try { await navigator.clipboard.writeText(value); setNotice('Copied to clipboard.') } catch { setError('Clipboard access was unavailable.') } }

  return <section className="trax-workspace">
    <div className="section-heading"><div><span className="eyebrow">TRON TRANSFER · OWNER-ONLY · MAINNET</span><h2>TRӾ smart-contract manager</h2><p>Connect any TronLink Mainnet wallet. The wallet that deploys the TRӾ token and reserve vault becomes their owner; later administration is checked against on-chain ownership.</p></div><div className="panel-icon"><Coins/></div></div>
    <div className="trax-notice"><AlertTriangle size={18}/><div><b>TRӾ is a custom TRC-20 asset, not native TRX.</b><p>It is displayed as a separate token. Native TRX reserve, TRӾ supply and internal platform records are separate balances. No market price or Bitpie automatic listing is implied.</p></div></div>
    {!walletReady ? <div className="trax-connect"><p>Connect any TronLink wallet on TRON Mainnet. The wallet that deploys the contracts becomes their owner.</p><button type="button" className="primary-button" onClick={onConnect}><Wallet size={16}/> Connect TronLink wallet</button></div> : <div className="trax-wallet-row"><span>Connected wallet</span><b>{shorten(connectedAddress)}</b><span className={"trax-network"}><CheckCircle2 size={14}/> {"Connected to TRON Mainnet · deployer becomes owner"}</span></div>}
    {error&&<div className="notice notice-error" role="alert"><AlertTriangle size={16}/>{error}</div>}
    {notice&&<div className="notice notice-success" role="status"><CheckCircle2 size={16}/>{notice}</div>}
    {step&&<div className="trax-progress"><RefreshCw size={15}/>{step}</div>}
    <div className="trax-addresses">
      <label>TRӾ token contract address<input value={tokenAddress} onChange={e=>setTokenAddress(e.target.value.trim())} placeholder="Deploy token or paste verified Mainnet contract"/></label>
      <label>Native TRX reserve vault address<input value={vaultAddress} onChange={e=>setVaultAddress(e.target.value.trim())} placeholder="Automatically filled after vault deployment"/></label>
      <div className="button-row"><button type="button" className="outline-button" disabled={busy||(!tokenAddress&&!vaultAddress)} onClick={()=>{setTokenAddress('');setVaultAddress('');setSnapshot(null);setLastTx('');setError('');setNotice('Contract address fields cleared. Deploy or enter verified Mainnet contract addresses.') ;try{saveContractAddresses({tokenAddress:'',vaultAddress:''})}catch{}}}>Clear contract addresses</button></div>
      <div className="button-row"><button type="button" className="primary-button" disabled={!configuredOwnerMatches||busy||Boolean(tokenAddress&&vaultAddress)} onClick={deployMissingContracts}><Rocket size={15}/> {tokenAddress||vaultAddress?'Deploy missing contract':'Deploy both contracts automatically · two TronLink approvals'}</button><button type="button" className="outline-button" disabled={!configuredOwnerMatches||busy||Boolean(vaultAddress)} onClick={deployVault}><Rocket size={15}/> Deploy vault only</button><button type="button" className="outline-button" disabled={!configuredOwnerMatches||busy||Boolean(tokenAddress)||!vaultAddress} onClick={deployToken}><Rocket size={15}/> Deploy token only</button></div>
      <p className="trax-help">The combined action deploys the vault first and the token second. TronLink asks you to review and sign each deployment separately. Confirmed contract addresses are saved automatically; no transaction is sent without your wallet approval.</p>
      <div className="button-row"><button type="button" className="outline-button" disabled={!configuredOwnerMatches||busy||!tokenAddress||!vaultAddress} onClick={authorizeVault}>1. Authorize token in vault</button><button type="button" className="outline-button" disabled={!configuredOwnerMatches||busy||!tokenAddress||!vaultAddress} onClick={linkToken}>2. Link vault in token</button></div>
      <p className="fine-print">Deployments and link operations are irreversible Mainnet transactions. Read every TronLink prompt. The connected wallet that deploys each contract becomes its owner. Each deployment requires a separate TronLink signature. The app verifies the solidified Mainnet receipt and deployed bytecode before saving the contract address.</p>
    </div>

    <div className="trax-actions">
    <div className="trax-actions trax-resource-panel">
      <div className="trax-actions-heading">
        <div><h3>Account signing permission</h3><p className="trax-resource-subtitle">Owner permission threshold for the connected Mainnet wallet</p></div>
        <button type="button" className="secondary-button" disabled={!walletReady||permissionLoading} onClick={refreshWalletPermissions}><ShieldCheck size={15}/> {permissionLoading?'Checking…':'Refresh permission'}</button>
      </div>
      {permissionError&&<div className="notice notice-error"><AlertTriangle size={15}/><div><b>Permission check unavailable</b><p>{permissionError}</p></div></div>}
      {permissionStatus&&<div className="trax-stats">
        <article><span>Owner threshold</span><b>{permissionStatus.threshold}</b></article>
        <article><span>Connected key weight</span><b>{permissionStatus.connectedSignerWeight}</b></article>
        <article><span>Additional weight required</span><b>{permissionStatus.requiredAdditionalWeight}</b></article>
        <article><span>Other owner keys</span><b>{permissionStatus.otherOwnerKeyCount}</b></article>
      </div>}
      {permissionStatus&&<p className="fine-print">{permissionStatus.connectedSignerCanAuthorizeAlone?'The connected wallet key meets the owner threshold alone.':'This account requires additional authorized signer weight. Deployment will stop before requesting a signature.'}</p>}
    </div>

    <div className="trax-actions trax-resource-panel">
      <div className="trax-actions-heading">
        <div><h3>Automatic TRON Energy &amp; Bandwidth check</h3><p className="trax-resource-subtitle">Live Mainnet account resources for the connected wallet</p></div>
        <button type="button" className="secondary-button" disabled={!walletReady||resourceLoading} onClick={refreshWalletResources}><RefreshCw size={15}/> {resourceLoading?'Checking…':'Refresh resources'}</button>
      </div>
      {resourceError&&<div className="notice notice-error"><AlertTriangle size={15}/><div><b>Live resource check unavailable</b><p>{resourceError}</p></div></div>}
      {resourceStatus&&<div className="trax-stats">
        <article><span>Available Energy</span><b>{Number(resourceStatus.energy.available).toLocaleString()}</b></article>
        <article><span>Free Bandwidth available</span><b>{Number(resourceStatus.bandwidth.freeAvailable).toLocaleString()}</b></article>
        <article><span>Staked / delegated Bandwidth</span><b>{Number(resourceStatus.bandwidth.stakedOrDelegatedAvailable).toLocaleString()}</b></article>
        <article><span>Wallet native TRX</span><b>{formatTokenUnits(resourceStatus.balanceSun)} TRX</b></article>
        <article><span>Energy fee parameter</span><b>{resourceStatus.chainParameters.energyFeeSunPerUnit==null?'Unavailable':Number(resourceStatus.chainParameters.energyFeeSunPerUnit).toLocaleString()+' SUN'}</b></article>
        <article><span>Bandwidth fee parameter</span><b>{resourceStatus.chainParameters.bandwidthFeeSunPerByte==null?'Unavailable':Number(resourceStatus.chainParameters.bandwidthFeeSunPerByte).toLocaleString()+' SUN'}</b></article>
      </div>}
      {resourceStatus&&<p className="fine-print">Checked {new Date(resourceStatus.checkedAt).toLocaleString()}. {resourceStatus.estimateNote} Deployment energy is not guessed from transfer estimates.</p>}
      <div className="trax-resource-offer">
        <b>Free-delegation policy · TRON Mainnet</b>
        {freeDelegationError&&<p role="status">Server-side delegation verification unavailable: {freeDelegationError}</p>}
        {freeDelegationStatus&&<p>Verified server-side Mainnet resources: Energy {Number(freeDelegationStatus.resources.energyAvailable).toLocaleString()}, free Bandwidth {Number(freeDelegationStatus.resources.freeBandwidthAvailable).toLocaleString()}, staked/delegated Bandwidth {Number(freeDelegationStatus.resources.stakedOrDelegatedBandwidthAvailable).toLocaleString()}. Incoming Stake 2.0 delegations: {freeDelegationStatus.inboundDelegations.count}. {freeDelegationStatus.inboundDelegations.count ? 'Incoming delegation records are observed in the Mainnet FullNode state.' : 'No incoming Energy/Bandwidth delegation was detected.'} Protocol free Energy quota: 0. No sponsor, paid rental, paid fallback, or automatic delegation is enabled.</p>}
        <p>Only real incoming on-chain delegation can add Energy without TRX burn. If Energy is unavailable, deployment stops before requesting TronLink approval. Any on-chain transaction still requires your explicit wallet approval.</p>
      </div>
      <div className="trax-resource-offer">
        <b>Free public Energy provider · TEnergy Mainnet promotion</b>
        <p>The backend checks TEnergy's live Mainnet promotion and eligibility. If this wallet was pre-marked eligible and the promotion is active, you can request its one-time Energy grant. TronLink will ask you to sign the provider's exact human-readable message; this is not a blockchain transaction, transfers no TRX, and grants no token approval. The provider controls eligibility, daily limits and actual delegation.</p>
        {tenergyPromo?.terms&&<p>Promotion: {tenergyPromo.terms.state}. {tenergyPromo.terms.grant ? 'Advertised grant: '+Number(tenergyPromo.terms.grant.amount).toLocaleString()+' Energy for '+Math.round(Number(tenergyPromo.terms.grant.duration_seconds)/60)+' minutes.' : 'No grant details are currently published.'} Remaining today: {tenergyPromo.terms.left_today ?? '—'}.</p>}
        {tenergyPromo?.redemption&&<p>Wallet claim: {tenergyPromo.redemption.status} · {Number(tenergyPromo.redemption.energy || 0).toLocaleString()} Energy · method: {tenergyPromo.redemption.method}.</p>}
        {tenergyMessage&&<p role="status">{tenergyMessage}</p>}
        <div className="button-row">
          <button type="button" className="secondary-button" disabled={!walletReady||connectedAddress!==FREE_DELEGATION_OWNER||tenergyBusy||busy} onClick={refreshTenergyPromo}>Refresh free-promo eligibility</button>
          <button type="button" className="primary-button" disabled={!walletReady||connectedAddress!==FREE_DELEGATION_OWNER||busy||tenergyBusy||tenergyPromo?.terms?.state!=='active'||!Number(tenergyPromo?.terms?.left_today)||Boolean(tenergyPromo?.redemption)} onClick={claimTenergyPromo}>Claim free Energy · sign message in TronLink</button>
          <button type="button" className="outline-button" disabled={!walletReady||connectedAddress!==FREE_DELEGATION_OWNER||tenergyBusy||!tenergyPromo?.redemption} onClick={checkTenergyRedemption}>Check delegation status</button>
        </div>
        <p className="fine-print">No paid order, provider account balance, TRX transfer, sponsor billing, or TRX-burn fallback is used. Energy is not added to the deployment budget until the Mainnet resource reader confirms it.</p>
        <b>Free Bandwidth provider status</b>
        <p>No external public provider with a verified free Bandwidth-delegation API was found. The app continues to use only the wallet's actual protocol free Bandwidth and verified incoming on-chain delegation.</p>
      </div>
      <p className="fine-print">No sponsor, paid rental, or automatic delegation is enabled. Deployment and contract calls require a zero native TRX balance plus sufficient real Energy and one complete Bandwidth quota, so TRX-burn fallback cannot be used. Your TronLink wallet must separately approve each transaction. Free Bandwidth is a protocol allowance; TRON has no equivalent protocol-level free Energy quota.</p>
    </div>

      <div className="trax-actions-heading"><h3>On-chain verification</h3><button type="button" className="secondary-button" disabled={!walletReady||busy||!tokenAddress||!vaultAddress} onClick={refresh}><RefreshCw size={15}/> Refresh</button></div>
      {snapshot&&<div className="trax-stats">
        <article><span>Native TRX in vault</span><b>{formatTokenUnits(snapshot.reserveSun)} TRX</b></article>
        <article><span>Outstanding TRӾ</span><b>{formatTokenUnits(snapshot.totalSupply)} TRӾ</b></article>
        <article><span>Reserve coverage</span><b>{snapshot.backed?'Backed':'SHORTFALL'}</b></article>
        <article><span>Minting</span><b>{snapshot.mintingEnabled?'Enabled':'Disabled'}</b></article>
        <article><span>Contract pause</span><b>{snapshot.paused?'Paused':'Unpaused'}</b></article>
        <article><span>Owner TRX for fees</span><b>{formatTokenUnits(snapshot.ownerTrxSun)} TRX</b></article>
        <article><span>Token owner</span><b>{addressesEqual(wallet.tronWeb,snapshot.owner,connectedAddress)?'Connected owner':'Different owner'}</b></article>
        <article><span>Vault owner</span><b>{addressesEqual(wallet.tronWeb,snapshot.vaultOwner,connectedAddress)?'Connected owner':'Different owner'}</b></article>
      </div>}
      {snapshot&&<div className="trax-checks">
        <span className={snapshot.metadataValid?'ok':'bad'}>{snapshot.metadataValid?'✓':'!'} Exact TRӾ / TRX / 6 decimals</span>
        <span className={snapshot.linksValid?'ok':'bad'}>{snapshot.linksValid?'✓':'!'} Reciprocal vault authorization</span>
        <span className={snapshot.backed?'ok':'bad'}>{snapshot.backed?'✓':'!'} Reserve covers total supply</span>
      </div>}
    </div>

    <div className="trax-actions">
      <h3>Deploy and configure in sequence</h3>
      <ol className="trax-steps">
        <li>Deploy the vault and TRӾ contract from the intended owner wallet.</li>
        <li>Authorize the token in the vault and link the vault in the token contract.</li>
        <li>Fund the vault with native TRX and refresh the actual on-chain reserve.</li>
        <li>Review the on-chain owner, metadata, vault link and backing; then activate minting.</li>
      </ol>
      <label>Deployment / contract-call maximum fee cap (TRX)<input type="number" min="1" max="500" step="1" value={feeCap} onChange={e=>setFeeCap(e.target.value)}/></label>
    </div>

    <div className="trax-actions">
      <h3>Fund the native TRX reserve</h3>
      <label>TRX amount<input value={fundAmount} onChange={e=>setFundAmount(e.target.value)} inputMode="decimal"/></label>
      <button type="button" className="primary-button" disabled={!configuredOwnerMatches||busy||!snapshot?.linksValid} onClick={fundVault}><Wallet size={15}/> Fund reserve from connected wallet</button>
      <p className="fine-print">This sends actual native TRX from the connected owner wallet to the vault. It is not a token mint. Verify the destination address in TronLink before signing.</p>
    </div>

    <div className="trax-actions">
      <h3>Activate or stop issuance</h3>
      <div className="button-row"><button type="button" className="primary-button" disabled={!configuredOwnerMatches||busy||!snapshot?.linksValid||!snapshot?.backed||snapshot?.mintingEnabled} onClick={activate}><ShieldCheck size={15}/> {snapshot?.paused?'Unpause and enable minting':'Enable minting'}</button><button type="button" className="outline-button" disabled={!configuredOwnerMatches||busy||!tokenAddress||!snapshot?.mintingEnabled} onClick={disableMinting}>Disable minting</button><button type="button" className="outline-button" disabled={!configuredOwnerMatches||busy||!tokenAddress||snapshot?.paused} onClick={()=>setPauseState(true)}>Emergency pause</button><button type="button" className="outline-button" disabled={!configuredOwnerMatches||busy||!tokenAddress||!snapshot?.paused} onClick={()=>setPauseState(false)}>Unpause contract</button></div>
      <p className="fine-print">Activation is two separate owner-signed transactions. It verifies exact metadata, owner, reciprocal vault links and that reserve TRX covers all existing TRӾ supply. Minting can be disabled and the token paused independently.</p>
    </div>

    <div className="trax-actions">
      <h3>Issue restricted TRӾ</h3>
      <label>Recipient TRON address<input value={recipient} onChange={e=>setRecipient(e.target.value)} autoComplete="off" spellCheck="false"/></label>
      <label>Amount (TRӾ)<input value={amount} onChange={e=>setAmount(e.target.value)} inputMode="decimal"/></label>
      <div className="trax-balance-note">Raw token units: {(()=>{try{return parseTokenUnits(amount)}catch{return '—'}})()}</div>
      <button type="button" className="primary-button" disabled={!configuredOwnerMatches||busy||!snapshot?.linksValid||!snapshot?.mintingEnabled||snapshot?.paused} onClick={issue}><LockKeyhole size={15}/> Review and mint TRӾ</button>
      <p className="fine-print">Every newly minted recipient must already be locked. The owner wallet must sign the mint, and the contract independently enforces the lock and reserve requirements.</p>
    </div>

    <div className="trax-actions">
      <h3>Recipient lock controls and balances</h3>
      <label>Recipient / holder address<input value={holder} onChange={e=>setHolder(e.target.value)} autoComplete="off" spellCheck="false"/></label>
      <button type="button" className="secondary-button" disabled={!walletReady||busy||!tokenAddress} onClick={readRecipient}>Read recipient balance and lock state</button>
      {snapshot?.recipient&&<div className="trax-recipient-result"><b>{formatTokenUnits(snapshot.recipientBalance)} TRӾ</b><span>{snapshot.recipient}</span><span>{snapshot.recipientLocked?'LOCKED':'UNLOCKED'}</span></div>}
      <div className="button-row"><button type="button" className="outline-button" disabled={!configuredOwnerMatches||busy||!tokenAddress} onClick={()=>setLock(true)}><LockKeyhole size={15}/> Lock recipient</button><button type="button" className="outline-button" disabled={!configuredOwnerMatches||busy||!tokenAddress} onClick={()=>setLock(false)}><Unlock size={15}/> Unlock recipient</button></div>
      <p className="fine-print">All accounts start locked. Unlocking is an explicit owner-only on-chain change. Locked balances remain visible through balanceOf but cannot transfer or approve spending.</p>
    </div>

    <div className="trax-actions">
      <h3>Owner-controlled redemption</h3>
      <label>Holder address<input value={holder} onChange={e=>setHolder(e.target.value)} autoComplete="off" spellCheck="false"/></label>
      <label>Native TRX payout recipient<input value={redeemRecipient} onChange={e=>setRedeemRecipient(e.target.value)} autoComplete="off" spellCheck="false"/></label>
      <label>Amount (TRӾ / TRX)<input value={redeemAmount} onChange={e=>setRedeemAmount(e.target.value)} inputMode="decimal"/></label>
      <button type="button" className="outline-button" disabled={!configuredOwnerMatches||busy||!snapshot?.linksValid||snapshot?.paused} onClick={redeem}><Wallet size={15}/> Review owner redemption</button>
      <p className="fine-print">Redemption burns TRӾ and releases the same amount of native TRX atomically. The holder cannot initiate redemption; the connected contract owner signs it.</p>
    </div>

    {lastTx&&<div className="notice notice-success"><CheckCircle2 size={16}/><div><b>Solidified Mainnet transaction verified</b><p>{lastTx}</p><a href={'https://tronscan.org/#/transaction/'+lastTx} target="_blank" rel="noreferrer">Open transaction on TRONSCAN <ExternalLink size={12}/></a></div></div>}
    <div className="trax-footer-links"><a href="https://developers.tron.network/docs/trc20-protocol-interface" target="_blank" rel="noreferrer">TRON TRC-20 standard <ExternalLink size={12}/></a><a href="https://tronscan.org/#/token20" target="_blank" rel="noreferrer">TRONSCAN token directory <ExternalLink size={12}/></a></div>
  </section>
}
