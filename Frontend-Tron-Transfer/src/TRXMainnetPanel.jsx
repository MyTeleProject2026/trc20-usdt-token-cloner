import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TronWeb } from 'tronweb'
import { AlertTriangle, ArrowUpRight, CheckCircle2, Coins, ExternalLink, RefreshCw, Rocket, ShieldCheck, Wallet } from 'lucide-react'
import {
  addressesEqual, callMainnetView, formatTokenUnits, getMainnetNativeBalance, loadSavedContracts,
  parseBatchCreditRows, parseTokenUnits, saveContractAddresses, verifyTRAXTokenContract, getMainnetUSDTBalance,
} from './trax-mainnet.mjs'
import { calculatePortfolioValue, fetchTRXReferencePrice } from './trax-pricing.mjs'
import TRAXOwnershipControls from './TRAXOwnershipControls.jsx'
import TRAXCreditHistory from './TRAXCreditHistory.jsx'
import WalletDepositPanel from './WalletDepositPanel.jsx'
import { runLocalSignerAcceptance } from './lib/local-signer-acceptance.mjs'
import './trax-mainnet.css'

const DEFAULT_RECIPIENT = ''
const DEFAULT_FEE_CAP = '150'
const OFFICIAL_USDT_MAINNET_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const RESOURCE_API_BASE = String(import.meta.env?.VITE_RESOURCE_API_URL || 'https://tron-transfer-resource-api.onrender.com').replace(/\/+$/, '')

const SPONSOR_TARGETS_KEY = 'tron-transfer.sponsor-resource-targets.v1'

function saveSponsorResourceTargets(deployment) {
  const energy = String(deployment?.energyWithSafetyMargin || deployment?.energyRequired || '')
  const bandwidth = String(deployment?.estimatedBandwidthBytes || '')
  if (!/^[1-9][0-9]{0,14}$/.test(energy) || !/^[1-9][0-9]{0,14}$/.test(bandwidth)) return
  try {
    localStorage.setItem(SPONSOR_TARGETS_KEY, JSON.stringify({ energy, bandwidth }))
    window.dispatchEvent(new Event('tron-transfer:sponsor-targets-updated'))
  } catch {}
}

function makeReference() {
  const bytes = new Uint8Array(32)
  window.crypto.getRandomValues(bytes)
  return '0x' + Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
}

function TraxTokenMark() { return <img className="trax-token-mark" src="/trax-token-mark.svg" alt="TRӾ token icon" width="22" height="22" loading="lazy"/> }

function formatUsd(value) {
  return Number.isFinite(Number(value))
    ? '$' + Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : 'Unavailable'
}
function formatUsdPrecise(value) {
  return Number.isFinite(Number(value)) ? '$' + Number(value).toFixed(6) : 'Unavailable'
}
function shorten(value) {
  return value && value.length > 18 ? value.slice(0, 10) + '…' + value.slice(-7) : value || '—'
}

