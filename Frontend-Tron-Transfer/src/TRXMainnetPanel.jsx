import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Coins, ExternalLink, LockKeyhole, RefreshCw, Rocket, ShieldCheck, Unlock, Wallet } from 'lucide-react'
import './trax-mainnet.css'
import {
  TRON_MAINNET_HOST, TRAX_TOKEN_ARTIFACT, TRAX_VAULT_ARTIFACT,
  addressesEqual, assertMainnetWallet, deployContractFromTronLink,
  formatTokenUnits, loadSavedContracts, parseTokenUnits, saveContractAddresses,
  getMainnetAccountPermissionSnapshot, getMainnetAccountResourceSnapshot, sendAndVerifyContractCall, sendNativeTrxFromTronLink,
} from './trax-mainnet.mjs'

const ZERO = '0x0000000000000000000000000000000000000000'
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/
const DEFAULT_RECIPIENT = 'TKmwZgALZPatKVJpcAx93XVNu6DiaauPFk'
const DEFAULT_FEE_CAP = '300'

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
  const [resourceSnapshot,setResourceSnapshot] = useState(null)
  const [permissionSnapshot,setPermissionSnapshot] = useState(null)
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
  useEffect(() => { setResourceSnapshot(null); setPermissionSnapshot(null) }, [connectedAddress])
  // Any valid Mainnet TronLink account may connect. On-chain owner() checks below
  // decide which wallet may administer already-deployed contracts.
  const checkAccountPermissions = () => run('Reading connected account owner permission', async () => {
    const tronWeb = assertMainnetWallet(wallet)
    const permissions = await getMainnetAccountPermissionSnapshot(tronWeb, connectedAddress)
    setPermissionSnapshot({ address: connectedAddress, ...permissions })
    setNotice(permissions.connectedSignerCanAuthorizeAlone
      ? 'The connected wallet key alone meets the owner permission threshold.'
      : 'The owner permission requires additional signing weight. A single TronLink signature may not authorize deployment.')
    return permissions
  })

  const checkDeploymentResources = () => run('Reading live TRON Mainnet account resources', async () => {
    const tronWeb = assertMainnetWallet(wallet)
    const resources = await getMainnetAccountResourceSnapshot(tronWeb, connectedAddress)
    setResourceSnapshot({ address: connectedAddress, ...resources })
    setNotice('Current Mainnet resource usage loaded. This is a read-only snapshot, not a deployment Energy estimate or guarantee.')
    return resources
  })

  const feeCapSun = useMemo(() => {
    try { return toSun(feeCap) } catch { return 0 }
  }, [feeCap])

  const assertOwner = useCallback(async (token, tronWeb) => {
    const owner = await token.owner().call()
    // The contract's owner() value is authoritative; platform login identity is not.
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
    if (!ownerMatches || !vaultOwnerMatches) throw new Error('The connected wallet must be the on-chain owner of both the TRӾ token and reserve vault.')
    if (!linksValid) throw new Error('The token and reserve vault are not linked to each other correctly.')
    setNotice('Mainnet contracts read successfully. Metadata and reciprocal reserve authorization are verified at the latest node state.')
    return next
  }), [run,getContracts,connectedAddress,vaultAddress])

  // Re-check saved contracts automatically when the connected wallet reconnects.
  // This is read-only: it never deploys, links, funds, mints, or signs transactions.
  useEffect(() => {
    if (!walletReady || !tokenAddress || !vaultAddress) return
    if (!wallet.tronWeb.isAddress(tokenAddress) || !wallet.tronWeb.isAddress(vaultAddress)) {
      setSnapshot(null)
      setError('Saved contract address is invalid. Clear the address fields and recover the verified Mainnet contract addresses.')
      return
    }
    refresh()
  }, [walletReady, tokenAddress, vaultAddress, wallet, refresh])

  const prepareUnsignedDeployment = async (artifact, contractName) => {
    try {
      return { deployed: await deployContractFromTronLink(wallet,artifact,contractName,feeCapSun) }
    } catch (error) {
      // The existing safety hold is an expected diagnostic result, not a failed
      // wallet action: it proves the unsigned payload was built and validated.
      if (error instanceof Error && error.message.startsWith('Deployment safety hold:')) {
        return { prepared: true }
      }
      throw error
    }
  }

  const deployMissingContracts = () => run('Preparing unsigned TRӾ deployment payloads · broadcast disabled', async () => {
    if (!walletReady) throw new Error('Connect a TronLink wallet on TRON Mainnet first.')
    if (tokenAddress && !wallet.tronWeb.isAddress(tokenAddress)) throw new Error('The saved TRӾ token address is invalid. Clear it and retry.')
    if (vaultAddress && !wallet.tronWeb.isAddress(vaultAddress)) throw new Error('The saved reserve-vault address is invalid. Clear it and retry.')
    if (tokenAddress && addressesEqual(wallet.tronWeb,tokenAddress,connectedAddress)) {
      throw new Error('The TRӾ token field contains your connected wallet address, not a smart-contract address. Clear that field so the TRӾ token contract can be deployed.')
    }
    if (vaultAddress && addressesEqual(wallet.tronWeb,vaultAddress,connectedAddress)) {
      throw new Error('The reserve-vault field contains your owner wallet address, not a smart-contract address. Clear that field so the reserve vault can be deployed.')
    }
    for (const [label,address] of [['TRӾ token',tokenAddress],['reserve vault',vaultAddress]]) {
      if (!address) continue
      const deployedContract = await wallet.tronWeb.trx.getContract(address)
      if (!deployedContract?.bytecode) throw new Error('The saved '+label+' address has no verified deployed contract bytecode. Clear it and deploy the contract; do not use a wallet address here.')
    }
    // If only one contract already exists, only its actual owner may prepare
    // the matching second deployment; this prevents split-owner token/vault pairs.
    if (tokenAddress && !vaultAddress) {
      const existingToken = await wallet.tronWeb.contract(TRAX_TOKEN_ARTIFACT.abi).at(tokenAddress)
      if (!addressesEqual(wallet.tronWeb, await existingToken.owner().call(), connectedAddress)) {
        throw new Error('The existing TRӾ token belongs to a different wallet. Reconnect that token owner before preparing its reserve vault.')
      }
    }
    if (vaultAddress && !tokenAddress) {
      const existingVault = await wallet.tronWeb.contract(TRAX_VAULT_ARTIFACT.abi).at(vaultAddress)
      if (!addressesEqual(wallet.tronWeb, await existingVault.owner().call(), connectedAddress)) {
        throw new Error('The existing reserve vault belongs to a different wallet. Reconnect that vault owner before preparing its TRӾ token.')
      }
    }
    const deployed = []
    const prepared = []
    if (!vaultAddress) {
      const result = await prepareUnsignedDeployment(TRAX_VAULT_ARTIFACT,'OneTraxReserveVault')
      if (result.prepared) prepared.push('reserve vault')
      else { setVaultAddress(result.deployed.address); setLastTx(result.deployed.txID); deployed.push('reserve vault') }
    }
    if (!tokenAddress) {
      const result = await prepareUnsignedDeployment(TRAX_TOKEN_ARTIFACT,'Restricted1TRAX')
      if (result.prepared) prepared.push('TRӾ token')
      else { setTokenAddress(result.deployed.address); setLastTx(result.deployed.txID); deployed.push('TRӾ token') }
    }
    if (prepared.length) {
      setNotice('Unsigned Mainnet deployment payloads were built and validated for '+prepared.join(' and ')+'. No signing or broadcast occurred. These diagnostic payloads are not saved or reusable; prepare fresh payloads after separate deployment approval.')
      return
    }
    setNotice(deployed.length
      ? 'Deployment complete and solidified: '+deployed.join(' and ')+'. Both contract addresses have been saved automatically. Continue with the two reciprocal authorization steps.'
      : 'Both contract addresses are already present. Continue with reciprocal authorization.')
  })

  const deployVault = () => run('Preparing unsigned reserve-vault deployment · broadcast disabled', async () => {
    if (!walletReady) throw new Error('Connect a TronLink wallet on TRON Mainnet first.')
    if (tokenAddress) {
      const existingToken = await wallet.tronWeb.contract(TRAX_TOKEN_ARTIFACT.abi).at(tokenAddress)
      if (!addressesEqual(wallet.tronWeb, await existingToken.owner().call(), connectedAddress)) {
        throw new Error('The existing TRӾ token belongs to a different wallet. Reconnect that token owner before preparing its reserve vault.')
      }
    }
    const result = await prepareUnsignedDeployment(TRAX_VAULT_ARTIFACT,'OneTraxReserveVault')
    if (result.prepared) {
      setNotice('Unsigned reserve-vault deployment payload built and validated. No signing or broadcast occurred. Prepare a fresh payload after separate deployment approval.')
      return
    }
    setVaultAddress(result.deployed.address); setLastTx(result.deployed.txID)
    setNotice('Reserve vault deployed and solidified. Continue by deploying the TRӾ token.')
  })

  const deployToken = () => run('Preparing unsigned TRӾ token deployment · broadcast disabled', async () => {
    if (!walletReady) throw new Error('Connect a TronLink wallet on TRON Mainnet first.')
    if (vaultAddress) {
      const existingVault = await wallet.tronWeb.contract(TRAX_VAULT_ARTIFACT.abi).at(vaultAddress)
      if (!addressesEqual(wallet.tronWeb, await existingVault.owner().call(), connectedAddress)) {
        throw new Error('The existing reserve vault belongs to a different wallet. Reconnect that vault owner before preparing its TRӾ token.')
      }
    }
    const result = await prepareUnsignedDeployment(TRAX_TOKEN_ARTIFACT,'Restricted1TRAX')
    if (result.prepared) {
      setNotice('Unsigned TRӾ token deployment payload built and validated. No signing or broadcast occurred. Prepare a fresh payload after separate deployment approval.')
      return
    }
    setTokenAddress(result.deployed.address); setLastTx(result.deployed.txID)
    setNotice('TRӾ token deployed and solidified. Next authorize the token in the vault.')
  })

  const authorizeVault = () => run('Authorizing TRӾ in reserve vault · approve in TronLink', async () => {
    if (!walletReady) throw new Error('Connect a TronLink wallet on TRON Mainnet first.')
    const {tronWeb,token,vault} = await getContracts()
    await assertOwner(token,tronWeb)
    if (!addressesEqual(tronWeb,await vault.owner().call(),connectedAddress)) throw new Error('Connected TronLink wallet is not the reserve-vault owner.')
    const abiMethod = vault.setAuthorizedToken(tokenAddress)
    const result = await sendAndVerifyContractCall(tronWeb,abiMethod,feeCapSun)
    setLastTx(result.txID); setNotice('Vault authorization is confirmed. Next link the vault in the TRӾ token contract.')
  })

  const linkToken = () => run('Linking reserve vault in TRӾ token · approve in TronLink', async () => {
    if (!walletReady) throw new Error('Connect a TronLink wallet on TRON Mainnet first.')
    const {tronWeb,token,vault} = await getContracts()
    await assertOwner(token,tronWeb)
    if (!addressesEqual(tronWeb,await vault.authorizedToken().call(),tokenAddress)) throw new Error('Authorize this TRӾ token in the vault first.')
    const result = await sendAndVerifyContractCall(tronWeb,token.setReserveVault(vaultAddress),feeCapSun)
    setLastTx(result.txID); setNotice('Token-to-vault link is confirmed. Refresh the on-chain status before funding or enabling minting.')
  })

  const fundVault = () => run('Funding native TRX reserve · approve in TronLink', async () => {
    if (!walletReady) throw new Error('Connect a TronLink wallet on TRON Mainnet first.')
    const {tronWeb,vault} = await getContracts()
    await assertOwner(await tronWeb.contract(TRAX_TOKEN_ARTIFACT.abi).at(tokenAddress),tronWeb)
    const [vaultOwner,authorizedToken, linkedVault] = await Promise.all([vault.owner().call(),vault.authorizedToken().call(),(await tronWeb.contract(TRAX_TOKEN_ARTIFACT.abi).at(tokenAddress)).reserveVault().call()])
    if (!addressesEqual(tronWeb,vaultOwner,connectedAddress)) throw new Error('Connected TronLink wallet is not the reserve-vault owner.')
    if (!addressesEqual(tronWeb,authorizedToken,tokenAddress)||!addressesEqual(tronWeb,linkedVault,vaultAddress)) throw new Error('Complete and verify both one-time vault links before funding.')
    const result = await sendNativeTrxFromTronLink(wallet,vaultAddress,toSun(fundAmount))
    setLastTx(result.txID); setNotice('Native TRX reserve deposit is solidified. Refresh to verify the actual vault balance.')
  })

  const activate = () => run('TRӾ minting activation disabled', async () => {
    throw new Error('Minting activation is disabled in this build. No transaction was sent.')
  })

  const issue = () => run('TRӾ minting disabled', async () => {
    throw new Error('TRӾ minting is disabled in this build. No mint transaction was sent.')
  })

  const setLock = (locked) => run((locked?'Locking':'Unlocking')+' recipient · approve in TronLink', async () => {
    if (!walletReady) throw new Error('Connect a TronLink wallet on TRON Mainnet first.')
    const tronWeb = assertMainnetWallet(wallet)
    if (!tronWeb.isAddress(tokenAddress)) throw new Error('Enter a valid deployed TRӾ token contract address.')
    const token = await tronWeb.contract(TRAX_TOKEN_ARTIFACT.abi).at(tokenAddress)
    await assertOwner(token,tronWeb)
    const target = holder.trim()
    if(!tronWeb.isAddress(target)) throw new Error('Enter a valid recipient address.')
    const result=await sendAndVerifyContractCall(tronWeb,token.setRecipientLocked(target,locked),feeCapSun)
    setLastTx(result.txID); setNotice('Recipient '+target+' is now '+(locked?'LOCKED':'UNLOCKED')+' on-chain.')
    await refresh()
  })

  const redeem = () => run('Redeeming TRӾ and releasing native TRX · approve in TronLink', async () => {
    if (!walletReady) throw new Error('Connect a TronLink wallet on TRON Mainnet first.')
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
    const result=await sendAndVerifyContractCall(tronWeb,token.redeemForOwner(holder,redeemRecipient,units,reference),feeCapSun)
    setLastTx(result.txID); setNotice('Owner redemption confirmed. The holder balance was burned and native TRX was released atomically.')
    await refresh()
  })

  const setPauseState = (pause) => run((pause?'Pausing':'Unpausing')+' TRӾ · approve in TronLink', async () => {
    const {tronWeb,token} = await getContracts()
    await assertOwner(token,tronWeb)
    const result=await sendAndVerifyContractCall(tronWeb,token.setPaused(pause),feeCapSun)
    setLastTx(result.txID); setNotice(pause?'TRӾ is paused. Transfers, approvals, minting and redemption are blocked.':'TRӾ is unpaused. Minting still depends on the separate minting-enabled flag.')
    await refresh()
  })

  const disableMinting = () => run('Disabling TRӾ minting · approve in TronLink', async () => {
    const {tronWeb,token} = await getContracts()
    await assertOwner(token,tronWeb)
    const result=await sendAndVerifyContractCall(tronWeb,token.setMintingEnabled(false),feeCapSun)
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
    <div className="section-heading"><div><span className="eyebrow">TRON TRANSFER · TRӾ SMART CONTRACTS · MAINNET</span><h2>TRӾ smart-contract manager</h2><p>Connect any TronLink Mainnet wallet. The wallet that signs a deployment becomes the owner of the new token and reserve vault. Existing contracts remain controlled only by their on-chain owner.</p></div><div className="panel-icon"><Coins/></div></div>
    <div className="trax-notice"><AlertTriangle size={18}/><div><b>TRӾ is a custom TRC-20 asset, not native TRX.</b><p>It is displayed as a separate token. Native TRX reserve, TRӾ supply and internal platform records are separate balances. No market price or Bitpie automatic listing is implied.</p></div></div>
    {!walletReady ? <div className="trax-connect"><p>Connect any TronLink wallet on TRON Mainnet. You do not need the private platform-owner login for this deployment workspace.</p><button type="button" className="primary-button" onClick={onConnect}><Wallet size={16}/> Connect TronLink wallet</button></div> : <div className="trax-wallet-row"><span>Connected wallet · deployment owner</span><b>{shorten(connectedAddress)}</b><span className="trax-network"><CheckCircle2 size={14}/> Mainnet wallet connected</span></div>}
    {error&&<div className="notice notice-error" role="alert"><AlertTriangle size={16}/>{error}</div>}
    {notice&&<div className="notice notice-success" role="status"><CheckCircle2 size={16}/>{notice}</div>}
    {step&&<div className="trax-progress"><RefreshCw size={15}/>{step}</div>}
    <div className="trax-actions">
      <div className="trax-actions-heading"><h3>Account permission preflight</h3><button type="button" className="secondary-button" disabled={!walletReady||busy} onClick={checkAccountPermissions}><ShieldCheck size={15}/> Check signing threshold</button></div>
      {permissionSnapshot&&<div className="trax-stats">
        <article><span>Owner permission threshold</span><b>{permissionSnapshot.threshold}</b></article>
        <article><span>Connected wallet key weight</span><b>{permissionSnapshot.connectedSignerWeight}</b></article>
        <article><span>Additional weight needed</span><b>{permissionSnapshot.requiredAdditionalWeight}</b></article>
        <article><span>Other owner keys configured</span><b>{permissionSnapshot.otherOwnerKeyCount}</b></article>
      </div>}
      {permissionSnapshot&&<div className={permissionSnapshot.connectedSignerCanAuthorizeAlone?'trax-checks':'trax-checks'}>
        <span className={permissionSnapshot.connectedSignerCanAuthorizeAlone?'ok':'bad'}>{permissionSnapshot.connectedSignerCanAuthorizeAlone?'✓':'!'} {permissionSnapshot.connectedSignerCanAuthorizeAlone?'Connected key meets owner threshold':'Additional authorized signer weight required'}</span>
      </div>}
      <p className="fine-print">Deployment transactions use owner permission ID 0 unless explicitly constructed otherwise. This preflight reads the owner permission's threshold and the connected wallet's key weight; it does not alter permissions, add signers, or guarantee TronLink will authorize a transaction.</p>
    </div>
    <div className="trax-actions">
      <div className="trax-actions-heading"><h3>Wallet resource preflight</h3><button type="button" className="secondary-button" disabled={!walletReady||busy} onClick={checkDeploymentResources}><RefreshCw size={15}/> Check Energy, Bandwidth and TRX</button></div>
      {resourceSnapshot&&<div className="trax-stats">
        <article><span>Remaining Energy</span><b>{Number(resourceSnapshot.energyAvailable).toLocaleString()}</b></article>
        <article><span>Free Bandwidth</span><b>{Number(resourceSnapshot.freeBandwidthAvailable).toLocaleString()}</b></article>
        <article><span>Staked / delegated Bandwidth</span><b>{Number(resourceSnapshot.stakedBandwidthAvailable).toLocaleString()}</b></article>
        <article><span>Native TRX for fees</span><b>{formatTokenUnits(resourceSnapshot.nativeBalanceSun)} TRX</b></article>
        <article><span>Current Energy fee</span><b>{Number(resourceSnapshot.energyFeeSun).toLocaleString()} SUN / Energy</b></article>
        {resourceSnapshot.bandwidthFeeSun!==null&&<article><span>Current Bandwidth fee</span><b>{Number(resourceSnapshot.bandwidthFeeSun).toLocaleString()} SUN / Bandwidth</b></article>}
        {resourceSnapshot.maxFeeLimitSun!==null&&<article><span>Protocol maximum fee cap</span><b>{formatTokenUnits(resourceSnapshot.maxFeeLimitSun)} TRX</b></article>}
      </div>}
      <p className="fine-print">These are the connected wallet’s live resource limits and usage. They do not estimate this contract’s deployment Energy. Deployment remains on safety hold; a fee cap does not create Energy, Bandwidth or TRX, and insufficient resources can still make a transaction fail.</p>
    </div>
    <div className="trax-addresses">
      <label>TRӾ token contract address<input value={tokenAddress} onChange={e=>setTokenAddress(e.target.value.trim())} placeholder="Deploy token or paste verified Mainnet contract"/></label>
      <label>Native TRX reserve vault address<input value={vaultAddress} onChange={e=>setVaultAddress(e.target.value.trim())} placeholder="Automatically filled after vault deployment"/></label>
      <div className="button-row"><button type="button" className="outline-button" disabled={busy||(!tokenAddress&&!vaultAddress)} onClick={()=>{setTokenAddress('');setVaultAddress('');setSnapshot(null);setLastTx('');setError('');setNotice('Contract address fields cleared. Deploy or enter verified Mainnet contract addresses.') ;try{saveContractAddresses({tokenAddress:'',vaultAddress:''})}catch{}}}>Clear contract addresses</button></div>
      <div className="button-row"><button type="button" className="primary-button" disabled={!walletReady||busy||Boolean(tokenAddress&&vaultAddress)} onClick={deployMissingContracts}><Rocket size={15}/> {tokenAddress||vaultAddress?'Prepare missing deployment':'Prepare both deployments'}</button><button type="button" className="outline-button" disabled={!walletReady||busy||Boolean(vaultAddress)} onClick={deployVault}><Rocket size={15}/> Prepare vault deployment</button><button type="button" className="outline-button" disabled={!walletReady||busy||Boolean(tokenAddress)||!vaultAddress} onClick={deployToken}><Rocket size={15}/> Prepare token deployment</button></div>
      <p className="trax-help">Deployment preparation is currently non-broadcasting: the app builds and validates the unsigned Mainnet payload, then stops before wallet signing. No contract is created and no address is saved until a separately approved deployment is enabled.</p>
      <div className="button-row"><button type="button" className="outline-button" disabled={!walletReady||busy||!tokenAddress||!vaultAddress} onClick={authorizeVault}>1. Authorize token in vault</button><button type="button" className="outline-button" disabled={!walletReady||busy||!tokenAddress||!vaultAddress} onClick={linkToken}>2. Link vault in token</button></div>
      <p className="fine-print">Deployments and link operations are irreversible Mainnet transactions. Read every TronLink prompt. The connected signing wallet becomes the vault owner and initial token owner. Confirm the selected TronLink account before deployment.</p>
    </div>

    <div className="trax-actions">
      <div className="trax-actions-heading"><h3>On-chain verification</h3><button type="button" className="secondary-button" disabled={!walletReady||busy||!tokenAddress||!vaultAddress} onClick={refresh}><RefreshCw size={15}/> Refresh</button></div>
      {snapshot&&<div className="trax-stats">
        <article><span>Native TRX in vault</span><b>{formatTokenUnits(snapshot.reserveSun)} TRX</b></article>
        <article><span>Outstanding TRӾ</span><b>{formatTokenUnits(snapshot.totalSupply)} TRӾ</b></article>
        <article><span>Reserve coverage</span><b>{snapshot.backed?'Backed':'SHORTFALL'}</b></article>
        <article><span>Minting</span><b>{snapshot.mintingEnabled?'Enabled':'Disabled'}</b></article>
        <article><span>Contract pause</span><b>{snapshot.paused?'Paused':'Unpaused'}</b></article>
        <article><span>Connected wallet TRX for fees</span><b>{formatTokenUnits(snapshot.ownerTrxSun)} TRX</b></article>
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
        <li>Deploy the vault and TRӾ contract from the connected wallet; that wallet becomes both contracts’ owner.</li>
        <li>Authorize the token in the vault and link the vault in the token contract.</li>
        <li>Fund the vault with native TRX and refresh the actual on-chain reserve.</li>
        <li>Review the on-chain owner, metadata, vault link and backing; then activate minting.</li>
      </ol>
      <label>Deployment / contract-call maximum fee cap (TRX)<input type="number" min="1" max="500" step="1" value={feeCap} onChange={e=>setFeeCap(e.target.value)}/></label>
    </div>

    <div className="trax-actions">
      <h3>Fund the native TRX reserve</h3>
      <label>TRX amount<input value={fundAmount} onChange={e=>setFundAmount(e.target.value)} inputMode="decimal"/></label>
      <button type="button" className="primary-button" disabled={!walletReady||busy||!snapshot?.linksValid} onClick={fundVault}><Wallet size={15}/> Fund reserve from connected wallet</button>
      <p className="fine-print">This sends actual native TRX from the connected owner wallet to the vault. It is not a token mint. Verify the destination address in TronLink before signing.</p>
    </div>

    <div className="trax-actions">
      <h3>Activate or stop issuance</h3>
      <div className="button-row"><button type="button" className="primary-button" disabled title="Minting activation is disabled in this build." onClick={activate}><ShieldCheck size={15}/> Minting activation disabled</button><button type="button" className="outline-button" disabled={!walletReady||busy||!tokenAddress||!snapshot?.mintingEnabled} onClick={disableMinting}>Disable minting</button><button type="button" className="outline-button" disabled={!walletReady||busy||!tokenAddress||snapshot?.paused} onClick={()=>setPauseState(true)}>Emergency pause</button><button type="button" className="outline-button" disabled={!walletReady||busy||!tokenAddress||!snapshot?.paused} onClick={()=>setPauseState(false)}>Unpause contract</button></div>
      <p className="fine-print">Minting remains disabled in this build. The contract is deployed paused with minting disabled; activation and mint actions are unavailable pending separate explicit approval.</p>
    </div>

    <div className="trax-actions">
      <h3>Issue restricted TRӾ</h3>
      <label>Recipient TRON address<input value={recipient} onChange={e=>setRecipient(e.target.value)} autoComplete="off" spellCheck="false"/></label>
      <label>Amount (TRӾ)<input value={amount} onChange={e=>setAmount(e.target.value)} inputMode="decimal"/></label>
      <div className="trax-balance-note">Raw token units: {(()=>{try{return parseTokenUnits(amount)}catch{return '—'}})()}</div>
      <button type="button" className="primary-button" disabled title="Minting is disabled in this build." onClick={issue}><LockKeyhole size={15}/> Minting disabled</button>
      <p className="fine-print">No mint transaction can be sent from this workspace. Existing minting state is displayed read-only; an owner can use Disable minting as a protective action if needed.</p>
    </div>

    <div className="trax-actions">
      <h3>Recipient lock controls and balances</h3>
      <label>Recipient / holder address<input value={holder} onChange={e=>setHolder(e.target.value)} autoComplete="off" spellCheck="false"/></label>
      <button type="button" className="secondary-button" disabled={!walletReady||busy||!tokenAddress} onClick={readRecipient}>Read recipient balance and lock state</button>
      {snapshot?.recipient&&<div className="trax-recipient-result"><b>{formatTokenUnits(snapshot.recipientBalance)} TRӾ</b><span>{snapshot.recipient}</span><span>{snapshot.recipientLocked?'LOCKED':'UNLOCKED'}</span></div>}
      <div className="button-row"><button type="button" className="outline-button" disabled={!walletReady||busy||!tokenAddress} onClick={()=>setLock(true)}><LockKeyhole size={15}/> Lock recipient</button><button type="button" className="outline-button" disabled={!walletReady||busy||!tokenAddress} onClick={()=>setLock(false)}><Unlock size={15}/> Unlock recipient</button></div>
      <p className="fine-print">All accounts start locked. Unlocking is an explicit owner-only on-chain change. Locked balances remain visible through balanceOf but cannot transfer or approve spending.</p>
    </div>

    <div className="trax-actions">
      <h3>Owner-controlled redemption</h3>
      <label>Holder address<input value={holder} onChange={e=>setHolder(e.target.value)} autoComplete="off" spellCheck="false"/></label>
      <label>Native TRX payout recipient<input value={redeemRecipient} onChange={e=>setRedeemRecipient(e.target.value)} autoComplete="off" spellCheck="false"/></label>
      <label>Amount (TRӾ / TRX)<input value={redeemAmount} onChange={e=>setRedeemAmount(e.target.value)} inputMode="decimal"/></label>
      <button type="button" className="outline-button" disabled={!walletReady||busy||!snapshot?.linksValid||snapshot?.paused} onClick={redeem}><Wallet size={15}/> Review owner redemption</button>
      <p className="fine-print">Redemption burns TRӾ and releases the same amount of native TRX atomically. The holder cannot initiate redemption; the connected contract owner signs it.</p>
    </div>

    {lastTx&&<div className="notice notice-success"><CheckCircle2 size={16}/><div><b>Solidified Mainnet transaction verified</b><p>{lastTx}</p><a href={'https://tronscan.org/#/transaction/'+lastTx} target="_blank" rel="noreferrer">Open transaction on TRONSCAN <ExternalLink size={12}/></a></div></div>}
    <div className="trax-footer-links"><a href="https://developers.tron.network/docs/trc20-protocol-interface" target="_blank" rel="noreferrer">TRON TRC-20 standard <ExternalLink size={12}/></a><a href="https://tronscan.org/#/token20" target="_blank" rel="noreferrer">TRONSCAN token directory <ExternalLink size={12}/></a></div>
  </section>
}