export default function TRXMainnetPanel({ wallet, onConnect, activePage = 'home', onNavigate }) {
  const initial = useMemo(() => loadSavedContracts(), [])
  const [tokenAddress, setTokenAddress] = useState(initial.tokenAddress)
  const [snapshot, setSnapshot] = useState(null)
  const [recipient, setRecipient] = useState(DEFAULT_RECIPIENT)
  const [amount, setAmount] = useState('100')
  const [ownerIssueAmount, setOwnerIssueAmount] = useState('100')
  const [batchInput, setBatchInput] = useState('')
  const [lookupAddress, setLookupAddress] = useState(DEFAULT_RECIPIENT)
  const [lookupBalance, setLookupBalance] = useState('')
  const [lookupNativeBalance, setLookupNativeBalance] = useState('')
  const [lookupUsdtBalance, setLookupUsdtBalance] = useState('')
  const [lookupPortfolioValue, setLookupPortfolioValue] = useState(null)
  const [referencePrice, setReferencePrice] = useState(null)
  const [feeCap, setFeeCap] = useState(DEFAULT_FEE_CAP)
  const [busy, setBusy] = useState(false)
  const [ownerSignerAcceptance, setOwnerSignerAcceptance] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [lastTx, setLastTx] = useState('')
  const [step, setStep] = useState('')
  const [deploymentReadiness, setDeploymentReadiness] = useState(null)
  const [deploymentResourcePreflight, setDeploymentResourcePreflight] = useState(null)
  const autoReadinessCheckKeyRef = useRef('')
  const [deploymentOperation, setDeploymentOperation] = useState(null)
  const [deploymentConfirmationPhrase, setDeploymentConfirmationPhrase] = useState('')
  const [broadcastConfirmationPhrase, setBroadcastConfirmationPhrase] = useState('')
  const [deploymentExecutionEnabled, setDeploymentExecutionEnabled] = useState(false)
  const [recentOperations, setRecentOperations] = useState([])
  const [ownerDepositHistory, setOwnerDepositHistory] = useState({ transactions: [], tokenTransfers: [], transactionsAvailable: false, tokenTransfersAvailable: false })
  const [ownerDepositLoading, setOwnerDepositLoading] = useState(false)
  const [usdtWithdrawalRecipient, setUsdtWithdrawalRecipient] = useState('')
  const [usdtWithdrawalAmount, setUsdtWithdrawalAmount] = useState('')
  const [usdtWithdrawalBalance, setUsdtWithdrawalBalance] = useState(null)
  const [usdtWithdrawalTrxBalanceSun, setUsdtWithdrawalTrxBalanceSun] = useState(null)
  const [usdtWithdrawalReservedBalance, setUsdtWithdrawalReservedBalance] = useState('0')
  const [usdtWithdrawalAvailableBalance, setUsdtWithdrawalAvailableBalance] = useState(null)
  const [usdtWithdrawalHistory, setUsdtWithdrawalHistory] = useState([])
  const [usdtWithdrawalBalanceAt, setUsdtWithdrawalBalanceAt] = useState('')
  const [nativeTrxWithdrawalRecipient, setNativeTrxWithdrawalRecipient] = useState('')
  const [nativeTrxWithdrawalAmount, setNativeTrxWithdrawalAmount] = useState('')
  const [nativeTrxReservedBalanceSun, setNativeTrxReservedBalanceSun] = useState('0')
  const [nativeTrxAvailableBalanceSun, setNativeTrxAvailableBalanceSun] = useState(null)
  const [nativeTrxWithdrawalHistory, setNativeTrxWithdrawalHistory] = useState([])
  const [nativeTrxBalanceAt, setNativeTrxBalanceAt] = useState('')
  const prepareInFlightRef = useRef(null)
  const preparationKeyRef = useRef('')

  useEffect(() => {
    try { saveContractAddresses({ tokenAddress }) } catch {}
  }, [tokenAddress])

  const connectedAddress = wallet?.address || ''
  const readOnlyTronWeb = useMemo(() => new TronWeb({ fullHost: RESOURCE_API_BASE + '/api/tron/mainnet/rpc' }), [])
  const panelWallet = useMemo(() => wallet?.managedSession ? { ...wallet, readOnlyTronWeb } : wallet, [wallet, readOnlyTronWeb])
  const walletReady = Boolean(wallet?.managedSession
    && wallet?.signerType === 'encrypted-local-owner-vault'
    && connectedAddress
    && wallet?.tronWeb?.isAddress?.(connectedAddress)
    && typeof wallet?.tronWeb?.trx?.sign === 'function'
    && addressesEqual(wallet.tronWeb, wallet.tronWeb.defaultAddress?.base58, connectedAddress))
  const refreshOwnerDeposits = useCallback(async () => {
    if (!walletReady || !connectedAddress) return
    setOwnerDepositLoading(true)
    try {
      const response = await fetch(RESOURCE_API_BASE + '/v1/transactions/' + encodeURIComponent(connectedAddress) + '?limit=20', { cache: 'no-store' })
      if (!response.ok) throw new Error('Confirmed deposit history returned HTTP ' + response.status)
      const payload = await response.json()
      if (payload?.address !== connectedAddress || payload?.network !== 'TRON Mainnet' || !Array.isArray(payload.data)) throw new Error('Confirmed deposit history response was invalid')
      setOwnerDepositHistory({ transactions: payload.data, tokenTransfers: Array.isArray(payload.trc20Transfers) ? payload.trc20Transfers : [], transactionsAvailable: true, tokenTransfersAvailable: payload.trc20Available === true })
    } catch {
      setOwnerDepositHistory({ transactions: [], tokenTransfers: [], transactionsAvailable: false, tokenTransfersAvailable: false })
    } finally { setOwnerDepositLoading(false) }
  }, [walletReady, connectedAddress])

  useEffect(() => {
    if (walletReady && activePage === 'portfolio') void refreshOwnerDeposits()
  }, [walletReady, activePage, refreshOwnerDeposits])

  useEffect(() => {
    if (walletReady) return
    setPendingOperation(null)
    setOwnerSignerAcceptance(null)
    setConfirmationPhrase('')
    setUsdtWithdrawalBalance(null)
    setUsdtWithdrawalTrxBalanceSun(null)
    setUsdtWithdrawalReservedBalance('0')
    setUsdtWithdrawalAvailableBalance(null)
    setUsdtWithdrawalHistory([])
    setUsdtWithdrawalBalanceAt('')
    setRecentOperations([])
    setDeploymentReadiness(null)
    autoReadinessCheckKeyRef.current = ''
    setDeploymentOperation(null)
    setDeploymentConfirmationPhrase('')
    setDeploymentExecutionEnabled(false)
  }, [walletReady])
  const getOwnerSigner = async () => {
    const signer = wallet?.tronWeb
    if (!signer || !connectedAddress || !signer.isAddress?.(connectedAddress)
      || !addressesEqual(signer, signer.defaultAddress?.base58, connectedAddress)
      || typeof signer.trx?.sign !== 'function') {
      throw new Error('Unlock the configured encrypted local Owner Wallet before signing.')
    }
    return signer
  }

  const feeCapSun = useMemo(() => {
    try {
      const units = BigInt(parseTokenUnits(feeCap))
      if (units <= 0n || units > BigInt(Number.MAX_SAFE_INTEGER)) return 0
      return Number(units)
    } catch { return 0 }
  }, [feeCap])

  const deploymentReady = Boolean(deploymentReadiness?.readyForPreparation
    && deploymentResourcePreflight?.zeroTrxBurnReady === true
    && deploymentReadiness.owner === connectedAddress
    && deploymentReadiness.feeCapSun === feeCapSun
    && deploymentReadiness.tokenAddress === tokenAddress
    && deploymentReadiness.expiresAt > Date.now()
    && deploymentResourcePreflight.owner === connectedAddress
    && deploymentResourcePreflight.feeCapSun === feeCapSun
    && deploymentResourcePreflight.expiresAt > Date.now())

  useEffect(() => {
    if (!deploymentReadiness) return undefined
    const timeout = window.setTimeout(() => setDeploymentReadiness(null), Math.max(0, deploymentReadiness.expiresAt - Date.now()))
    return () => window.clearTimeout(timeout)
  }, [deploymentReadiness])

  useEffect(() => {
    if (!deploymentResourcePreflight?.expiresAt) return undefined
    const timeout = window.setTimeout(() => setDeploymentResourcePreflight(null), Math.max(0, deploymentResourcePreflight.expiresAt - Date.now()))
    return () => window.clearTimeout(timeout)
  }, [deploymentResourcePreflight])

  useEffect(() => { setDeploymentReadiness(null); setDeploymentResourcePreflight(null) }, [connectedAddress, feeCapSun, tokenAddress])

  const run = useCallback(async (label, action) => {
    setBusy(true); setError(''); setNotice(''); setStep(label)
    try { return await action() }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return null
    } finally { setBusy(false); setStep('') }
  }, [])

  const verifyOwnerLocalSigner = () => run('Running local Owner sign-only acceptance', async () => {
    setOwnerSignerAcceptance(null)
    const signer = await getOwnerSigner()
    const result = await runLocalSignerAcceptance({
      authClient: wallet?.authClient,
      tronWeb: signer,
      address: connectedAddress,
      role: 'owner',
    })
    setOwnerSignerAcceptance(result)
    setNotice('Owner local signer acceptance passed for ' + shorten(connectedAddress) + '. The one-time message signature was verified by the Resource API; no transaction, fee or broadcast occurred.')
    return result
  })

  const getToken = useCallback(async () => {
    if (!walletReady) throw new Error('Unlock the configured local Owner Wallet and authenticate the Owner session first.')
    const tronWeb = readOnlyTronWeb
    if (!tronWeb.isAddress(connectedAddress)) throw new Error('The authenticated Owner address is not a valid TRON Mainnet address.')
    if (!tronWeb.isAddress(tokenAddress)) throw new Error('Enter a valid deployed TRON Mainnet TRӾ contract address.')
    const token = await verifyTRAXTokenContract(tronWeb, tokenAddress)
    return { tronWeb, token }
  }, [walletReady, readOnlyTronWeb, connectedAddress, tokenAddress])

  const refresh = () => run('Reading TRON Mainnet token state', async () => {
    const { tronWeb, token } = await getToken()
    const [owner, name, symbol, decimals, totalSupply, paused, mintingEnabled, ownerBalance, ownerTrx, ownerUsdt] = await Promise.all([
      callMainnetView(token.owner()), callMainnetView(token.name()), callMainnetView(token.symbol()), callMainnetView(token.decimals()),
      callMainnetView(token.totalSupply()), callMainnetView(token.paused()), callMainnetView(token.mintingEnabled()),
      callMainnetView(token.balanceOf(connectedAddress)), getMainnetNativeBalance(tronWeb, connectedAddress),
      getMainnetUSDTBalance(tronWeb, connectedAddress),
    ])
    const livePrice = await fetchTRXReferencePrice().catch(() => null)
    setReferencePrice(livePrice)
    const valid = name === 'TRӾ' && symbol === 'TRӾ' && Number(decimals) === 6
    const ownerValid = addressesEqual(tronWeb, owner, connectedAddress)
    const next = {
      owner: String(owner), name, symbol, decimals: Number(decimals), totalSupply: String(totalSupply),
      paused: Boolean(paused), mintingEnabled: Boolean(mintingEnabled), ownerBalance: String(ownerBalance),
      ownerTrx: String(ownerTrx), ownerUsdt: String(ownerUsdt), valid, ownerValid,
    }
    setSnapshot(next)
    if (!valid) throw new Error('Token metadata mismatch. Expected TRӾ / TRӾ / 6 decimals.')
    if (!ownerValid) throw new Error('Connected Owner Wallet is not the token owner.')
    setNotice('Mainnet contract reads succeeded. This is an owner-issued, unbacked token; no reserve or redemption is represented.')
    return next
  })

  const requestReadOnlyDeploymentPreflight = async (readiness = deploymentReadiness) => {
    if (!walletReady || typeof wallet?.authClient?.apiRequest !== 'function') throw new Error('Authenticate the configured Owner session before checking Mainnet resources.')
    if (!readiness?.readyForPreparation) throw new Error('Pass the artifact and database readiness gates before running the resource preflight.')
    const result = await wallet.authClient.apiRequest('/api/owner/deployment/preflight?feeLimitSun=' + encodeURIComponent(String(feeCapSun)))
    setDeploymentResourcePreflight({ ...result, owner: connectedAddress, feeCapSun, expiresAt: Date.now() + 60_000 })
    return result
  }

  const refreshDeploymentResourcePreflight = () => run('Checking live Mainnet Energy, Bandwidth and zero-TRX budget', async () => {
    const result = await requestReadOnlyDeploymentPreflight()
    setNotice(result.zeroTrxBurnReady
      ? 'Live Mainnet preflight passed: the current Owner resources cover the exact deployment estimate with zero TRX fallback. No transaction was persisted, signed or broadcast.'
      : 'ZERO-TRX-BURN PROTECTION BLOCKED DEPLOYMENT. Estimated fallback: ' + (Number(BigInt(result.budget.requiredTrxSun)) / 1e6).toFixed(6) + ' TRX. No transaction was persisted, signed or broadcast.')
    return result
  })

  const checkDeploymentReadiness = () => run('Checking artifact-pinned TRӾ deployment readiness', async () => {
    if (!walletReady || typeof wallet?.authClient?.apiRequest !== 'function') throw new Error('Authenticate the configured Owner session before checking deployment readiness.')
    const result = await wallet.authClient.apiRequest('/api/owner/deployment/readiness')
    setDeploymentExecutionEnabled(Boolean(result.executionEnabled))
    setDeploymentReadiness({ ...result, owner: connectedAddress, feeCapSun, tokenAddress, expiresAt: Date.now() + 60_000 })
    setDeploymentResourcePreflight(null)
    if (result.readyForPreparation) {
      try {
        const preflight = await requestReadOnlyDeploymentPreflight(result)
        setNotice(preflight.zeroTrxBurnReady
          ? 'Artifact pins, durable ledger and live zero-TRX Mainnet resource preflight passed. No transaction was persisted, signed or broadcast.'
          : 'Artifact and database readiness passed, but ZERO-TRX-BURN PROTECTION BLOCKED DEPLOYMENT. Estimated fallback: ' + (Number(BigInt(preflight.budget.requiredTrxSun)) / 1e6).toFixed(6) + ' TRX. No transaction was persisted, signed or broadcast.')
      } catch (preflightError) {
        setDeploymentResourcePreflight({ success: false, error: String(preflightError?.message || preflightError), owner: connectedAddress, feeCapSun, checkedAt: new Date().toISOString() })
        setNotice('Artifact and database readiness passed, but the live Mainnet resource preflight could not complete: ' + String(preflightError?.message || preflightError) + '. No transaction was persisted, signed or broadcast.')
      }
    } else {
      setNotice('Deployment preparation is blocked: ' + String(result.blocker || 'artifact, database, backup or restore gates are incomplete') + '. No transaction was signed or broadcast.')
    }
    return result
  })

  // Entering the deployment page performs sequential read-only checks only.
  // It never prepares, signs, or broadcasts a transaction.
  useEffect(() => {
    if (!walletReady || activePage !== 'deploy' || typeof wallet?.authClient?.apiRequest !== 'function') {
      autoReadinessCheckKeyRef.current = ''
      return
    }
    const key = [connectedAddress, feeCapSun, tokenAddress].join(':')
    if (autoReadinessCheckKeyRef.current === key) return
    autoReadinessCheckKeyRef.current = key
    void (async () => {
      await checkDeploymentReadiness()
      if (tokenAddress) await refresh()
    })()
  }, [walletReady, activePage, connectedAddress, feeCapSun, tokenAddress, wallet?.authClient])

  const deployToken = () => run('Preparing exact artifact-pinned TRӾ deployment transaction', async () => {
    if (!walletReady || !deploymentReady || typeof wallet?.authClient?.apiRequest !== 'function') throw new Error('Run a successful, unexpired backend deployment readiness check first.')
    const result = await wallet.authClient.apiRequest('/api/owner/deployment/prepare', { method: 'POST', csrf: true, body: { confirmationPhrase: 'PREPARE TRӾ MAINNET DEPLOYMENT', idempotencyKey: makeIdempotencyKey(), feeLimitSun: String(feeCapSun) } })
    const deployment = result.deployment || {}
    setDeploymentOperation({ operationId: result.operationId || deployment.operation_id, intentSha256: result.intentSha256 || deployment.intent_sha256, unsignedTransaction: result.unsignedTransaction || deployment.unsignedTransaction || null, state: deployment.state || 'prepared', transactionId: deployment.transaction_id || deployment.transactionId, contractAddress: deployment.contract_address || deployment.contractAddress || '', confirmationPhrase: result.confirmationPhrase || 'CONFIRM TRӾ MAINNET DEPLOYMENT', executionEnabled: deploymentExecutionEnabled })
    setDeploymentConfirmationPhrase('')
    setBroadcastConfirmationPhrase('')
    setNotice('The exact unsigned CreateSmartContract transaction and artifact fingerprints are persisted. No signature or broadcast was requested yet; the separate confirmation will open local Owner vault for Owner approval.')
    return result
  })

  const confirmDeployment = () => run('Signing the exact TRӾ deployment with the local Owner vault', async () => {
    if (!deploymentOperation?.operationId || !deploymentOperation.intentSha256 || !deploymentOperation.unsignedTransaction) throw new Error('Prepare and review the exact unsigned deployment transaction first.')
    if (!deploymentExecutionEnabled) throw new Error('Deployment execution remains locked until independent database backup/restore and production acceptance gates are verified.')
    if (deploymentConfirmationPhrase !== deploymentOperation.confirmationPhrase) throw new Error('Type the exact deployment confirmation phrase shown below.')
    const signer = await getOwnerSigner()
    const signedTransaction = await signer.trx.sign(deploymentOperation.unsignedTransaction)
    if (!Array.isArray(signedTransaction?.signature) || signedTransaction.signature.length !== 1
      || String(signedTransaction.txID || '').toLowerCase() !== String(deploymentOperation.unsignedTransaction.txID || '').toLowerCase()
      || String(signedTransaction.raw_data_hex || '').toLowerCase() !== String(deploymentOperation.unsignedTransaction.raw_data_hex || '').toLowerCase()) {
      throw new Error('The local Owner vault did not return a signature for the exact prepared deployment. Nothing was submitted.')
    }
    let result
    try { result = await wallet.authClient.apiRequest('/api/owner/deployment/confirm', { method: 'POST', csrf: true, body: { operationId: deploymentOperation.operationId, intentSha256: deploymentOperation.intentSha256, confirmationPhrase: deploymentOperation.confirmationPhrase, signedTransaction } }) }
    catch (requestError) { const recovered = await wallet.authClient.apiRequest('/api/owner/deployment/' + deploymentOperation.operationId).catch(() => null); if (recovered?.deployment) setDeploymentOperation(current => ({ ...current, ...recovered.deployment, unsignedTransaction: recovered.unsignedTransaction || current?.unsignedTransaction || null, executionEnabled: deploymentExecutionEnabled })); throw requestError }
    setDeploymentOperation(current => ({ ...current, ...(result.deployment || {}), broadcastApproval: result.broadcastApproval || null, executionEnabled: deploymentExecutionEnabled }))
    setDeploymentConfirmationPhrase('')
    setBroadcastConfirmationPhrase(result.broadcastApproval?.confirmationPhrase || '')
    setNotice(result.message || 'The local Owner signature was verified and durably saved. No Mainnet broadcast was attempted.')
    return result
  })

  const broadcastApprovedDeployment = () => run('Submitting explicitly approved TRӾ Mainnet deployment', async () => {
    const approval = deploymentOperation?.broadcastApproval
    if (!deploymentOperation?.operationId || !deploymentOperation?.intentSha256 || !approval?.transactionId) throw new Error('A locally signed deployment awaiting explicit broadcast approval is required.')
    if (!deploymentExecutionEnabled) throw new Error('Mainnet broadcast remains locked by the independent production safety gates.')
    if (broadcastConfirmationPhrase !== approval.confirmationPhrase) throw new Error('Type the exact transaction-specific broadcast phrase shown below.')
    const result = await wallet.authClient.apiRequest('/api/owner/deployment/broadcast', { method: 'POST', csrf: true, body: {
      operationId: deploymentOperation.operationId, intentSha256: deploymentOperation.intentSha256,
      transactionId: approval.transactionId, confirmationPhrase: broadcastConfirmationPhrase,
    } })
    setDeploymentOperation(current => ({ ...current, ...(result.deployment || {}), broadcastApproval: null, executionEnabled: deploymentExecutionEnabled }))
    setBroadcastConfirmationPhrase('')
    setNotice(result.message || 'The transaction-specific broadcast approval was processed. Reconcile the original transaction ID; never create a replacement deployment.')
    return result
  })

  const refreshDeploymentStatus = () => run('Reconciling TRӾ deployment against solidified Mainnet', async () => {
    if (!deploymentOperation?.operationId) throw new Error('Prepare or recover a deployment operation first.')
    const result = await wallet.authClient.apiRequest('/api/owner/deployment/' + deploymentOperation.operationId)
    const deployment = result.deployment || {}
    setDeploymentOperation(current => ({ ...current, ...deployment, unsignedTransaction: result.unsignedTransaction || current?.unsignedTransaction || null, broadcastApproval: result.broadcastApproval || null, executionEnabled: deploymentExecutionEnabled }))
    setBroadcastConfirmationPhrase(result.broadcastApproval?.confirmationPhrase || '')
    const deployedAddress = deployment.contractAddress || deployment.contract_address
    const transactionId = deployment.transactionId || deployment.transaction_id
    if (deployment.state === 'confirmed' && deployedAddress) { setTokenAddress(deployedAddress); setLastTx(transactionId || ''); setSnapshot(null); setNotice('TRӾ deployment is solidified. The backend verified the exact transaction, runtime bytecode, Owner and token metadata.') }
    else setNotice('Deployment state: ' + String(deployment.state || 'pending') + '. Automatic re-signing and rebroadcast are disabled.')
    return deployment
  })

  const clearSavedTokenAddress = () => {
    setTokenAddress('')
    setSnapshot(null)
    setLookupBalance('')
    setNotice('The saved contract address was cleared from this browser only. No blockchain contract or tokens were changed.')
    setError('')
  }

  const [pendingOperation, setPendingOperation] = useState(null)
  const [confirmationPhrase, setConfirmationPhrase] = useState('')

  const makeIdempotencyKey = () => {
    const bytes = new Uint8Array(24)
    window.crypto.getRandomValues(bytes)
    return 'owner-' + Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
  }

  const prepareOwnerOperation = useCallback(async ({ operationType, summary, ...intent }) => {
    if (prepareInFlightRef.current) return prepareInFlightRef.current
    const task = run('Preparing guarded TRON Mainnet Owner operation', async () => {
      if (!walletReady || typeof wallet?.authClient?.apiRequest !== 'function') throw new Error('Authenticate the configured backend Owner session before preparing a write.')
      const operationContractAddress = operationType === 'trx-transfer' ? 'TRX' : operationType === 'usdt-transfer' ? OFFICIAL_USDT_MAINNET_CONTRACT : tokenAddress.trim()
      if (!['trx-transfer', 'usdt-transfer'].includes(operationType) && !operationContractAddress) throw new Error('Enter the existing verified TRӾ Mainnet contract address.')
      if (!feeCapSun) throw new Error('Enter a valid transaction fee limit.')
      const idempotencyKey = preparationKeyRef.current || (preparationKeyRef.current = makeIdempotencyKey())
      let result
      try {
        result = await wallet.authClient.apiRequest('/api/owner/operations/prepare', {
          method: 'POST', csrf: true,
          body: {
            operationType, contractAddress: operationContractAddress,
            feeLimitSun: String(feeCapSun), idempotencyKey, ...intent,
          },
        })
        preparationKeyRef.current = ''
      } catch (requestError) {
        if (requestError?.status) preparationKeyRef.current = ''
        throw requestError
      }
      if (!result.success || !result.operationId) throw new Error(result.error || 'OWNER_OPERATION_PREPARATION_FAILED')
      if (result.replay) {
        const recovered = await wallet.authClient.apiRequest('/api/owner/operations/' + result.operationId)
        setPendingOperation({ ...recovered.operation, ...result, ...recovered.operation, ownerAddress: connectedAddress, summary, executionEnabled: recovered.executionEnabled })
        setNotice('An existing operation with this exact idempotency key was recovered. Review its stored intent and state; no new transaction was created.')
        return recovered
      }
      setPendingOperation({ ...result, summary, state: result.state })
      setConfirmationPhrase('')
      const journal = await wallet.authClient.apiRequest('/api/owner/operations?limit=20').catch(() => null)
      if (journal?.success) setRecentOperations(journal.operations || [])
      return result
    })
    prepareInFlightRef.current = task
    try { return await task }
    finally { if (prepareInFlightRef.current === task) prepareInFlightRef.current = null }
  }, [run, wallet, walletReady, tokenAddress, feeCapSun])

  const confirmOwnerOperation = () => run('Rechecking Mainnet state, signing and verifying the Owner operation', async () => {
    if (!pendingOperation?.operationId) throw new Error('Prepare an Owner operation before confirming.')
    if (!pendingOperation.executionEnabled) throw new Error('Backend Owner execution is still disabled by the independent production safety gates.')
    if (confirmationPhrase !== pendingOperation.confirmationPhrase) throw new Error('Type the exact confirmation phrase shown below.')
    let result
    try {
      if (!pendingOperation.unsignedTransaction) throw new Error('The prepared unsigned transaction is unavailable. Cancel and prepare the operation again.')
      const signer = await getOwnerSigner()
      const signedTransaction = await signer.trx.sign(pendingOperation.unsignedTransaction)
      if (!Array.isArray(signedTransaction?.signature) || signedTransaction.signature.length !== 1
        || String(signedTransaction.txID || '').toLowerCase() !== String(pendingOperation.unsignedTransaction.txID || '').toLowerCase()
        || String(signedTransaction.raw_data_hex || '').toLowerCase() !== String(pendingOperation.unsignedTransaction.raw_data_hex || '').toLowerCase()) {
        throw new Error('The local Owner vault did not return a signature for the exact prepared Owner operation. Nothing was submitted.')
      }
      result = await wallet.authClient.apiRequest('/api/owner/operations/' + pendingOperation.operationId + '/confirm', {
        method: 'POST', csrf: true,
        body: {
          confirmationPhrase,
          intentSha256: pendingOperation.intentSha256,
          contractAddress: pendingOperation.contractAddress,
          signedTransaction,
        },
      })
    } catch (requestError) {
      const recovered = await wallet.authClient.apiRequest('/api/owner/operations/' + pendingOperation.operationId).catch(() => null)
      if (recovered?.operation) {
        setPendingOperation(current => current ? {
          ...current, ...recovered.operation,
          confirmationPhrase: recovered.operation.confirmationPhrase || current.confirmationPhrase,
          executionEnabled: recovered.executionEnabled,
        } : current)
        if (recovered.operation.transactionId) {
          setNotice('The server recorded transaction ' + recovered.operation.transactionId + ' in state ' + recovered.operation.state + '. Do not retry or rebroadcast it.')
        }
        if (pendingOperation.operationType === 'usdt-transfer' && ['confirmed', 'failed'].includes(recovered.operation.state)) {
          await readUsdtWithdrawalSnapshot().catch(() => {})
        }
      }
      throw requestError
    }
    setPendingOperation(current => current ? { ...current, state: result.state || current.state, transactionId: result.transactionId || current.transactionId, blockNumber: result.blockNumber || current.blockNumber } : current)
    if (result.state === 'confirmed' && result.transactionId) {
      setLastTx(result.transactionId)
      setNotice('The Owner operation is confirmed in a solidified TRON Mainnet block. Refresh contract state to verify the updated token values.')
      setPendingOperation(null)
      setConfirmationPhrase('')
      setSnapshot(null)
      if (pendingOperation.operationType === 'usdt-transfer') await readUsdtWithdrawalSnapshot().catch(() => {})
      const journal = await wallet.authClient.apiRequest('/api/owner/operations?limit=20').catch(() => null)
      if (journal?.success) setRecentOperations(journal.operations || [])
      return result
    }
    if (result.transactionId) {
      setNotice('The signed transaction is recorded as ' + String(result.state || 'pending') + '. Do not retry or create a replacement operation. Refresh this operation status to reconcile the solidified receipt.')
      if (pendingOperation.operationType === 'usdt-transfer') await readUsdtWithdrawalSnapshot().catch(() => {})
      return result
    }
    throw new Error(result.error || 'OWNER_OPERATION_CONFIRMATION_FAILED')
  })

  const cancelOwnerOperation = () => run('Cancelling unsubmitted Owner operation', async () => {
    if (!pendingOperation?.operationId) return
    await wallet.authClient.apiRequest('/api/owner/operations/' + pendingOperation.operationId + '/cancel', { method: 'POST', csrf: true, body: {} })
    setPendingOperation(null)
    setConfirmationPhrase('')
    setNotice('The prepared Owner operation was cancelled. No transaction was signed or broadcast.')
    if (pendingOperation.operationType === 'usdt-transfer') await readUsdtWithdrawalSnapshot().catch(() => {})
    const journal = await wallet.authClient.apiRequest('/api/owner/operations?limit=20').catch(() => null)
    if (journal?.success) setRecentOperations(journal.operations || [])
  })

  const refreshPendingOperation = () => run('Reconciling Owner transaction against solidified TRON Mainnet', async () => {
    if (!pendingOperation?.operationId) return
    const result = await wallet.authClient.apiRequest('/api/owner/operations/' + pendingOperation.operationId)
    const operation = result.operation
    setPendingOperation(current => current ? {
      ...current, ...operation, summary: current.summary || operation.operationType,
      confirmationPhrase: operation.confirmationPhrase || current.confirmationPhrase,
      executionEnabled: result.executionEnabled,
    } : current)
    if (operation.operationType === 'usdt-transfer' && ['confirmed', 'failed'].includes(operation.state)) {
      await readUsdtWithdrawalSnapshot().catch(() => {})
    }
    if (operation.state === 'confirmed' && operation.transactionId) {
      setLastTx(operation.transactionId)
      const journal = await wallet.authClient.apiRequest('/api/owner/operations?limit=20').catch(() => null)
      if (journal?.success) setRecentOperations(journal.operations || [])
      setPendingOperation(null)
      setSnapshot(null)
      setNotice('The transaction is confirmed in a solidified Mainnet block.')
    } else if (operation.state === 'failed') {
      setNotice('The solidified transaction failed on-chain: ' + String(operation.failureCode || 'execution failed') + '. Do not retry this transaction ID.')
    } else {
      setNotice('Owner operation state: ' + operation.state + '. No automatic re-sign or rebroadcast was attempted.')
    }
    return operation
  })

  const refreshOwnerOperations = () => run('Loading durable Owner operation journal', async () => {
    if (!walletReady || typeof wallet?.authClient?.apiRequest !== 'function') throw new Error('Authenticate the Owner session to read its operation journal.')
    const result = await wallet.authClient.apiRequest('/api/owner/operations?limit=20')
    setRecentOperations(result.operations || [])
    return result.operations || []
  })

  const checkOwnerOperation = operationId => run('Checking Owner operation receipt', async () => {
    const result = await wallet.authClient.apiRequest('/api/owner/operations/' + operationId)
    const operation = result.operation
    setRecentOperations(current => current.map(item => item.operationId === operationId ? { ...item, ...operation } : item))
    if (operation.state === 'awaiting-confirmation') {
      setPendingOperation({
        ...operation, ownerAddress: connectedAddress, summary: operation.operationType,
        confirmationPhrase: operation.confirmationPhrase,
        executionEnabled: result.executionEnabled,
      })
      setConfirmationPhrase('')
      setNotice('Recovered the exact pending Owner intent from the durable ledger. Review all ABI arguments before confirming.')
    } else if (operation.transactionId) {
      setNotice('Recovered transaction ' + operation.transactionId + ' · ' + operation.state + '. No automatic retry was attempted.')
      if (operation.state === 'confirmed') { setLastTx(operation.transactionId); setPendingOperation(null) }
    } else {
      setNotice('Recovered Owner operation state: ' + operation.state + (operation.failureCode ? ' · ' + operation.failureCode : ''))
    }
    return operation
  })

  const unpauseTransfers = () => prepareOwnerOperation({
    operationType: 'unpause', summary: 'Unpause TRӾ transfers',
  })
  const enableMinting = () => prepareOwnerOperation({
    operationType: 'minting-enable', summary: 'Enable Owner TRӾ issuance',
  })
  const disableMinting = () => prepareOwnerOperation({
    operationType: 'minting-disable', summary: 'Disable Owner TRӾ issuance',
  })
  const issueOwnerSupply = () => {
    try {
      const units = parseTokenUnits(ownerIssueAmount)
      const referenceId = makeReference()
      return prepareOwnerOperation({
        operationType: 'owner-issue', amount: units, referenceId,
        summary: 'Issue ' + ownerIssueAmount + ' TRӾ to the configured Owner wallet · reference ' + referenceId,
      })
    } catch (error) { setError(error.message); return null }
  }
  const issueCredit = () => {
    try {
      if (!readOnlyTronWeb.isAddress(recipient.trim())) throw new Error('Enter a valid TRON Mainnet recipient address.')
      const units = parseTokenUnits(amount)
      const referenceId = makeReference()
      return prepareOwnerOperation({
        operationType: 'credit', recipient: recipient.trim(), amount: units, referenceId,
        summary: 'Issue ' + amount + ' TRӾ to ' + recipient.trim() + ' · reference ' + referenceId,
      })
    } catch (error) { setError(error.message); return null }
  }
  const batchCredit = () => {
    try {
      const { recipients, amounts } = parseBatchCreditRows(batchInput, address => readOnlyTronWeb.isAddress(address), 50)
      const rows = recipients.map((address, index) => ({ recipient: address, amount: amounts[index], referenceId: makeReference() }))
      return prepareOwnerOperation({
        operationType: 'batch-credit', rows,
        summary: 'Batch issue TRӾ to ' + rows.length + ' recipient addresses',
      })
    } catch (error) { setError(error.message); return null }
  }

  const readBalance = () => run('Reading external wallet token balance', async () => {
    const { tronWeb, token } = await getToken()
    if (!tronWeb.isAddress(lookupAddress.trim())) throw new Error('Enter a valid TRON Mainnet address.')
    const [balance, nativeBalance, usdtBalance, livePrice] = await Promise.all([
      callMainnetView(token.balanceOf(lookupAddress.trim())), getMainnetNativeBalance(tronWeb, lookupAddress.trim()),
      getMainnetUSDTBalance(tronWeb, lookupAddress.trim()), fetchTRXReferencePrice().catch(() => null),
    ])
    setLookupBalance(String(balance)); setLookupNativeBalance(String(nativeBalance)); setLookupUsdtBalance(String(usdtBalance))
    setLookupPortfolioValue(livePrice ? calculatePortfolioValue({ trx: formatTokenUnits(nativeBalance), trax: formatTokenUnits(balance), usdt: formatTokenUnits(usdtBalance), prices: livePrice }) : null)
    return balance
  })

  const transfer = () => {
    try {
      if (!readOnlyTronWeb.isAddress(recipient.trim())) throw new Error('Enter a valid TRON Mainnet recipient address.')
      const units = parseTokenUnits(amount)
      return prepareOwnerOperation({
        operationType: 'transfer', recipient: recipient.trim(), amount: units,
        summary: 'Transfer ' + amount + ' existing TRӾ from the Owner wallet to ' + recipient.trim(),
      })
    } catch (error) { setError(error.message); return null }
  }

  const readUsdtWithdrawalSnapshot = async () => {
    if (!walletReady || typeof wallet?.authClient?.apiRequest !== 'function') throw new Error('Unlock the configured encrypted local Owner Wallet first.')
    const [balance, trxBalanceSun, journal] = await Promise.all([
      getMainnetUSDTBalance(readOnlyTronWeb, connectedAddress),
      getMainnetNativeBalance(readOnlyTronWeb, connectedAddress),
      wallet.authClient.apiRequest('/api/owner/operations?limit=50'),
    ])
    if (!journal?.success) throw new Error(journal?.error || 'OWNER_WITHDRAWAL_LEDGER_UNAVAILABLE')
    if (!Object.hasOwn(journal, 'reservedUsdtBaseUnits')) throw new Error('OWNER_USDT_RESERVATION_SUMMARY_UNAVAILABLE')
    const reserved = String(journal.reservedUsdtBaseUnits)
    if (!/^(?:0|[1-9][0-9]*)$/.test(reserved)) throw new Error('OWNER_USDT_RESERVED_BALANCE_INVALID')
    const available = BigInt(String(balance)) > BigInt(reserved)
      ? (BigInt(String(balance)) - BigInt(reserved)).toString()
      : '0'
    setUsdtWithdrawalBalance(String(balance))
    setUsdtWithdrawalTrxBalanceSun(String(trxBalanceSun))
    setUsdtWithdrawalReservedBalance(reserved)
    setUsdtWithdrawalAvailableBalance(available)
    setUsdtWithdrawalHistory((journal.operations || []).filter(item => item.operationType === 'usdt-transfer'))
    setUsdtWithdrawalBalanceAt(new Date().toISOString())
    return { balance: String(balance), reserved, available }
  }

  const refreshUsdtWithdrawalBalance = () => run('Reading official USDT balance and active withdrawal reservations', readUsdtWithdrawalSnapshot)

  const readOwnerNativeTrxSnapshot = async () => {
    if (!walletReady || typeof wallet?.authClient?.apiRequest !== 'function') throw new Error('Unlock the configured encrypted local Owner Wallet first.')
    const [balance, journal] = await Promise.all([
      getMainnetNativeBalance(readOnlyTronWeb, connectedAddress),
      wallet.authClient.apiRequest('/api/owner/operations?limit=50'),
    ])
    if (!journal?.success || !Object.hasOwn(journal, 'reservedTrxBaseUnits')) throw new Error(journal?.error || 'OWNER_TRX_RESERVATION_SUMMARY_UNAVAILABLE')
    const reserved = String(journal.reservedTrxBaseUnits)
    if (!/^(?:0|[1-9][0-9]*)$/.test(reserved)) throw new Error('OWNER_TRX_RESERVED_BALANCE_INVALID')
    const available = BigInt(String(balance)) > BigInt(reserved) ? (BigInt(String(balance)) - BigInt(reserved)).toString() : '0'
    setUsdtWithdrawalTrxBalanceSun(String(balance))
    setNativeTrxReservedBalanceSun(reserved)
    setNativeTrxAvailableBalanceSun(available)
    setNativeTrxWithdrawalHistory((journal.operations || []).filter(item => item.operationType === 'trx-transfer'))
    setNativeTrxBalanceAt(new Date().toISOString())
    return { balance: String(balance), reserved, available }
  }

  const refreshOwnerNativeTrxBalance = () => run('Reading Owner native TRX balance and active withdrawal reservations', readOwnerNativeTrxSnapshot)

  const prepareNativeTrxWithdrawal = async () => {
    try {
      const recipientAddress = nativeTrxWithdrawalRecipient.trim()
      if (!readOnlyTronWeb.isAddress(recipientAddress)) throw new Error('Enter a valid TRON Mainnet recipient address.')
      if (recipientAddress === connectedAddress) throw new Error('The recipient must be different from the Owner wallet.')
      const amountSun = parseTokenUnits(nativeTrxWithdrawalAmount)
      const current = await readOwnerNativeTrxSnapshot()
      if (BigInt(amountSun) > BigInt(current.available)) throw new Error('The requested withdrawal exceeds available native TRX after active withdrawal reservations.')
      return await prepareOwnerOperation({
        operationType: 'trx-transfer', recipient: recipientAddress, amount: amountSun,
        summary: 'Send ' + nativeTrxWithdrawalAmount + ' native TRX to ' + recipientAddress,
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return null
    }
  }

  const prepareUsdtWithdrawal = async () => {
    try {
      if (!readOnlyTronWeb.isAddress(usdtWithdrawalRecipient.trim())) throw new Error('Enter a valid TRON Mainnet recipient address.')
      if (usdtWithdrawalRecipient.trim() === connectedAddress) throw new Error('The recipient must be different from the Owner wallet.')
      const units = parseTokenUnits(usdtWithdrawalAmount)
      const snapshot = await readUsdtWithdrawalSnapshot()
      if (BigInt(units) > BigInt(snapshot.available)) throw new Error('The requested withdrawal exceeds the available official USDT balance after active withdrawal reservations.')
      const prepared = await prepareOwnerOperation({
        operationType: 'usdt-transfer',
        recipient: usdtWithdrawalRecipient.trim(),
        amount: units,
        summary: 'Withdraw ' + usdtWithdrawalAmount + ' official USDT to ' + usdtWithdrawalRecipient.trim(),
      })
      await readUsdtWithdrawalSnapshot().catch(() => {})
      return prepared
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return null
    }
  }

  const pause = () => prepareOwnerOperation({
    operationType: 'pause', summary: 'Emergency pause TRӾ transfers and issuance',
  })

  const show = (...pages) => pages.includes(activePage)

  return <section className="trax-workspace">
    <div className="section-heading">
      <div><span className="eyebrow">TRON TRANSFER · OWNER WORKSPACE · MAINNET</span><h2>{show('withdraw') ? 'Official USDT withdrawal' : 'TRӾ token control center'}</h2><p>{show('withdraw') ? 'Transfer official TRC-20 USDT from the existing Owner wallet using its encrypted local signer and the shared durable Owner operation ledger.' : 'Manage the existing TRӾ TRC-20 contract. Writes require a backend-managed Owner session, exact-intent confirmation and a fresh Mainnet preflight.'}</p></div>
      <div className="panel-icon" aria-label={show('withdraw') ? 'Official USDT' : 'TRӾ token'}>{show('withdraw') ? <Coins/> : <TraxTokenMark/>}<small>{show('withdraw') ? 'USDT / TRC20' : 'TRӾ / TRӾ'}</small></div>
    </div>

    {!show('withdraw') && <div className="trax-notice" role="note"><AlertTriangle size={18}/><div><b>OWNER-ISSUED TOKEN · NOT NATIVE TRX</b><p>TRӾ is a custom TRC-20 token without reserves, collateral, guaranteed redemption or a promised market price. Owner issuance can dilute holders. Native TRX and TRӾ are different assets.</p></div></div>}

    {!walletReady ? <div className="trax-connect"><p>{wallet?.managedSession && connectedAddress ? 'Owner password session restored. Unlock the local Owner vault matching the authenticated Owner account (' + shorten(connectedAddress) + ') to review and approve Mainnet transactions.' : connectedAddress ? 'The local Owner vault must match the authenticated Owner session before Mainnet actions are enabled.' : 'Sign in to the configured backend Owner account to administer the contract.'}</p><button type="button" className="primary-button" onClick={onConnect}><Wallet size={16}/> {wallet?.managedSession ? 'Unlock matching local Owner vault' : 'Unlock Owner Wallet'}</button></div> : <div className="trax-wallet-row"><span>Connected owner / transaction fee payer</span><b>{shorten(connectedAddress)}</b><span className="trax-network"><CheckCircle2 size={14}/> TRON Mainnet</span><small>This wallet is the transaction owner. Network fees are never redirected to a different account.</small></div>}

    {walletReady && <div className="trax-signer-acceptance" role="region" aria-label="Owner local signer acceptance">
      <div>
        <span className="eyebrow">LOCAL SIGNER · SIGN-ONLY</span>
        <b>Owner vault key-control check</b>
        <p>Signs a one-time, session-bound Mainnet message locally and asks the API to verify the recovered Owner address. No transaction is created or broadcast.</p>
        {ownerSignerAcceptance && <small className="trax-signer-acceptance-result" role="status">Verified {new Date(ownerSignerAcceptance.verifiedAt).toLocaleString()} · {shorten(ownerSignerAcceptance.address)}</small>}
        {ownerSignerAcceptance && <small className="trax-signer-acceptance-result" role="status">{ownerSignerAcceptance.auditRecorded ? 'Saved to the Owner security audit log.' : 'Signature verified, but durable audit logging is unavailable. Retry when the Resource API is healthy.'}</small>}
      </div>
      <button type="button" className="outline-button" disabled={busy} onClick={() => void verifyOwnerLocalSigner()}>Run sign-only acceptance</button>
    </div>}

    {error && <div className="notice notice-error" role="alert"><AlertTriangle size={16}/><div>{error}{typeof onNavigate === 'function' && /resource|energy|bandwidth|zero.TRX|deployment readiness/i.test(error) && <p><button type="button" className="outline-button" onClick={() => onNavigate('sponsor-automation')}>Open Sponsor resource provisioning</button></p>}</div></div>}
    {notice && <div className="notice notice-success" role="status"><CheckCircle2 size={16}/>{notice}</div>}
    {step && <div className="trax-progress" role="status"><RefreshCw size={15} className="trax-spin"/>{step}</div>}

    <div className="trax-addresses">
      {!show('withdraw') && <><label>TRӾ Mainnet contract address<input aria-describedby="trax-contract-address-note" value={tokenAddress} onChange={e => setTokenAddress(e.target.value.trim())} placeholder="Enter an existing verified address or deploy a new contract"/></label>
      <p id="trax-contract-address-note" className="fine-print">The contract address identifies the custom token on TRON Mainnet. Verify its on-chain bytecode and metadata before accepting deposits.</p></>}
      <label>Transaction fee limit (TRX)<input type="number" min="0.000001" step="0.000001" value={feeCap} onChange={e => setFeeCap(e.target.value)}/></label>
      <p className="fine-print">Choose the fee-limit ceiling for this operation. The Resource API checks it against the current TRON Mainnet getMaxFeeLimit parameter and a fresh Energy/Bandwidth estimate; there is no fixed application-level TRX fee cap. The fee limit is not a prepaid fee, and zero-TRX-burn protection still blocks signing if the live resource preflight detects any TRX fallback.</p>
      {show('deploy') && <div className="trax-deploy-actions">
        <div className="trax-step-card"><b>Deployment checklist</b><span>1. Confirm the connected owner address.</span><span>2. Run a live read-only resource, permission and Energy preflight.</span><span>3. The backend pins source, creation bytecode, runtime bytecode and manifest; preparation is unsigned and execution remains gated.</span><span>4. The local Owner vault signs the exact prepared transaction; the Resource API verifies the signer, persists before broadcast, and verifies the solidified receipt, runtime, Owner and metadata.</span></div>
        {deploymentReadiness && <>
          <div className={'trax-state-banner' + (deploymentReadiness.readyForPreparation ? ' success' : '')}>
            <b>{deploymentReadiness.readyForPreparation ? 'Artifact and deployment-ledger preflight passed' : 'Deployment readiness blocked'}</b>
            <span>{deploymentReadiness.blocker || 'No blocker reported'} · Execution {deploymentReadiness.executionEnabled ? 'enabled by server configuration' : 'locked'} · This check is read-only.</span>
          </div>
          <div className="trax-step-card">
            <b>Owner deployment gate results</b>
            {Object.entries(deploymentReadiness.gates || {}).map(([key, value]) => <span key={key}>{key.replace(/([A-Z])/g, ' $1').replace(/^./, letter => letter.toUpperCase())}: <strong>{value === true ? 'Passed' : 'Blocked'}</strong></span>)}
            {deploymentReadiness.artifact?.artifactSha256 && <span>Artifact fingerprint: {deploymentReadiness.artifact.artifactSha256.slice(0, 16)}…</span>}
          </div>
        </>}
        {deploymentResourcePreflight && <div className={'trax-step-card' + (deploymentResourcePreflight.zeroTrxBurnReady ? ' success' : '')}>
          <b>{deploymentResourcePreflight.zeroTrxBurnReady ? 'Live Mainnet zero-TRX resource preflight passed' : 'Live Mainnet resource preflight blocked or unavailable'}</b>
          {deploymentResourcePreflight.success === false
            ? <span>{deploymentResourcePreflight.error}</span>
            : <>
              <span>Owner native balance: {(Number(BigInt(deploymentResourcePreflight.ownerBalanceSun || '0')) / 1e6).toFixed(6)} TRX</span>
              <span>Energy required with 25% margin: {deploymentResourcePreflight.budget?.energyWithSafetyMargin} · Available: {deploymentResourcePreflight.budget?.availableEnergy}</span>
              <span>Estimated transaction Bandwidth: {deploymentResourcePreflight.budget?.estimatedBandwidthBytes} bytes · Largest single available quota: {deploymentResourcePreflight.budget?.availableBandwidth}</span>
              <span>Estimated TRX fallback: {(Number(BigInt(deploymentResourcePreflight.budget?.requiredTrxSun || '0')) / 1e6).toFixed(6)} TRX</span>
              <span>Energy shortfall: {deploymentResourcePreflight.budget?.energyShortfall} · Bandwidth shortfall: {deploymentResourcePreflight.budget?.bandwidthShortfall}</span>
            </>}
          <span>Read-only check · transaction persisted: No · signature requested: No · broadcast attempted: No</span>
          {deploymentResourcePreflight.checkedAt && <span>Checked at: {deploymentResourcePreflight.checkedAt}</span>}
        </div>}
        <div className="button-row"><button type="button" className="secondary-button" disabled={!walletReady || busy || !feeCapSun} onClick={checkDeploymentReadiness}><ShieldCheck size={15}/> {deploymentReady ? 'Recheck deployment readiness' : 'Check deployment readiness'}</button><button type="button" className="secondary-button" disabled={!walletReady || busy || !feeCapSun || !deploymentReadiness?.readyForPreparation} onClick={refreshDeploymentResourcePreflight}><RefreshCw size={15}/> Refresh resource preflight</button><button type="button" className="primary-button" disabled={!walletReady || busy || !feeCapSun || !deploymentReady} onClick={deployToken}><Rocket size={15}/> Prepare deployment</button><button type="button" className="outline-button" disabled={!walletReady || busy || !tokenAddress} onClick={refresh}><RefreshCw size={15}/> Verify contract state</button>{Boolean(tokenAddress) && <button type="button" className="outline-button" disabled={busy} onClick={() => { if (window.confirm('Clear only this browser’s saved contract address? This does not delete the on-chain contract.')) clearSavedTokenAddress() }}>Clear saved address</button>}</div>
        {deploymentOperation && <div className="trax-state-banner"><b>Deployment operation: {deploymentOperation.state}</b><span>Transaction ID: {deploymentOperation.transactionId || deploymentOperation.transaction_id || 'Not signed yet'} · Predicted contract: {deploymentOperation.predictedContractAddress || deploymentOperation.contractAddress || deploymentOperation.contract_address || 'Pending'}</span>
          {deploymentOperation.state === 'prepared' && <><label>Type exact signing confirmation phrase: {deploymentOperation.confirmationPhrase}<input value={deploymentConfirmationPhrase} onChange={event => setDeploymentConfirmationPhrase(event.target.value)} autoComplete="off" spellCheck="false" placeholder={deploymentOperation.confirmationPhrase}/></label><button type="button" className="primary-button" disabled={!walletReady || !deploymentExecutionEnabled || busy || deploymentConfirmationPhrase !== deploymentOperation.confirmationPhrase} onClick={confirmDeployment}>Sign exact transaction with local Owner vault</button></>}
          {deploymentOperation.state === 'signed' && <><p className="fine-print">Owner signature verified and stored. No transaction has been broadcast. This second approval is bound to the exact transaction ID above.</p><label>Type transaction-specific broadcast phrase: {deploymentOperation.broadcastApproval?.confirmationPhrase}<input value={broadcastConfirmationPhrase} onChange={event => setBroadcastConfirmationPhrase(event.target.value)} autoComplete="off" spellCheck="false" placeholder={deploymentOperation.broadcastApproval?.confirmationPhrase}/></label><button type="button" className="primary-button" disabled={!walletReady || !deploymentExecutionEnabled || busy || !deploymentOperation.broadcastApproval || broadcastConfirmationPhrase !== deploymentOperation.broadcastApproval.confirmationPhrase} onClick={broadcastApprovedDeployment}>Broadcast this exact approved transaction</button></>}
          <div className="button-row"><button type="button" className="outline-button" disabled={!walletReady || busy} onClick={refreshDeploymentStatus}><RefreshCw size={15}/> Reconcile status</button></div>
          {!deploymentExecutionEnabled && <p className="fine-print">Signing and broadcast remain locked until database durability, backup/restore and independent production acceptance gates pass. A separate transaction-specific phrase is required before any broadcast.</p>}
        </div>}
      </div>}
      {show('portfolio') && <div className="trax-deploy-actions"><button type="button" className="secondary-button" disabled={!walletReady || busy || !tokenAddress} onClick={refresh}><RefreshCw size={15}/> Refresh Mainnet state</button></div>}
      {!show('portfolio', 'deploy', 'withdraw') && tokenAddress && <div className="trax-deploy-actions"><button type="button" className="secondary-button" disabled={!walletReady || busy} onClick={refresh}><RefreshCw size={15}/> Refresh contract state</button></div>}
    </div>

    {show('portfolio') && <>
      <div className="trax-actions trax-portfolio" aria-label="Combined wallet portfolio valuation">
        <h3>Owner wallet portfolio</h3>
        <p className="fine-print">Separate quantities and clearly labelled reference valuations for native TRX, TRӾ and official USDT.</p>
        <div className="trax-stats">
          <article><span>Native TRX</span><b>{snapshot ? formatTokenUnits(snapshot.ownerTrx) : 'Refresh contract state'} TRX</b><small>{referencePrice && snapshot ? 'Market price ' + formatUsdPrecise(referencePrice.trxUsd) : 'Live quote unavailable'}</small></article>
          <article><span><TraxTokenMark/> TRӾ reference value</span><b>{snapshot ? formatTokenUnits(snapshot.ownerBalance) : 'Refresh contract state'} TRӾ</b><small>No verified TRӾ market quote</small></article>
          <article><span>Official USDT · TRC20</span><b>{snapshot ? formatTokenUnits(snapshot.ownerUsdt) : 'Refresh contract state'} USDT</b><small>{referencePrice && snapshot ? 'Market reference ' + formatUsdPrecise(referencePrice.usdtUsd) : 'Live quote unavailable'}</small></article>
        </div>
        <div className="trax-balance-note"><b>Estimated combined portfolio value: </b>{snapshot && referencePrice ? formatUsd(calculatePortfolioValue({ trx: formatTokenUnits(snapshot.ownerTrx), trax: formatTokenUnits(snapshot.ownerBalance), usdt: formatTokenUnits(snapshot.ownerUsdt), prices: referencePrice })?.totalUsd) : 'Unavailable — refresh when live prices are available'}</div>
        <p className="fine-print">{referencePrice ? 'TRX/USD: ' + formatUsd(referencePrice.trxUsd) + ' · USDT/USD: ' + formatUsd(referencePrice.usdtUsd) + ' · ' + referencePrice.source + ' · ' + new Date(referencePrice.updatedAt).toLocaleString() : 'Live prices unavailable or stale.'} TRӾ has no verified market quote. Combined USD valuation is withheld whenever TRӾ holdings are non-zero; no price is inferred from native TRX.</p>
      </div>
      <WalletDepositPanel role="Owner" address={connectedAddress} addressHex={readOnlyTronWeb.address.toHex(connectedAddress)} transactions={ownerDepositHistory.transactions} tokenTransfers={ownerDepositHistory.tokenTransfers} transactionsAvailable={ownerDepositHistory.transactionsAvailable} tokenTransfersAvailable={ownerDepositHistory.tokenTransfersAvailable} onRefresh={refreshOwnerDeposits} refreshing={ownerDepositLoading}/>
      <div className="trax-actions">
        <div className="trax-section-title"><h3>Live on-chain contract status</h3><button className="outline-button" disabled={!walletReady || busy || !tokenAddress} onClick={refresh}><RefreshCw size={14}/> Refresh</button></div>
        {snapshot ? <div className="trax-stats">
          <article><span>Total TRӾ supply</span><b>{formatTokenUnits(snapshot.totalSupply)} TRӾ</b></article>
          <article><span>Owner wallet balance</span><b>{formatTokenUnits(snapshot.ownerBalance)} TRӾ</b></article>
          <article><span>Owner issuance</span><b>{snapshot.mintingEnabled ? 'Enabled' : 'Disabled'}</b></article>
          <article><span>Transfers</span><b>{snapshot.paused ? 'Paused' : 'Active'}</b></article>
        </div> : <p className="fine-print">Refresh the contract to read its current solidified Mainnet state.</p>}
        {snapshot && <div className="trax-checks"><span className={snapshot.valid ? 'ok' : 'bad'}>{snapshot.valid ? '✓' : '!'} {snapshot.name} / {snapshot.symbol} / {snapshot.decimals} decimals</span><span className={snapshot.ownerValid ? 'ok' : 'bad'}>{snapshot.ownerValid ? '✓' : '!'} On-chain owner matches wallet</span><span className="bad">! No backing or redemption</span></div>}
      </div>
    </>}

    {show('withdraw') && <div className="trax-actions" aria-label="Official USDT withdrawal">
      <h3>Withdraw official USDT · TRC20</h3>
      <p className="fine-print">Asset: USDT · Mainnet contract: {OFFICIAL_USDT_MAINNET_CONTRACT} · 6 decimals. The Owner wallet signs locally; the Resource API checks the exact transfer, resource budget, Owner permission and solidified receipt. Network fees are paid in native TRX from the Owner wallet and are never taken from the USDT amount.</p>
      <div className="trax-stats">
        <article><span>Owner official USDT balance</span><b>{usdtWithdrawalBalance === null ? 'Not refreshed' : formatTokenUnits(usdtWithdrawalBalance) + ' USDT'}</b><small>{usdtWithdrawalBalanceAt ? 'Read at ' + new Date(usdtWithdrawalBalanceAt).toLocaleString() : 'Live Mainnet balance required before preparation'}</small></article>
        <article><span>Reserved for prepared / unresolved transfers</span><b>{formatTokenUnits(usdtWithdrawalReservedBalance)} USDT</b><small>Active reservations are deducted before new withdrawals</small></article>
        <article><span>Available for a new withdrawal</span><b>{usdtWithdrawalAvailableBalance === null ? 'Not calculated' : formatTokenUnits(usdtWithdrawalAvailableBalance) + ' USDT'}</b><small>Balance minus active reservations</small></article>
        <article><span>Native TRX for network fees</span><b>{usdtWithdrawalTrxBalanceSun === null ? 'Not refreshed' : formatTokenUnits(usdtWithdrawalTrxBalanceSun) + ' TRX'}</b><small>Energy and Bandwidth are checked separately during preflight</small></article>
        <article><span>Network</span><b>TRON Mainnet</b><small>No testnet or alternate token contract</small></article>
      </div>
      <div className="button-row"><button type="button" className="secondary-button" disabled={!walletReady || busy} onClick={refreshUsdtWithdrawalBalance}><RefreshCw size={14}/> Refresh USDT balance</button></div>
      <label>Recipient TRON Mainnet address<input value={usdtWithdrawalRecipient} onChange={event => setUsdtWithdrawalRecipient(event.target.value)} autoComplete="off" spellCheck="false" placeholder="T…"/></label>
      <label>Withdrawal amount (USDT)<input value={usdtWithdrawalAmount} onChange={event => setUsdtWithdrawalAmount(event.target.value)} inputMode="decimal" placeholder="0.00"/></label>
      <div className="trax-balance-note">Six decimal places · Requested base units: {(() => { try { return parseTokenUnits(usdtWithdrawalAmount) } catch { return '—' } })()}</div>
      <button type="button" className="primary-button" disabled={!walletReady || busy || !usdtWithdrawalRecipient.trim() || !usdtWithdrawalAmount.trim() || !feeCapSun} onClick={prepareUsdtWithdrawal}><ArrowUpRight size={15}/> Review official USDT withdrawal</button>
      <p className="fine-print">Preparation is unsigned. The next screen displays the exact recipient, amount, fee ceiling and Mainnet resource estimate. A separate explicit confirmation is required. Insufficient Energy, Bandwidth, TRX fallback or database readiness blocks signing. An ambiguous broadcast is reconciled by transaction ID; it is never automatically retried.</p>
      <a href={'https://tronscan.org/#/contract/' + OFFICIAL_USDT_MAINNET_CONTRACT} target="_blank" rel="noreferrer">Official USDT contract on TRONSCAN <ExternalLink size={12}/></a>

      <div className="trax-history">
        <h4>Recent official USDT withdrawals</h4>
        {!usdtWithdrawalHistory.length ? <p className="fine-print">No official USDT withdrawals are recorded in the Owner operation ledger yet.</p> : <div className="transaction-list">
          {usdtWithdrawalHistory.map(item => <article className="transaction-row" key={item.operationId}>
            <div><b>{formatTokenUnits(item.args?.[1] || '0')} USDT</b><span>To {item.args?.[0] || 'Unknown recipient'}</span></div>
            <div><b>{String(item.state || 'unknown').replaceAll('-', ' ')}</b><span>{item.blockNumber ? 'Solidified block ' + item.blockNumber : item.transactionId ? 'Transaction submitted' : 'No transaction broadcast'}</span></div>
            <div>{item.transactionId ? <a href={'https://tronscan.org/#/transaction/' + item.transactionId} target="_blank" rel="noreferrer">{item.transactionId.slice(0, 12)}… <ExternalLink size={11}/></a> : <span>{item.failureCode || 'Awaiting transaction'}</span>}</div>
          </article>)}
        </div>}
      </div>
    </div>}

    {show('issuance') && <div className="trax-actions">
      <h3>Owner issuance overview</h3>
      <div className="trax-stats"><article><span>Total supply</span><b>{snapshot ? formatTokenUnits(snapshot.totalSupply) + ' TRӾ' : 'Not loaded'}</b></article><article><span>Owner authorization</span><b>{snapshot ? snapshot.mintingEnabled ? 'Enabled' : 'Disabled' : 'Not loaded'}</b></article><article><span>Transfer status</span><b>{snapshot ? snapshot.paused ? 'Paused' : 'Active' : 'Not loaded'}</b></article></div>
      <p className="fine-print">Owner issuance can create new TRӾ up to the uint256 supply limit. The limit is finite, and issuing additional supply can dilute holders. Every mint requires Energy and Bandwidth; minting does not require TRX collateral or a reserve deposit.</p>
      <label>Amount to issue to owner wallet (TRӾ)<input value={ownerIssueAmount} onChange={e => setOwnerIssueAmount(e.target.value)} inputMode="decimal"/></label>
      <div className="trax-balance-note">Raw token units (6 decimals): {(() => { try { return parseTokenUnits(ownerIssueAmount) } catch { return '—' } })()}</div>
      <div className="button-row"><button type="button" className="primary-button" disabled={!walletReady || busy || !tokenAddress || !snapshot?.mintingEnabled || snapshot?.paused || !feeCapSun} onClick={issueOwnerSupply}><Coins size={14}/> Issue to my owner wallet</button><button type="button" className="outline-button" disabled={!walletReady || busy || !tokenAddress} onClick={refresh}><RefreshCw size={14}/> Refresh issuance state</button></div>
    </div>}

    {show('credits') && <div className="trax-actions">
      <h3>External wallet credit</h3>
      <p className="fine-print">Mint new TRӾ directly to a valid TRON Mainnet address. Recipient ownership signatures are not needed to receive tokens; the configured Owner session reviews and confirms the issuance operation.</p>
      <label>Recipient TRON Mainnet address<input value={recipient} onChange={e => setRecipient(e.target.value)} autoComplete="off" spellCheck="false" placeholder="T…"/></label>
      <label>Amount to issue (TRӾ)<input value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" placeholder="100"/></label>
      <div className="trax-balance-note">Raw token units (6 decimals): {(() => { try { return parseTokenUnits(amount) } catch { return '—' } })()}</div>
      <button type="button" className="primary-button" disabled={!walletReady || busy || !tokenAddress || !snapshot?.mintingEnabled || snapshot?.paused || !feeCapSun} onClick={issueCredit}><Coins size={15}/> Review &amp; issue credit</button>
      <p className="fine-print">This credits the recipient's on-chain TRӾ balance. It does not force an exchange to recognize or credit its internal customer account.</p>
    </div>}

    {show('batch') && <div className="trax-actions">
      <h3>Batch wallet credits</h3>
      <p className="fine-print">Issue multiple recipient credits in one contract call. Maximum 50 addresses per batch. Review every address and amount before requesting backend Owner confirmation.</p>
      <label>Recipient list (one TRON_ADDRESS,AMOUNT per line)<textarea value={batchInput} onChange={e => setBatchInput(e.target.value)} rows={7} placeholder={'TAddressOne,100\nTAddressTwo,250'}/></label>
      <div className="trax-balance-note">Maximum 50 rows · Amounts use six token decimals.</div>
      <button type="button" className="primary-button" disabled={!walletReady || busy || !tokenAddress || !snapshot?.mintingEnabled || snapshot?.paused || !feeCapSun || !batchInput.trim()} onClick={batchCredit}>Review &amp; batch-credit addresses</button>
    </div>}

    {show('pause') && <div className="trax-actions">
      <h3>Emergency transfer controls</h3>
      <div className={snapshot?.paused ? 'trax-state-banner warning' : 'trax-state-banner success'}><b>{snapshot ? snapshot.paused ? 'Transfers currently paused' : 'Transfers currently active' : 'Contract state not loaded'}</b><span>{snapshot ? snapshot.paused ? 'Token transfers and owner issuance are blocked until the owner unpauses.' : 'Transfers are available subject to normal TRC-20 balances and allowances.' : 'Refresh contract state before making an emergency change.'}</span></div>
      <div className="button-row"><button type="button" className="primary-button" disabled={!walletReady || busy || !tokenAddress || !snapshot || snapshot.paused || !feeCapSun} onClick={pause}>Emergency pause transfers</button><button type="button" className="outline-button" disabled={!walletReady || busy || !tokenAddress || !snapshot?.paused || !feeCapSun} onClick={unpauseTransfers}>Unpause transfers</button></div>
      <p className="fine-print">Only the current on-chain owner can change pause state. Both actions require separate backend Owner confirmation and sufficient Mainnet network resources.</p>
    </div>}

    {show('minting') && <div className="trax-actions">
      <h3>Owner minting authorization</h3>
      <div className={snapshot?.mintingEnabled ? 'trax-state-banner success' : 'trax-state-banner warning'}><b>{snapshot ? snapshot.mintingEnabled ? 'Owner issuance enabled' : 'Owner issuance disabled' : 'Contract state not loaded'}</b><span>{snapshot ? snapshot.mintingEnabled ? 'The authorized owner can issue new TRӾ.' : 'New owner credits are blocked until minting is enabled.' : 'Refresh contract state before changing authorization.'}</span></div>
      <div className="button-row"><button type="button" className="primary-button" disabled={!walletReady || busy || !tokenAddress || !snapshot || snapshot.mintingEnabled || !feeCapSun} onClick={enableMinting}>Enable owner minting</button><button type="button" className="outline-button" disabled={!walletReady || busy || !tokenAddress || !snapshot?.mintingEnabled || !feeCapSun} onClick={disableMinting}>Disable owner minting</button></div>
      <p className="fine-print">Disabling minting prevents new issuance but does not destroy existing tokens. Only the on-chain owner can change this setting.</p>
    </div>}

    {show('transfers') && <div className="trax-actions">
      <h3>Transfer existing TRӾ</h3>
      <p className="fine-print">This sends existing TRӾ from the connected owner wallet; it does not mint new supply. The connected owner must hold enough TRӾ, and the transaction needs network resources.</p>
      <label>Recipient TRON Mainnet address<input value={recipient} onChange={e => setRecipient(e.target.value)} autoComplete="off" spellCheck="false" placeholder="T…"/></label>
      <label>Amount to transfer (TRӾ)<input value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal"/></label>
      <button type="button" className="primary-button" disabled={!walletReady || busy || !tokenAddress || !feeCapSun} onClick={transfer}><ArrowUpRight size={15}/> Review &amp; transfer existing balance</button>
    </div>}

    {show('ownership') && <TRAXOwnershipControls wallet={panelWallet} tokenAddress={tokenAddress} feeCapSun={feeCapSun} busy={busy} getToken={getToken} run={run} onPrepareOperation={prepareOwnerOperation}/>}

    {show('history') && <div className="trax-actions">
      <div className="trax-section-title"><h3>Durable Owner operation journal</h3><button type="button" className="outline-button" disabled={!walletReady || busy} onClick={refreshOwnerOperations}><RefreshCw size={14}/> Refresh journal</button></div>
      <p className="fine-print">Owner-identity-scoped Mainnet operation records, recoverable from any authenticated Owner password session. Signed and broadcast-unknown transactions are reconciled by transaction ID; they are never automatically re-signed or rebroadcast.</p>
      {recentOperations.length === 0 ? <p className="fine-print">No Owner operations loaded. Refresh the durable journal to recover prepared intents and transaction receipts.</p> : <div className="trax-history-list">{recentOperations.map(operation => <article className="trax-history-item" key={operation.operationId}>
        <div><b>{operation.operationType} · {operation.state}</b><small>{operation.method || 'Contract operation'} · {operation.createdAt ? new Date(operation.createdAt).toLocaleString() : 'Time unavailable'}</small><small>Operation: {operation.operationId}</small>{operation.transactionId && <small>Transaction: {operation.transactionId}</small>}{operation.failureCode && <small>Result: {operation.failureCode}</small>}</div>
        <button type="button" className="outline-button" disabled={busy} onClick={() => checkOwnerOperation(operation.operationId)}>Recover / check receipt</button>
      </article>)}</div>}
    </div>}
    {show('history') && <TRAXCreditHistory wallet={panelWallet} tokenAddress={tokenAddress} run={run} busy={busy}/>}

    {show('balance') && <div className="trax-actions">
      <h3>External wallet balance lookup</h3>
      <p className="fine-print">Read the contract's actual TRӾ balance for any TRON Mainnet address. This is a read-only contract query; it does not credit or transfer tokens.</p>
      <label>TRON Mainnet address<input value={lookupAddress} onChange={e => setLookupAddress(e.target.value)} autoComplete="off" spellCheck="false" placeholder="T…"/></label>
      <button type="button" className="secondary-button" disabled={!walletReady || busy || !tokenAddress} onClick={readBalance}><RefreshCw size={14}/> Read on-chain TRӾ balance</button>
      {lookupBalance !== '' && <div className="trax-recipient-result"><b>{formatTokenUnits(lookupBalance)} TRӾ</b><span>{lookupAddress}</span><p>Native TRX: {formatTokenUnits(lookupNativeBalance)} · Official USDT: {formatTokenUnits(lookupUsdtBalance)}</p><b>Combined estimated portfolio value: {lookupPortfolioValue ? formatUsd(lookupPortfolioValue.totalUsd) : 'Unavailable — live quote missing or stale'}</b><small>TRӾ valuation is an owner-defined reference only, not a verified market trading price.</small></div>}
    </div>}

    {pendingOperation && <div className="trax-actions" role="region" aria-label="Review Owner Mainnet operation">
      <h3>{pendingOperation.operationType === 'usdt-transfer' ? 'Review official USDT Mainnet withdrawal' : 'Review guarded TRӾ Mainnet operation'}</h3>
      <p><b>{pendingOperation.summary || pendingOperation.operationType}</b></p>
      <p className="fine-print">Operation ID: {pendingOperation.operationId}</p>
      <p className="fine-print">Exact intent SHA-256: {pendingOperation.intentSha256}</p>
      {pendingOperation.operationType === 'usdt-transfer' && <p><b>{formatTokenUnits(pendingOperation.args?.[1] || '0')} USDT</b> to {pendingOperation.args?.[0]}</p>}
      <details><summary>Inspect exact contract method and arguments</summary>
        {pendingOperation.operationType === 'batch-credit' && Array.isArray(pendingOperation.args?.[0]) && <ol>{pendingOperation.args[0].map((address, index) => <li key={address + ':' + index}>{address} · {formatTokenUnits(pendingOperation.args?.[1]?.[index] || '0')} TRӾ · reference {pendingOperation.args?.[2]?.[index]}</li>)}</ol>}
        <pre>{JSON.stringify({ method: pendingOperation.method, args: pendingOperation.args, feeLimitSun: pendingOperation.feeLimitSun || pendingOperation.preflight?.feeLimitSun }, null, 2)}</pre>
      </details>
      <p className="fine-print">TRON Mainnet · Owner / fee payer: {pendingOperation.ownerAddress} · Contract: {pendingOperation.contractAddress}</p>
      {pendingOperation.preflight && <div className="trax-checks">
        <span>Energy required: {pendingOperation.preflight.requiredEnergyWithSafetyMargin || pendingOperation.preflight.estimatedEnergy}</span>
        <span>Energy available: {pendingOperation.preflight.availableEnergy}</span>
        <span>Bandwidth bytes: {pendingOperation.preflight.transactionBytes}</span>
        <span>Bandwidth available: {pendingOperation.preflight.availableBandwidth}</span>
        <span>Estimated TRX fallback: {pendingOperation.preflight.estimatedTrxFallbackSun} SUN</span>
      </div>}
      <div className={pendingOperation.executionEnabled ? 'trax-state-banner success' : 'trax-state-banner warning'}>
        <b>{pendingOperation.executionEnabled ? 'Execution gates enabled' : 'Execution remains disabled'}</b>
        <span>{pendingOperation.executionEnabled ? 'The backend will repeat contract, permission and resource checks immediately before signing.' : 'This prepared intent is review-only until verified database durability and the separate Mainnet execution acknowledgement are configured.'}</span>
      </div>
      {pendingOperation.state === 'awaiting-confirmation' && pendingOperation.executionEnabled && <label>Type the exact confirmation phrase: {pendingOperation.confirmationPhrase}<input value={confirmationPhrase} onChange={event => setConfirmationPhrase(event.target.value)} autoComplete="off" spellCheck="false"/></label>}
      {pendingOperation.transactionId && <p className="fine-print">Transaction ID: {pendingOperation.transactionId} · State: {pendingOperation.state}</p>}
      <div className="button-row">
        <button type="button" className="primary-button" disabled={busy || !pendingOperation.executionEnabled || pendingOperation.state !== 'awaiting-confirmation' || confirmationPhrase !== pendingOperation.confirmationPhrase} onClick={confirmOwnerOperation}>Confirm exact operation &amp; submit</button>
        {pendingOperation.transactionId && <button type="button" className="outline-button" disabled={busy} onClick={refreshPendingOperation}>Refresh receipt status</button>}
        <button type="button" className="outline-button" disabled={busy || pendingOperation.state !== 'awaiting-confirmation'} onClick={cancelOwnerOperation}>Cancel prepared operation</button>
      </div>
      <p className="fine-print">A signed or broadcast-unknown transaction is never automatically re-signed or rebroadcast. Its transaction ID must be reconciled against a solidified Mainnet receipt.</p>
    </div>}
    {lastTx && <div className="notice notice-success trax-last-tx"><CheckCircle2 size={16}/><div><b>Solidified Mainnet transaction verified</b><p>{lastTx}</p><a href={'https://tronscan.org/#/transaction/' + lastTx} target="_blank" rel="noreferrer">Open transaction on TRONSCAN <ExternalLink size={12}/></a></div></div>}
    {tokenAddress && !show('withdraw') && <div className="notice trax-contract-explorer"><div><b>Saved TRӾ Mainnet contract</b><p>{tokenAddress}</p><a href={'https://tronscan.org/#/contract/' + tokenAddress} target="_blank" rel="noreferrer">Open contract on TRONSCAN <ExternalLink size={12}/></a><small>Explorer visibility is not the same as source-code verification. Confirm the deployed address and submit source verification using the exact compiler settings and constructor data.</small></div></div>}
    <div className="trax-footer-links"><a href="https://developers.tron.network/docs/trc20-protocol-interface" target="_blank" rel="noreferrer">TRON TRC-20 standard <ExternalLink size={12}/></a><a href="https://tronscan.org/#/token20" target="_blank" rel="noreferrer">TRONSCAN token directory <ExternalLink size={12}/></a></div>
  </section>
}
