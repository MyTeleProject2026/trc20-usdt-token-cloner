import { useState, useEffect } from 'react'
import { TronWeb } from 'tronweb'
import { tokenArtifact } from './generated/IndependentTRC20'
import TransferSimulator from './TransferSimulator'
import ReceiverHistory from './ReceiverHistory'
import SponsorshipStatus from './SponsorshipStatus'
import SponsorProviderPage, { TokenSelectionPage } from './SponsorProviderPages'
import {
  Coins,
  Send,
  Search,
  CheckCircle2,
  AlertCircle,
  Copy,
  Code2,
  ShieldCheck,
  Zap,
  RefreshCw,
  Layers,
  Key
} from 'lucide-react'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '')

export default function App() {
  const [network, setNetwork] = useState<'shasta' | 'mainnet'>('shasta')
  const [activeTab, setActiveTab] = useState<'choose' | 'sponsors' | 'deploy' | 'interact' | 'trx' | 'simulation' | 'verify' | 'contract'>('choose')
  const [selectedAsset, setSelectedAsset] = useState<'VTRC' | 'TRX' | 'USDT'>('VTRC')
  const [copied, setCopied] = useState<string | null>(null)

  // System status
  const [apiStatus, setApiStatus] = useState<string>('checking')
  const [tronBlock, setTronBlock] = useState<{ blockNumber?: number; hash?: string } | null>(null)

  // Deploy state
  const [tokenName, setTokenName] = useState('TRC20')
  const [tokenSymbol, setTokenSymbol] = useState('VTRC')
  const [tokenDecimals, setTokenDecimals] = useState('18')
  const [initialSupply, setInitialSupply] = useState('1000000')
  const [recipient, setRecipient] = useState('')
  const [deploying, setDeploying] = useState(false)
  const [deployResult, setDeployResult] = useState<{
    success?: boolean
    txId?: string
    contractAddress?: string
    message?: string
    error?: string
    preparedPayload?: any
  } | null>(null)

  // Interact state
  const [contractAddress, setContractAddress] = useState('')
  const [queryAddress, setQueryAddress] = useState('')
  const [recipientAddress, setRecipientAddress] = useState('')
  const [transferAmount, setTransferAmount] = useState('1')
  const [trxAmount, setTrxAmount] = useState('1')
  const [trxTransferring, setTrxTransferring] = useState(false)
  const [nativeBalanceLoading, setNativeBalanceLoading] = useState(false)
  const [nativeBalanceResult, setNativeBalanceResult] = useState<any>(null)
  const [nativeTransferRecord, setNativeTransferRecord] = useState<any>(null)
  const [nativeVerifyLoading, setNativeVerifyLoading] = useState(false)
  const [nativeVerifyResult, setNativeVerifyResult] = useState<any>(null)
  const [tokenBalanceLoading, setTokenBalanceLoading] = useState(false)
  const [tokenBalanceResult, setTokenBalanceResult] = useState<any>(null)
  const [tokenTransferRecord, setTokenTransferRecord] = useState<any>(null)
  const [tokenVerifyLoading, setTokenVerifyLoading] = useState(false)
  const [tokenVerifyResult, setTokenVerifyResult] = useState<any>(null)
  const [verifiedTransferLookup, setVerifiedTransferLookup] = useState<any>(null)
  const [verifiedTransferLookupLoading, setVerifiedTransferLookupLoading] = useState(false)
  const [privateKey, setPrivateKey] = useState('')
  const [walletAddress, setWalletAddress] = useState('')
  const [walletConnected, setWalletConnected] = useState(false)
  const [showPrivateKey, setShowPrivateKey] = useState(false)
  const [accountData, setAccountData] = useState<any>(null)
  const [transactionHistory, setTransactionHistory] = useState<any[]>([])
  const [loadingDetails, setLoadingDetails] = useState(false)
  const [transferring, setTransferring] = useState(false)
  const [actionMessage, setActionMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // Verify state
  const [verifyTxId, setVerifyTxId] = useState('')
  const [verifyResult, setVerifyResult] = useState<any>(null)
  const [verifying, setVerifying] = useState(false)

  const fetchStatus = async () => {
    try {
      const fullHost = network === 'shasta' ? 'https://api.shasta.trongrid.io' : 'https://api.trongrid.io'
      const [blockResult, providerResult] = await Promise.allSettled([
        new TronWeb({ fullHost }).trx.getCurrentBlock(),
        fetch(`${API_BASE}/api/status`).then((response) => response.json()),
      ])
      if (blockResult.status === 'fulfilled') {
        const block: any = blockResult.value
        const raw = block?.block_header?.raw_data
        setTronBlock({ blockNumber: raw?.number, hash: block?.blockID })
      }
      if (providerResult.status === 'fulfilled') setApiStatus(providerResult.value?.status || 'connected')
      else setApiStatus('connected')
    } catch {
      setApiStatus('error')
    }
  }

  useEffect(() => {
    // A network switch invalidates the prior wallet/network pairing. Require an
    // explicit reconnect and discard network-specific account details before
    // any subsequent transfer or balance lookup.
    setTronBlock(null)
    setWalletConnected(false)
    setAccountData(null)
    fetchStatus()
  }, [network])

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied(null), 2000)
  }

  // Connect to TronLink. The wallet retains the private key and asks for approval
  // for every state-changing transaction.
  const assertSelectedTronLinkNetwork = (tronWeb: any) => {
    const host = String(tronWeb.fullNode?.host || tronWeb.fullNode?.nodeUrl || '').toLowerCase()
    if (network === 'shasta' && !host.includes('shasta')) {
      throw new Error('Safety check: TronLink must be connected to the Shasta testnet node for a Shasta transaction.')
    }
    if (network === 'mainnet' && (!host.includes('api.trongrid.io') || host.includes('shasta') || host.includes('nile'))) {
      throw new Error('Safety check: Mainnet sending requires TronLink connected to the recognized TRON Mainnet node. Unknown/custom network endpoints are blocked in this workflow.')
    }
  }

  const getInjectedTronWeb = async () => {
    const provider = (window as any).tron
    if (!provider) throw new Error('TronLink was not detected. Open this site in a browser with TronLink installed.')
    if (typeof provider.request === 'function') {
      await provider.request({ method: 'eth_requestAccounts' })
    }
    const tronWeb = provider.tronWeb
    if (!tronWeb || !tronWeb.defaultAddress?.base58) throw new Error('TronLink did not provide an authorized account. Unlock the wallet and approve connection.')
    return tronWeb
  }

  const handleConnectWallet = async () => {
    try {
      const tronWeb = await getInjectedTronWeb()
      const address = tronWeb.defaultAddress.base58
      assertSelectedTronLinkNetwork(tronWeb)
      setWalletAddress(address)
      setQueryAddress(address)
      setWalletConnected(true)
      setActionMessage({ type: 'success', text: `TronLink connected: ${address}. Review every transaction in the wallet before approving.` })
    } catch (err: any) {
      setWalletConnected(false)
      setActionMessage({ type: 'error', text: err?.message || 'Could not connect to TronLink.' })
    }
  }

  const handleGenerateWallet = async () => {
    try {
      const fullHost = network === 'shasta' ? 'https://api.shasta.trongrid.io' : 'https://api.trongrid.io'
      const tronWeb = new TronWeb({ fullHost })
      const account: any = await tronWeb.createAccount()
      const address = account?.address?.base58
      const key = account?.privateKey
      if (!address || !key) throw new Error('The wallet provider did not return a complete account.')
      setWalletAddress(address)
      setPrivateKey(key)
      setQueryAddress(address)
      setRecipient(address)
      setActionMessage({ type: 'success', text: `New ${network === 'shasta' ? 'Shasta testnet' : 'TRON Mainnet'} wallet generated locally: ${address}. Back up the private key securely before leaving this page.` })
    } catch (err: any) {
      setActionMessage({ type: 'error', text: err?.message || 'Could not generate a local TRON wallet.' })
    }
  }


  const handleDeploy = async () => {
    if (network !== 'shasta') {
      setDeployResult({ success: false, error: 'testnet-only', message: 'Token deployment is restricted to Shasta Testnet in this testing workspace. No Mainnet deployment is enabled.' })
      return
    }
    setDeploying(true)
    setDeployResult(null)
    try {
      if (!privateKey.trim()) throw new Error('Enter your wallet private key in the local-signing field. It is used only in this browser and is never sent to the backend.')
      if (!recipient.trim()) throw new Error('Enter the address that should receive the initial supply.')
      if (!/^[1-9][0-9]*$/.test(initialSupply)) throw new Error('Initial supply must be a positive whole-token integer.')
      if (Number(tokenDecimals) !== 18) throw new Error('This VTRC contract template uses 18 decimals.')
      if (tokenName.trim() !== 'TRC20' || tokenSymbol.trim() !== 'VTRC') {
        throw new Error('This deployment template is intentionally fixed to its independent identity: TRC20 / VTRC. It cannot be used to impersonate official Tether USDT.')
      }
      const fullHost = network === 'shasta' ? 'https://api.shasta.trongrid.io' : 'https://api.trongrid.io'
      const tronWeb = new TronWeb({ fullHost, privateKey: privateKey.trim() })
      if (!tronWeb.isAddress(recipient.trim())) throw new Error('Enter a valid TRON Base58 recipient address.')
      setWalletAddress(tronWeb.defaultAddress.base58 || '')
      const contract = await tronWeb.contract().new({
        abi: tokenArtifact.abi as any,
        bytecode: tokenArtifact.bytecode,
        feeLimit: 1_000_000_000,
        callValue: 0,
        userFeePercentage: 100,
        originEnergyLimit: 10_000_000,
        parameters: [tokenName.trim(), tokenSymbol.trim(), initialSupply, recipient.trim()],
      })
      const contractAddress = (contract as any).address
      const txId = (contract as any).transaction?.txID || (contract as any).transaction?.txid || ''
      if (!contractAddress) throw new Error('The deployment request returned no contract address. Check the transaction and network explorer.')
      setDeployResult({
        success: true,
        txId,
        contractAddress,
        message: 'Contract deployment submitted. Confirm the transaction on the selected TRON network before relying on the address.',
      })
      setContractAddress(contractAddress)
    } catch (err: any) {
      setDeployResult({ success: false, error: 'deployment-failed', message: err?.message || 'Deployment failed. Check the network, wallet funds, and fee limit.' })
    } finally {
      setDeploying(false)
    }
  }

  const handleQueryAccount = async () => {
    if (!queryAddress.trim()) {
      setActionMessage({ type: 'error', text: 'Enter a TRON address to query.' })
      return
    }
    const selectedHost = network === 'shasta' ? 'https://api.shasta.trongrid.io' : 'https://api.trongrid.io'
    if (!new TronWeb({ fullHost: selectedHost }).isAddress(queryAddress.trim())) {
      setActionMessage({ type: 'error', text: 'Enter a valid TRON address. TRC-20 transfers work with valid TRON addresses, but a receiver platform must support Shasta and this specific token contract to display or credit it.' })
      return
    }
    setLoadingDetails(true)
    setAccountData(null)
    setActionMessage(null)
    try {
      const fullHost = network === 'shasta' ? 'https://api.shasta.trongrid.io' : 'https://api.trongrid.io'
      let account: any = null
      // Tatum's configured TRON account endpoint is mainnet-oriented. Do not let
      // its response override the selected Shasta testnet account.
      if (network === 'mainnet') {
        try {
          const providerResponse = await fetch(`${API_BASE}/api/tron/account/${encodeURIComponent(queryAddress.trim())}`)
          const providerPayload = await providerResponse.json()
          if (providerResponse.ok && providerPayload?.success && providerPayload.data) account = providerPayload.data
        } catch {
          // Fall back to the selected public TRON endpoint if the provider is unavailable.
        }
      }
      if (!account) {
        const response = await fetch(`${fullHost}/v1/accounts/${encodeURIComponent(queryAddress.trim())}`)
        if (!response.ok) throw new Error(`TRON provider returned HTTP ${response.status}`)
        const payload = await response.json()
        account = payload?.data?.[0] || {}
      }
      const historyResponse = await fetch(`${fullHost}/v1/accounts/${encodeURIComponent(queryAddress.trim())}/transactions/trc20?limit=20&only_confirmed=true`)
      if (historyResponse.ok) {
        const historyPayload = await historyResponse.json()
        setTransactionHistory(Array.isArray(historyPayload?.data) ? historyPayload.data : [])
      } else {
        setTransactionHistory([])
      }
      const rawTokens = account.trc20 || []
      const trc20 = Array.isArray(rawTokens)
        ? rawTokens.flatMap((entry: any) => {
            if (entry?.contractAddress || entry?.contract_address) {
              return [{ contractAddress: entry.contractAddress || entry.contract_address, balance: String(entry.balance ?? entry.tokenBalance ?? entry.amount ?? '0'), symbol: entry.symbol || '' }]
            }
            return Object.entries(entry || {}).map(([tokenContract, balance]) => ({ contractAddress: tokenContract, balance: String(balance), symbol: '' }))
          })
        : Object.entries(rawTokens).map(([tokenContract, balance]) => ({ contractAddress: tokenContract, balance: String(balance), symbol: '' }))

      // Query the selected token contract directly as well as the account index.
      // This makes balances for a newly deployed/custom Shasta token visible even
      // when a public account indexer has not listed that token yet.
      if (contractAddress.trim() && new TronWeb({ fullHost }).isAddress(contractAddress.trim())) {
        try {
          const readOnlyTronWeb = new TronWeb({ fullHost })
          const tokenContract: any = await readOnlyTronWeb.contract().at(contractAddress.trim())
          const [rawBalance, decimalsValue, symbolValue] = await Promise.all([
            tokenContract.balanceOf(queryAddress.trim()).call(),
            tokenContract.decimals().call(),
            tokenContract.symbol().call().catch(() => 'TOKEN'),
          ])
          const decimals = Number(decimalsValue)
          if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
            throw new Error('Token contract returned an unsupported decimals value.')
          }
          const formattedBalance = readOnlyTronWeb.toBigNumber(String(rawBalance))
            .dividedBy(readOnlyTronWeb.toBigNumber(10).pow(decimals))
            .toFixed(Math.min(decimals, 8))
          const existingIndex = trc20.findIndex((item: any) =>
            String(item.contractAddress).toLowerCase() === contractAddress.trim().toLowerCase()
          )
          const directBalance = {
            contractAddress: contractAddress.trim(),
            balance: formattedBalance,
            symbol: String(symbolValue || 'TOKEN'),
            source: 'contract',
          }
          if (existingIndex >= 0) trc20[existingIndex] = directBalance
          else trc20.unshift(directBalance)
        } catch (tokenError: any) {
          // Keep the account's indexed holdings available if this contract is not
          // deployed on the selected network or does not expose TRC-20 methods.
        }
      }
      setAccountData({
        address: account.address || queryAddress.trim(),
        balance: Number(account.balance || 0),
        bandwidth: Number(account.free_net_usage || 0) + Number(account.net_usage || 0),
        trc20,
      })
    } catch (err: any) {
      setActionMessage({ type: 'error', text: err?.message || 'Failed to fetch account data from TRON.' })
    } finally {
      setLoadingDetails(false)
    }
  }

  const handleTransfer = async () => {
    if (selectedAsset === 'TRX') {
      setActionMessage({ type: 'error', text: 'The selected asset is native TRX. Use the native TRX workflow instead of the TRC-20 contract transfer form.' })
      return
    }
    if (selectedAsset === 'USDT') {
      setActionMessage({ type: 'error', text: 'USDT transfers are blocked from this workflow until a network-specific official-contract allowlist and verification gate are implemented. Do not bypass this chooser using the contract field.' })
      return
    }
    if (network !== 'shasta') {
      setActionMessage({ type: 'error', text: 'VTRC is an independent project token and this workflow currently permits VTRC transfers on Shasta testnet only. Switch to Shasta and verify the deployed VTRC contract.' })
      return
    }
    if (!contractAddress || !recipientAddress || !transferAmount) {
      setActionMessage({ type: 'error', text: 'Enter the token contract, recipient, and amount.' })
      return
    }
    const officialMainnetUsdt = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
    if (contractAddress.trim() === officialMainnetUsdt) {
      setActionMessage({ type: 'error', text: 'The selected asset is VTRC, but the entered contract is the known TRON Mainnet USDT address. Asset selection and contract do not match; transfer blocked.' })
      return
    }
    setTransferring(true)
    setActionMessage(null)
    try {
      const tronWeb = await getInjectedTronWeb()
      assertSelectedTronLinkNetwork(tronWeb)
      if (!tronWeb.isAddress(contractAddress) || !tronWeb.isAddress(recipientAddress)) {
        throw new Error('Enter valid TRON Base58 addresses for the token contract and recipient.')
      }
      if (network !== 'shasta') throw new Error('VTRC transfers are restricted to Shasta testnet in this workflow.')
      const sender = tronWeb.defaultAddress.base58
      if (!sender) throw new Error('TronLink has no authorized sender address.')
      setWalletAddress(sender)
      const contract = await tronWeb.contract().at(contractAddress.trim())
      const decimals = Number(await contract.decimals().call())
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
        throw new Error('The token contract returned an unsupported decimals value.')
      }
      const normalizedAmount = transferAmount.trim()
      if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalizedAmount)) {
        throw new Error('Enter a plain decimal token amount without signs or exponent notation.')
      }
      const fractionalDigits = normalizedAmount.includes('.') ? normalizedAmount.split('.')[1].length : 0
      if (fractionalDigits > decimals) throw new Error(`This token supports at most ${decimals} decimal places.`)
      const amount = tronWeb.toBigNumber(normalizedAmount)
      if (!amount.isFinite() || amount.lte(0)) throw new Error('Transfer amount must be greater than zero.')
      const rawAmount = amount.times(tronWeb.toBigNumber(10).pow(decimals)).toFixed(0)
      const senderBalance = BigInt(String(await contract.balanceOf(sender).call()))
      if (senderBalance < BigInt(rawAmount)) throw new Error('Sender token balance is insufficient for this transfer.')
      const tokenSymbolValue = String(await contract.symbol().call().catch(() => 'TRC-20'))
      const confirmation = 'Confirm TRC-20 transfer\nNetwork: ' + (network === 'shasta' ? 'Shasta testnet (test assets only)' : 'TRON MAINNET (real funds)') + '\nToken: ' + tokenSymbolValue + '\nContract: ' + contractAddress.trim() + '\nSender: ' + sender + '\nReceiver: ' + recipientAddress.trim() + '\nAmount: ' + normalizedAmount + ' (token decimals: ' + decimals + ')\n\nOnly proceed if the receiver supports this exact token and network. Exchange deposit credit is not guaranteed. Continue to TronLink approval?'
      if (!window.confirm(confirmation)) {
        setActionMessage({ type: 'error', text: 'Token transfer cancelled before signing.' })
        return
      }
      const txId = await contract.transfer(recipientAddress.trim(), rawAmount).send({
        feeLimit: 100_000_000,
        callValue: 0,
        shouldPollResponse: true,
      })
      const transactionId = typeof txId === 'string' ? txId : (txId as any)?.txid || (txId as any)?.transaction?.txID || JSON.stringify(txId)
      // Pre-fill the on-chain verifier for a real transaction hash. A wallet's
      // broadcast response is only submission; confirmation is checked separately.
      if (/^[0-9a-fA-F]{64}$/.test(transactionId)) setVerifyTxId(transactionId)
      setTokenTransferRecord({ network, transactionId, contractHex: tronWeb.address.toHex(contractAddress.trim()).replace(/^41/i, ''), fromHex: tronWeb.address.toHex(sender).replace(/^41/i, ''), toHex: tronWeb.address.toHex(recipientAddress.trim()).replace(/^41/i, ''), contractAddress: contractAddress.trim(), receiverAddress: recipientAddress.trim(), amountBaseUnits: rawAmount, tokenSymbol: tokenSymbolValue, amount: normalizedAmount })
      setTokenVerifyResult(null)
      setActionMessage({
        type: 'success',
        text: `Transfer submitted from ${sender}. Transaction: ${transactionId}. Verify the solidified receipt and receiver token balance before treating it as final.`,
      })
    } catch (err: any) {
      setActionMessage({ type: 'error', text: err?.message || 'Transfer failed. Check network, address, token balance, and TRX for fees.' })
    } finally {
      setTransferring(false)
    }
  }

  const handleVerifyTokenTransfer = async () => {
    if (!tokenTransferRecord?.transactionId) {
      setActionMessage({ type: 'error', text: 'Send a token transfer first so the app has the expected contract, sender, receiver and amount.' })
      return
    }
    setTokenVerifyLoading(true)
    setTokenVerifyResult(null)
    try {
      const record = tokenTransferRecord
      const params = new URLSearchParams({ network: record.network, contract: record.contractHex, from: record.fromHex, to: record.toHex, amountSun: record.amountBaseUnits })
      const response = await fetch(API_BASE + '/api/tron/verify-transfer/' + encodeURIComponent(record.transactionId) + '?' + params.toString())
      const payload = await response.json()
      setTokenVerifyResult(payload)
      if (!response.ok || !payload?.success) throw new Error(payload?.message || payload?.error || 'Could not verify the token transfer on solidified chain state.')
      setActionMessage({ type: payload.verified ? 'success' : 'error', text: payload.verified ? 'Solidified TRC-20 Transfer event matches the exact contract, sender, receiver and token base-unit amount.' : (payload.message || payload.reason || 'The transfer did not pass all verification checks.') })
      if (payload.verified && record.contractAddress && record.receiverAddress) {
        try {
          setTokenBalanceLoading(true)
          const balanceParams = new URLSearchParams({
            network: record.network,
            contract: record.contractAddress,
            address: record.receiverAddress,
          })
          const balanceResponse = await fetch(API_BASE + '/api/tron/token-balance?' + balanceParams.toString())
          const balancePayload = await balanceResponse.json()
          if (!balanceResponse.ok || !balancePayload?.success) throw new Error('receiver-balance-recheck-failed')
          setTokenBalanceResult(balancePayload)
          setActionMessage({ type: 'success', text: 'Transfer event verified; receiver balance rechecked for the same network, token contract and receiver.' })
        } catch {
          setActionMessage({ type: 'success', text: 'Transfer event verified. Receiver balance could not be rechecked; use the balance button to retry. Exchange credit is not confirmed.' })
        } finally {
          setTokenBalanceLoading(false)
        }
      }
    } catch (err: any) {
      setActionMessage({ type: 'error', text: err?.message || 'Token transfer verification failed.' })
    } finally {
      setTokenVerifyLoading(false)
    }
  }

  const handleLookupVerifiedTransfer = async () => {
    const record = tokenTransferRecord
    const logIndex = tokenVerifyResult?.logIndex
    if (!record?.transactionId || !tokenVerifyResult?.verified || !Number.isSafeInteger(logIndex) || logIndex < 0) {
      setActionMessage({ type: 'error', text: 'Verify the transfer on solidified chain state first; the exact verified Transfer event log index is required.' })
      return
    }
    setVerifiedTransferLookupLoading(true)
    setVerifiedTransferLookup(null)
    try {
      const params = new URLSearchParams({
        network: record.network,
        contract: record.contractHex,
        from: record.fromHex,
        to: record.toHex,
        amountSun: record.amountBaseUnits,
        logIndex: String(logIndex),
      })
      const response = await fetch(API_BASE + '/api/tron/verified-transfer/' + encodeURIComponent(record.transactionId) + '?' + params.toString())
      const payload = await response.json()
      setVerifiedTransferLookup(payload)
      if (!response.ok || !payload?.success || payload?.status !== 'verified-on-chain') {
        throw new Error(payload?.message || payload?.error || 'No persisted verified event matched all supplied fields.')
      }
      setActionMessage({ type: 'success', text: 'The exact verified transfer event was found in persistent verification history.' })
    } catch (err: any) {
      setActionMessage({ type: 'error', text: err?.message || 'Could not look up the persisted verified transfer.' })
    } finally {
      setVerifiedTransferLookupLoading(false)
    }
  }

  const handleQueryTokenBalance = async () => {
    if (!contractAddress.trim() || !recipientAddress.trim()) {
      setActionMessage({ type: 'error', text: 'Enter the TRC-20 contract and receiver address before checking token balance.' })
      return
    }
    setTokenBalanceLoading(true)
    setTokenBalanceResult(null)
    try {
      const params = new URLSearchParams({ network, contract: contractAddress.trim(), address: recipientAddress.trim() })
      const response = await fetch(API_BASE + '/api/tron/token-balance?' + params.toString())
      const payload = await response.json()
      if (!response.ok || !payload?.success) throw new Error(payload?.message || 'Could not read token balance from solidified chain state.')
      setTokenBalanceResult(payload)
      setActionMessage({ type: 'success', text: 'Token balance read from solidified ' + network + ' state for this exact contract.' })
    } catch (err: any) {
      setTokenBalanceResult(null)
      setActionMessage({ type: 'error', text: err?.message || 'Token balance query failed.' })
    } finally {
      setTokenBalanceLoading(false)
    }
  }

  const handleQueryNativeBalance = async () => {
    if (!recipientAddress.trim()) {
      setActionMessage({ type: 'error', text: 'Enter the receiver address before checking its native TRX balance.' })
      return
    }
    setNativeBalanceLoading(true)
    setNativeBalanceResult(null)
    try {
      const url = API_BASE + '/api/tron/native-balance?network=' + encodeURIComponent(network) + '&address=' + encodeURIComponent(recipientAddress.trim())
      const response = await fetch(url)
      const payload = await response.json()
      if (!response.ok || !payload?.success) throw new Error(payload?.message || 'Could not read receiver balance from solidified chain state.')
      setNativeBalanceResult(payload)
      setActionMessage({ type: 'success', text: 'Receiver native balance read from ' + network + ' solidified state.' })
    } catch (err: any) {
      setNativeBalanceResult(null)
      setActionMessage({ type: 'error', text: err?.message || 'Receiver native balance query failed.' })
    } finally {
      setNativeBalanceLoading(false)
    }
  }

  const handleVerifyNativeTransfer = async () => {
    if (!nativeTransferRecord?.transactionId) {
      setActionMessage({ type: 'error', text: 'Send a native TRX transaction first so the app has the expected sender, receiver and amount to verify.' })
      return
    }
    setNativeVerifyLoading(true)
    setNativeVerifyResult(null)
    try {
      const record = nativeTransferRecord
      const params = new URLSearchParams({ network: record.network, from: record.from, to: record.to, amountSun: record.amountSun })
      const response = await fetch(API_BASE + '/api/tron/verify-native-transfer/' + encodeURIComponent(record.transactionId) + '?' + params.toString())
      const payload = await response.json()
      setNativeVerifyResult(payload)
      if (!response.ok || !payload?.success) throw new Error(payload?.message || 'Native TRX transfer verification failed.')
      setActionMessage({ type: payload.verified ? 'success' : 'error', text: payload.verified ? 'Solidified native TRX transaction matches sender, receiver and exact amount.' : 'Transaction is not yet solidified or does not match the expected transfer. Do not resend; retry verification later.' })
      if (payload.verified && record.to) {
        try {
          setNativeBalanceLoading(true)
          const balanceParams = new URLSearchParams({ network: record.network, address: record.to })
          const balanceResponse = await fetch(API_BASE + '/api/tron/native-balance?' + balanceParams.toString())
          const balancePayload = await balanceResponse.json()
          if (!balanceResponse.ok || !balancePayload?.success) throw new Error('receiver-native-balance-recheck-failed')
          setNativeBalanceResult(balancePayload)
          setActionMessage({ type: 'success', text: 'Native TRX transfer verified; receiver TRX balance rechecked on the same network. Exchange credit is not confirmed.' })
        } catch {
          setActionMessage({ type: 'success', text: 'Native TRX transfer verified. Receiver TRX balance could not be rechecked; use the balance button to retry. Exchange credit is not confirmed.' })
        } finally {
          setNativeBalanceLoading(false)
        }
      }
    } catch (err: any) {
      setActionMessage({ type: 'error', text: err?.message || 'Native TRX transfer verification failed.' })
    } finally {
      setNativeVerifyLoading(false)
    }
  }

  // Native Shasta TRX transfer. TRX is the network coin, not a TRC-20 contract.
  const handleNativeTrxTransfer = async () => {
    if (selectedAsset !== 'TRX') {
      setActionMessage({ type: 'error', text: 'Select TRX in Choose asset before using the native TRX transfer workflow.' })
      return
    }
    if (!recipientAddress.trim() || !trxAmount.trim()) {
      setActionMessage({ type: 'error', text: 'Enter a receiver address and a TRX amount.' })
      return
    }
    setTrxTransferring(true)
    setActionMessage(null)
    try {
      const tronWeb = await getInjectedTronWeb()
      const fullNodeHost = String(tronWeb.fullNode?.host || tronWeb.fullNode?.nodeUrl || '').toLowerCase()
      const isShastaWallet = fullNodeHost.includes('shasta')
      if ((network === 'shasta' && !isShastaWallet) || (network === 'mainnet' && (isShastaWallet || fullNodeHost.includes('nile')))) {
        throw new Error('Selected network does not match the network currently active in TronLink. Switch TronLink network and reconnect before sending.')
      }
      if (!tronWeb.isAddress(recipientAddress.trim())) throw new Error('Enter a valid TRON Base58 receiver address.')
      const amount = tronWeb.toBigNumber(trxAmount.trim())
      if (!amount.isFinite() || amount.lte(0) || amount.decimalPlaces() > 6) {
        throw new Error('TRX amount must be positive and may have at most 6 decimal places.')
      }
      const sun = amount.times(1_000_000).toFixed(0)
      const confirmationMessage = 'Confirm native TRX transfer\nNetwork: ' + (network === 'shasta' ? 'Shasta testnet (no real-world value)' : 'TRON MAINNET (real funds)') + '\nSender: ' + (tronWeb.defaultAddress.base58 || 'unknown') + '\nReceiver: ' + recipientAddress.trim() + '\nAmount: ' + amount.toFixed() + ' TRX\n\nCheck the recipient supports TRX on this exact network. Exchange deposits are not guaranteed. Continue to TronLink signing?'
      if (!window.confirm(confirmationMessage)) {
        setActionMessage({ type: 'error', text: 'Transfer cancelled before signing.' })
        return
      }
      if (!Number.isSafeInteger(Number(sun))) {
        throw new Error('This TRX amount exceeds the safe transaction-builder range. Send a smaller amount.')
      }
      const sender = tronWeb.defaultAddress.base58
      if (!sender) throw new Error('TronLink has no authorized sender address.')
      setWalletAddress(sender)
      const transaction = await tronWeb.transactionBuilder.sendTrx(recipientAddress.trim(), Number(sun), sender)
      const signed: any = await tronWeb.trx.sign(transaction)
      const result: any = await tronWeb.trx.sendRawTransaction(signed)
      const txid = signed?.txID || result?.txid || transaction?.txID
      if (!result?.result || !txid) {
        throw new Error(result?.message ? String(result.message) : 'The selected TRON node did not accept the signed transaction. Check balance and network fees.')
      }
      setNativeTransferRecord({ network, from: sender, to: recipientAddress.trim(), amountSun: sun, amountTRX: amount.toFixed(), transactionId: txid })
      setNativeVerifyResult(null)
      setActionMessage({
        type: 'success',
        text: `Native ${network === 'shasta' ? 'Shasta testnet' : 'Mainnet'} TRX transfer broadcast from ${sender}. Transaction ID: ${txid}. This is submitted, not yet confirmed. Verify the solidified receipt and receiver balance before treating it as final.`,
      })
      setVerifyTxId(txid)
    } catch (err: any) {
      setActionMessage({ type: 'error', text: err?.message || 'Native TRX transfer failed. Check the Shasta network, address, and testnet balance.' })
    } finally {
      setTrxTransferring(false)
    }
  }

  const handleVerifyTx = async () => {
    if (!verifyTxId.trim()) return
    setVerifying(true)
    setVerifyResult(null)
    try {
      if (!/^[0-9a-fA-F]{64}$/.test(verifyTxId.trim())) throw new Error('Transaction ID must be 64 hexadecimal characters.')
      const fullHost = network === 'shasta' ? 'https://api.shasta.trongrid.io' : 'https://api.trongrid.io'
      // Query solidified endpoints so a mempool/broadcast response is never presented as final.
      const [txResponse, infoResponse] = await Promise.all([
        fetch(`${fullHost}/walletsolidity/gettransactionbyid`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: verifyTxId.trim() }),
        }),
        fetch(`${fullHost}/walletsolidity/gettransactioninfobyid`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: verifyTxId.trim() }),
        }),
      ])
      if (!txResponse.ok || !infoResponse.ok) throw new Error('TRON provider could not verify this transaction.')
      const [tx, info] = await Promise.all([txResponse.json(), infoResponse.json()])
      if (!tx?.txID) {
        setVerifyResult({ txId: verifyTxId.trim(), confirmed: false, receipt: 'Pending or not found in solidified blocks yet', error: null })
        return
      }
      const contractType = tx.raw_data?.contract?.[0]?.type || ''
      const deployment = tx.raw_data?.contract?.[0]?.parameter?.value?.new_contract
      const txExecution = tx.ret?.[0]?.contractRet || ''
      const receiptExecution = info.receipt?.result || ''
      const execution = receiptExecution || txExecution || info.result || 'Pending or unavailable'
      const isSmartContractCall = contractType === 'TriggerSmartContract'
      const confirmed = Number.isInteger(info.blockNumber) &&
        (isSmartContractCall
          ? info.result !== 'FAILED' && receiptExecution === 'SUCCESS'
          : txExecution === 'SUCCESS' || (!txExecution && info.result === 'SUCCESS'))
      setVerifyResult({
        txId: tx.txID,
        contractAddress: info.contract_address || deployment?.contract_address || null,
        blockNumber: info.blockNumber,
        receipt: execution,
        confirmed,
        error: null,
      })
    } catch (err: any) {
      setVerifyResult({ error: err?.message || 'Transaction verification failed.' })
    } finally {
      setVerifying(false)
    }
  }

  const formatTokenUnits = (baseUnits: string, decimals: number) => {
    try {
      const value = BigInt(baseUnits)
      const scale = 10n ** BigInt(decimals)
      const whole = value / scale
      const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
      return fraction ? whole.toString() + '.' + fraction : whole.toString()
    } catch { return baseUnits }
  }

  const formatSunToTrx = (sun: number) => {
    if (!sun) return '0'
    return (sun / 1000000).toLocaleString()
  }

  return (
    <div className="min-h-screen bg-secondary text-primary font-sans">
      {/* Top Header */}
      <header className="border-b border-secondary bg-primary px-xl py-lg">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <div className="flex items-center gap-md">
            {/* Featured Icon component recipe */}
            <span className="flex size-10 items-center justify-center rounded-full bg-utility-brand-50">
              <Coins className="size-5 shrink-0 text-fg-brand-primary" aria-hidden="true" />
            </span>
            <div>
              <div className="flex items-center gap-sm">
                <h1 className="text-heading-sm font-semibold text-primary">TRON Token Studio</h1>
                {/* Badge component recipe */}
                <span className="inline-flex items-center gap-xs rounded-full border border-utility-success-200 bg-utility-success-50 px-md py-xxs text-xs font-medium text-utility-success-700">
                  {tronBlock?.blockNumber ? 'TRON RPC Connected' : 'Checking TRON RPC'}
                </span>
              </div>
              <p className="text-xs text-tertiary">
                Inspect on-chain balances and send genuine TRX or approved TRC-20 transfers with wallet confirmation. Testnet assets are not Mainnet funds.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-md">
            <button type="button" onClick={handleConnectWallet} className="rounded-lg border border-secondary bg-secondary px-md py-xs text-xs font-semibold text-primary hover:bg-primary">
              {walletConnected && walletAddress ? `TronLink: ${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}` : 'Connect TronLink'}
            </button>
            {tronBlock?.blockNumber && (
              <div className="hidden sm:inline-flex items-center gap-xs rounded-full border border-secondary bg-secondary px-md py-xxs text-xs">
                <span className="text-tertiary">Tron Block:</span>
                <span className="font-mono font-medium text-primary">#{tronBlock.blockNumber}</span>
              </div>
            )}

            <div className="flex items-center rounded-lg border border-secondary bg-secondary p-xxs">
              <button
                type="button"
                onClick={() => setNetwork('shasta')}
                className={`rounded-md px-md py-xs text-xs font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring ${
                  network === 'shasta'
                    ? 'bg-primary text-primary shadow-xs'
                    : 'text-tertiary hover:text-secondary'
                }`}
              >
                Shasta Testnet
              </button>
              <button
                type="button"
                onClick={() => { setNetwork('mainnet'); setContractAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t') }}
                className={`rounded-md px-md py-xs text-xs font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring ${network === 'mainnet' ? 'bg-primary text-primary shadow-xs' : 'text-tertiary hover:text-secondary'}`}
              >
                Mainnet
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="mx-auto max-w-7xl px-xl py-2xl">
        <aside role="status" className="mb-xl rounded-xl border border-secondary bg-secondary p-lg">
          <p className="text-sm font-semibold text-primary">
            {network === 'shasta' ? 'Shasta Testnet — test assets only' : 'TRON Mainnet — real assets and network costs'}
          </p>
          <p className="mt-xs text-xs text-secondary">
            {network === 'shasta'
              ? 'Shasta TRX and test tokens cannot become mainnet USDT or be credited by mainnet exchanges. Use this network for testing only.'
              : 'Mainnet USDT transfers use the official TRON USDT contract. TronLink must authorize each transfer; the sender or an independently verified sponsor must cover required network resources.'}
          </p>
          <p className="mt-xs text-xs text-tertiary">
            Fee sponsorship is currently not integrated. Do not assume the project pays fees or that a successful on-chain deposit guarantees an exchange will credit it.
          </p>
        </aside>
        <SponsorshipStatus />
        {/* Alert component recipe */}
        {apiStatus === 'no-api-key' && (
          <div className="mb-xl flex gap-lg rounded-xl bg-utility-warning-50 p-xl">
            <AlertCircle className="mt-xxs size-5 shrink-0 text-utility-warning-600" aria-hidden="true" />
            <div>
              <p className="text-sm font-semibold text-utility-warning-600">Tatum API key not detected</p>
              <p className="mt-xxs text-sm text-tertiary">
                The app can read the public TRON network directly. Add <code className="font-mono text-primary font-medium">TATUM_API_KEY</code> to enable the optional Tatum-backed API routes.
              </p>
            </div>
          </div>
        )}

        {/* Primary workflow: select an asset and review sponsor availability before using transfer tools. */}
        <div className="mb-md flex flex-wrap gap-sm">
          <button type="button" onClick={() => setActiveTab('choose')} aria-current={activeTab === 'choose' ? 'page' : undefined} className={`rounded-lg border px-md py-sm text-sm font-semibold ${activeTab === 'choose' ? 'border-brand-primary bg-secondary text-primary' : 'border-primary text-secondary'}`}>Choose asset</button>
          <button type="button" onClick={() => setActiveTab('sponsors')} aria-current={activeTab === 'sponsors' ? 'page' : undefined} className={`rounded-lg border px-md py-sm text-sm font-semibold ${activeTab === 'sponsors' ? 'border-brand-primary bg-secondary text-primary' : 'border-primary text-secondary'}`}>Sponsor providers</button>
        </div>
        {/* Tabs component recipe: list on baseline divider */}
        <div className="mb-xl flex gap-lg border-b border-secondary overflow-x-auto">
          <button
            type="button"
            onClick={() => setActiveTab('deploy')}
            className={`border-b-2 px-md py-sm text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring flex items-center gap-xs ${
              activeTab === 'deploy'
                ? 'border-brand text-brand-primary'
                : 'border-transparent text-tertiary hover:text-secondary'
            }`}
          >
            <Zap className="size-4 shrink-0 text-fg-brand-primary" />
            1. Deploy VTRC Token
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('interact')}
            className={`border-b-2 px-md py-sm text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring flex items-center gap-xs ${
              activeTab === 'interact'
                ? 'border-brand text-brand-primary'
                : 'border-transparent text-tertiary hover:text-secondary'
            }`}
          >
            <Coins className="size-4 shrink-0 text-fg-brand-primary" />
            2. Token Holdings & Balances
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('trx')}
            className={`border-b-2 px-md py-sm text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring flex items-center gap-xs ${activeTab === 'trx' ? 'border-brand text-brand-primary' : 'border-transparent text-tertiary hover:text-secondary'}`}
          >
            <Send className="size-4 shrink-0 text-fg-brand-primary" />
            3. Native TRX Transfer
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('simulation')}
            className={`border-b-2 px-md py-sm text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring flex items-center gap-xs ${activeTab === 'simulation' ? 'border-brand text-brand-primary' : 'border-transparent text-tertiary hover:text-secondary'}`}
          >
            <Send className="size-4 shrink-0 text-fg-brand-primary" />
            4. Transfer Simulator
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('verify')}
            className={`border-b-2 px-md py-sm text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring flex items-center gap-xs ${
              activeTab === 'verify'
                ? 'border-brand text-brand-primary'
                : 'border-transparent text-tertiary hover:text-secondary'
            }`}
          >
            <ShieldCheck className="size-4 shrink-0 text-fg-brand-primary" />
            5. On-chain Verification
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('contract')}
            className={`border-b-2 px-md py-sm text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring flex items-center gap-xs ${
              activeTab === 'contract'
                ? 'border-brand text-brand-primary'
                : 'border-transparent text-tertiary hover:text-secondary'
            }`}
          >
            <Code2 className="size-4 shrink-0 text-fg-brand-primary" />
            6. Solidity Source Code & Spec
          </button>
        </div>

        {activeTab === 'choose' && <TokenSelectionPage network={network} asset={selectedAsset} onAssetChange={setSelectedAsset} onContinue={() => { if (selectedAsset === 'TRX') setActiveTab('trx'); else if (selectedAsset === 'VTRC') setActiveTab('interact'); else setActionMessage({ type: 'error', text: 'USDT transfer is blocked in this workflow until an independently verified official contract allowlist is implemented for the selected network.' }) }} />}
        {activeTab === 'sponsors' && <SponsorProviderPage network={network} />}

        {/* Tab 1: Deploy & Clone */}
        {activeTab === 'deploy' && (
          <div className="grid grid-cols-1 gap-xl lg:grid-cols-3">
            {/* Card component recipe: rounded-xl, border-secondary, bg-primary, p-xl, shadow-xs */}
            <section className="lg:col-span-2 rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-xl">
              <div className="flex items-center justify-between border-b border-secondary pb-md">
                <div>
                  <h2 className="text-heading-xs font-semibold text-primary">Deploy Independent TRC-20 Token</h2>
                  <p className="text-xs text-tertiary mt-xxs">
                    Deploys your own fixed-supply TRC-20 contract. Default identity: TRC20 (VTRC), 18 decimals. Not official Tether USDT.
                  </p>
                </div>
                {/* Badge recipe */}
                <span className="inline-flex items-center gap-xs rounded-full border border-utility-brand-200 bg-utility-brand-50 px-md py-xxs text-xs font-medium text-brand-primary">
                  Solidity TVM / TRC-20
                </span>
              </div>

              {/* Input component recipes */}
              <div className="grid grid-cols-1 gap-lg sm:grid-cols-2">
                <div className="flex flex-col gap-sm">
                  <label className="text-sm font-medium text-secondary">Token Name</label>
                  <input
                    type="text"
                    value={tokenName}
                    onChange={(e) => setTokenName(e.target.value)}
                    className="rounded-md bg-primary px-lg py-sm text-sm text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                  />
                  <p className="text-xs text-tertiary">Independent token name</p>
                </div>

                <div className="flex flex-col gap-sm">
                  <label className="text-sm font-medium text-secondary">Token Symbol</label>
                  <input
                    type="text"
                    value={tokenSymbol}
                    onChange={(e) => setTokenSymbol(e.target.value)}
                    className="rounded-md bg-primary px-lg py-sm text-sm text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                  />
                  <p className="text-xs text-tertiary">Use a distinct token symbol</p>
                </div>

                <div className="flex flex-col gap-sm">
                  <label className="text-sm font-medium text-secondary">Decimals</label>
                  <input
                    type="number"
                    value={tokenDecimals}
                    onChange={(e) => setTokenDecimals(e.target.value)}
                    className="rounded-md bg-primary px-lg py-sm text-sm text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                  />
                  <p className="text-xs text-tertiary">This contract template is fixed at 18 decimals</p>
                </div>

                <div className="flex flex-col gap-sm">
                  <label className="text-sm font-medium text-secondary">Initial Supply (Tokens)</label>
                  <input
                    type="text"
                    value={initialSupply}
                    onChange={(e) => setInitialSupply(e.target.value)}
                    className="rounded-md bg-primary px-lg py-sm text-sm text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                  />
                  <p className="text-xs text-tertiary">1,000,000 VTRC</p>
                </div>

                <div className="sm:col-span-2 flex flex-col gap-sm">
                  <label className="text-sm font-medium text-secondary">Initial Recipient Address (Tron Base58)</label>
                  <input
                    type="text"
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value)}
                    className="rounded-md bg-primary px-lg py-sm text-sm font-mono text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                  />
                  <p className="text-xs text-tertiary">Receives 100% of the initial supply upon deployment</p>
                </div>
                <div className="sm:col-span-2 flex flex-col gap-sm">
                  <div className="flex items-center justify-between gap-sm">
                    <label className="text-sm font-medium text-secondary">Wallet Private Key (browser-local signing)</label>
                    <button type="button" onClick={handleGenerateWallet} className="rounded-md border border-primary px-sm py-xs text-xs font-semibold text-brand-primary">Generate wallet</button>
                  </div>
                  <input
                    type={showPrivateKey ? "text" : "password"}
                    autoComplete="off"
                    value={privateKey}
                    onChange={(e) => setPrivateKey(e.target.value)}
                    className="rounded-md bg-primary px-lg py-sm text-sm font-mono text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                    placeholder="Private key for your own wallet"
                  />
                  <div className="flex flex-wrap items-center gap-sm">
                    <button type="button" onClick={() => setShowPrivateKey(!showPrivateKey)} className="rounded-md border border-primary px-sm py-xs text-xs font-semibold text-secondary">{showPrivateKey ? 'Hide key' : 'Show key'}</button>
                    {privateKey && <button type="button" onClick={() => copyToClipboard(privateKey, 'wallet-private-key')} className="rounded-md border border-primary px-sm py-xs text-xs font-semibold text-secondary">{copied === 'wallet-private-key' ? 'Copied key' : 'Copy key backup'}</button>}
                  </div>
                  {walletAddress && <p className="text-xs font-mono text-secondary break-all">Current local wallet: {walletAddress}</p>}
                  <p className="text-xs text-tertiary">The key is used only by this browser and is not submitted to the backend. Back it up securely; this page does not store it after you close or reload the app.</p>
                </div>
              </div>

              {/* Alert recipe: neutral informational callout */}
              <div className="flex gap-lg rounded-xl border border-secondary bg-primary p-xl">
                <Key className="mt-xxs size-5 shrink-0 text-fg-brand-primary" aria-hidden="true" />
                <div>
                  <p className="text-sm font-semibold text-primary">Tron Network Signing</p>
                  <p className="mt-xxs text-sm text-tertiary">
                    Your wallet signs the deployment in this browser. The private key is not sent to the backend or stored by Render. Keep a secure backup and never use a wallet holding funds you cannot afford to risk.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-md">
                {/* Button recipe: primary */}
                <button
                  type="button"
                  onClick={handleDeploy}
                  disabled={deploying}
                  className="inline-flex items-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50"
                >
                  {deploying ? (
                    <>
                      <RefreshCw className="size-4 animate-spin text-primary-on-brand shrink-0" />
                      Deploying to {network === 'shasta' ? 'Shasta' : 'Mainnet'}...
                    </>
                  ) : (
                    <>
                      <Zap className="size-4 shrink-0 text-primary-on-brand" />
                      Deploy VTRC Token
                    </>
                  )}
                </button>
              </div>

              {deployResult && (
                <div>
                  {deployResult.success ? (
                    /* Alert recipe: success */
                    <div className="flex gap-lg rounded-xl bg-utility-success-50 p-xl">
                      <CheckCircle2 className="mt-xxs size-5 shrink-0 text-utility-success-600" aria-hidden="true" />
                      <div className="w-full">
                        <p className="text-sm font-semibold text-utility-success-600">Contract Deployed Successfully!</p>
                        {deployResult.txId && (
                          <div className="mt-sm flex items-center justify-between rounded-md bg-primary p-sm text-xs font-mono border border-primary">
                            <span>Tx Hash: {deployResult.txId}</span>
                            <button
                              type="button"
                              onClick={() => copyToClipboard(deployResult.txId || '', 'tx')}
                              className="text-tertiary hover:text-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                            >
                              <Copy className="size-4 shrink-0 text-fg-quaternary" />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    /* Alert recipe: brand informational */
                    <div className="flex gap-lg rounded-xl bg-utility-brand-50 p-xl">
                      <AlertCircle className="mt-xxs size-5 shrink-0 text-utility-brand-600" aria-hidden="true" />
                      <div className="w-full">
                        <p className="text-sm font-semibold text-brand-primary">Deployment Payload Validated</p>
                        <p className="mt-xxs text-sm text-tertiary">{deployResult.message}</p>
                        {deployResult.preparedPayload && (
                          <div className="mt-sm rounded-md bg-primary p-md border border-primary text-xs font-mono">
                            <pre className="text-secondary overflow-x-auto">{JSON.stringify(deployResult.preparedPayload, null, 2)}</pre>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>

            {/* Sidebar info */}
            <div className="space-y-lg">
              <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs">
                <h3 className="text-sm font-semibold text-primary mb-md flex items-center gap-xs">
                  <Layers className="size-4 shrink-0 text-fg-brand-primary" />
                  Official Tether USD Specs
                </h3>
                <div className="space-y-sm text-xs text-secondary">
                  <div className="flex justify-between border-b border-secondary pb-xs">
                    <span className="text-tertiary">Mainnet Contract:</span>
                    <span className="font-mono text-primary font-medium text-right break-all">TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t</span>
                  </div>
                  <div className="flex justify-between border-b border-secondary pb-xs">
                    <span className="text-tertiary">Network Protocol:</span>
                    <span className="text-primary font-medium">TRC-20 (Tron TVM)</span>
                  </div>
                  <div className="flex justify-between border-b border-secondary pb-xs">
                    <span className="text-tertiary">Independent token decimals:</span>
                    <span className="text-primary font-medium">18 (VTRC)</span>
                  </div>
                  <div className="flex justify-between border-b border-secondary pb-xs">
                    <span className="text-tertiary">Token identity:</span>
                    <span className="text-primary font-medium">TRC20 / VTRC — not official USDT</span>
                  </div>
                  <p className="text-xs text-tertiary">Supply is determined by the deployed contract and must be read from the selected contract. This template does not report Tether's live supply.</p>
                </div>
              </section>

              <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs">
                <h3 className="text-sm font-semibold text-primary mb-md">TRC-20 Standard Requirements</h3>
                <ul className="space-y-xs text-xs text-secondary">
                  <li className="flex items-center gap-xs">
                    <CheckCircle2 className="size-4 shrink-0 text-fg-success-primary" />
                    <span>Complies with Tron TVM bytecode standards</span>
                  </li>
                  <li className="flex items-center gap-xs">
                    <CheckCircle2 className="size-4 shrink-0 text-fg-success-primary" />
                    <span>18 decimal precision for the independent VTRC token</span>
                  </li>
                  <li className="flex items-center gap-xs">
                    <CheckCircle2 className="size-4 shrink-0 text-fg-success-primary" />
                    <span>Transfer & Approval events mapped</span>
                  </li>
                  <li className="flex items-center gap-xs">
                    <CheckCircle2 className="size-4 shrink-0 text-fg-success-primary" />
                    <span>Energy & Bandwidth fee optimization</span>
                  </li>
                </ul>
              </section>
            </div>
          </div>
        )}

        {/* Tab 2: Interact & Balance */}
        {activeTab === 'interact' && (
          <div className="grid grid-cols-1 gap-xl lg:grid-cols-2">
            <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs">
              <h2 className="text-heading-xs font-semibold text-primary mb-sm">Query Tron Account & TRC-20 Balances</h2>
              <p className="text-xs text-tertiary mb-lg">
                Fetch real-time on-chain TRC-20 holdings and native TRX bandwidth directly from the Tron blockchain.
              </p>

              <div className="space-y-md">
                <div className="flex flex-col gap-sm">
                  <label className="text-sm font-medium text-secondary">Tron Wallet Address</label>
                  <input
                    type="text"
                    value={queryAddress}
                    onChange={(e) => setQueryAddress(e.target.value)}
                    className="rounded-md bg-primary px-lg py-sm text-sm font-mono text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                    placeholder="Enter Tron Base58 address (e.g. T...)"
                  />
                </div>

                {/* Button recipe: primary */}
                <button
                  type="button"
                  onClick={handleQueryAccount}
                  disabled={loadingDetails}
                  className="w-full inline-flex items-center justify-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50"
                >
                  {loadingDetails ? (
                    <>
                      <RefreshCw className="size-4 animate-spin text-primary-on-brand shrink-0" />
                      Querying Tron Network...
                    </>
                  ) : (
                    <>
                      <Search className="size-4 shrink-0 text-primary-on-brand" />
                      Query Live Account & Balances
                    </>
                  )}
                </button>
              </div>

              {accountData && (
                <div className="mt-xl rounded-lg bg-secondary p-md space-y-sm">
                  <div className="flex justify-between text-xs">
                    <span className="text-tertiary">Address:</span>
                    <span className="font-mono text-primary font-medium truncate max-w-[200px]">{accountData.address}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-tertiary">Native TRX Balance:</span>
                    <span className="font-mono text-primary font-medium">{formatSunToTrx(accountData.balance)} TRX</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-tertiary">Available Bandwidth:</span>
                    <span className="font-mono text-primary">{accountData.bandwidth || 0}</span>
                  </div>

                  <div className="border-t border-secondary pt-sm mt-sm">
                    <span className="text-xs font-semibold text-primary block mb-xs">TRC-20 Token Holdings:</span>
                    {accountData.trc20 && accountData.trc20.length > 0 ? (
                      <div className="space-y-xs">
                        {accountData.trc20.map((token: any, idx: number) => (
                          <div key={idx} className="flex justify-between items-center bg-primary p-xs rounded-md text-xs border border-primary">
                            <span className="font-mono text-tertiary truncate max-w-[180px]">{token.contractAddress}</span>
                            <span className="font-semibold text-brand-primary">{token.balance} {token.symbol || "Units"}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-tertiary italic">No TRC-20 tokens recorded for this address.</p>
                    )}
                  </div>
                  <div className="border-t border-secondary pt-sm mt-sm">
                    <span className="text-xs font-semibold text-primary block mb-xs">Recent Confirmed TRC-20 Transfers</span>
                    {transactionHistory.length > 0 ? (
                      <div className="space-y-xs">
                        {transactionHistory.map((tx: any, idx: number) => {
                          const decimals = Number(tx.token_info?.decimals || 0)
                          const amount = Number(tx.value || 0) / Math.pow(10, decimals)
                          const time = tx.block_timestamp ? new Date(tx.block_timestamp).toLocaleString() : 'Time unavailable'
                          const outgoing = String(tx.from || '').toLowerCase() === String(accountData.address || '').toLowerCase()
                          return (
                            <div key={tx.transaction_id || idx} className="rounded-md border border-primary bg-primary p-sm text-xs">
                              <div className="flex items-center justify-between gap-sm">
                                <span className={outgoing ? 'font-semibold text-utility-error-600' : 'font-semibold text-utility-success-600'}>{outgoing ? 'Sent' : 'Received'} {amount.toLocaleString(undefined, { maximumFractionDigits: 8 })} {tx.token_info?.symbol || 'TRC-20'}</span>
                                <span className="text-tertiary">{time}</span>
                              </div>
                              <div className="mt-xs truncate font-mono text-tertiary">Tx: {tx.transaction_id || 'Unavailable'}</div>
                              <a className="mt-xs inline-block text-brand-primary underline" href={`https://${network === 'shasta' ? 'shasta.' : ''}tronscan.org/#/transaction/${tx.transaction_id}`} target="_blank" rel="noreferrer">View on TRONSCAN</a>
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <p className="text-xs text-tertiary italic">No confirmed TRC-20 transfer records returned for this address.</p>
                    )}
                  </div>
                </div>
              )}
            </section>

            {/* Transfer Simulation */}
            <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs">
              <h2 className="text-heading-xs font-semibold text-primary mb-sm">Transfer TRC-20 Tokens</h2>
              <p className="text-xs text-tertiary mb-lg">
                Sign a real TRC-20 transfer in this browser. Your private key is not sent to the backend.
              </p>

              <div className="space-y-md">
                <div className="flex flex-col gap-sm">
                  <div className="flex items-center justify-between gap-sm">
                    <label className="text-sm font-medium text-secondary">Wallet Private Key (local signing only)</label>
                    <button type="button" onClick={handleGenerateWallet} className="rounded-md border border-primary px-sm py-xs text-xs font-semibold text-brand-primary">Generate wallet</button>
                  </div>
                  <input
                    type={showPrivateKey ? "text" : "password"}
                    autoComplete="off"
                    value={privateKey}
                    onChange={(e) => setPrivateKey(e.target.value)}
                    className="rounded-md bg-primary px-lg py-sm text-sm font-mono text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                    placeholder="Enter your own wallet private key"
                  />
                  <div className="flex flex-wrap items-center gap-sm">
                    <button type="button" onClick={() => setShowPrivateKey(!showPrivateKey)} className="rounded-md border border-primary px-sm py-xs text-xs font-semibold text-secondary">{showPrivateKey ? 'Hide key' : 'Show key'}</button>
                    {privateKey && <button type="button" onClick={() => copyToClipboard(privateKey, 'wallet-private-key')} className="rounded-md border border-primary px-sm py-xs text-xs font-semibold text-secondary">{copied === 'wallet-private-key' ? 'Copied key' : 'Copy key backup'}</button>}
                  </div>
                  {walletAddress && <p className="text-xs font-mono text-secondary break-all">Current local wallet: {walletAddress}</p>}
                  <p className="text-xs text-tertiary">Signing runs locally in this browser. The key is not sent to the backend. Back it up securely; it is not saved after you close or reload the app.</p>
                </div>

                <div className="flex flex-col gap-sm">
                  <label className="text-sm font-medium text-secondary">TRC-20 Contract Address</label>
                  <input
                    type="text"
                    value={contractAddress}
                    onChange={(e) => setContractAddress(e.target.value)}
                    className="rounded-md bg-primary px-lg py-sm text-sm font-mono text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                    placeholder="Your token contract address"
                  />
                </div>

                <div className="flex flex-col gap-sm">
                  <label className="text-sm font-medium text-secondary">Recipient Tron Address</label>
                  <input
                    type="text"
                    value={recipientAddress}
                    onChange={(e) => setRecipientAddress(e.target.value)}
                    className="rounded-md bg-primary px-lg py-sm text-sm font-mono text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                    placeholder="e.g. TLyqzVGLV1srkB7dToTAnY9A9auHgdB9nd"
                  />
                </div>

                <div className="flex flex-col gap-sm">
                  <label className="text-sm font-medium text-secondary">Transfer Amount (token units)</label>
                  <input
                    type="number"
                    value={transferAmount}
                    onChange={(e) => setTransferAmount(e.target.value)}
                    className="rounded-md bg-primary px-lg py-sm text-sm text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                  />
                </div>

                <button type="button" onClick={handleQueryTokenBalance} disabled={tokenBalanceLoading} className="w-full rounded-lg border border-primary px-lg py-sm text-sm font-semibold text-brand-primary disabled:opacity-50">{tokenBalanceLoading ? 'Reading token balance…' : 'Verify receiver token balance'}</button>
                {tokenTransferRecord && <div className="rounded-xl border border-secondary bg-secondary p-lg space-y-sm">
                  <p className="text-sm font-semibold text-primary">Latest TRC-20 transfer</p>
                  <p className="text-xs text-tertiary">Network: {tokenTransferRecord.network} · Token: {tokenTransferRecord.tokenSymbol} · Amount: {tokenTransferRecord.amount}</p>
                  <p className="break-all text-xs font-mono text-secondary">Tx: {tokenTransferRecord.transactionId}</p>
                  <button type="button" onClick={handleVerifyTokenTransfer} disabled={tokenVerifyLoading} className="w-full rounded-lg border border-primary px-lg py-sm text-sm font-semibold text-brand-primary disabled:opacity-50">{tokenVerifyLoading ? 'Verifying solidified token transfer…' : 'Verify token contract, sender, receiver & amount'}</button>
                  {tokenVerifyResult && <div className="space-y-xs"><p className="text-sm font-semibold">{tokenVerifyResult.verified ? 'Solidified token transfer verified' : (tokenVerifyResult.status || tokenVerifyResult.reason || 'Not verified')}</p><p className="text-xs text-tertiary">Block: {tokenVerifyResult.blockNumber ?? 'not solidified yet'} · Exact event amount: {tokenVerifyResult.amountSun ?? tokenTransferRecord.amountBaseUnits} base units</p>{tokenVerifyResult.verified && <p className="text-xs text-tertiary">Verification history saved: {tokenVerifyResult.persistence?.persisted ? 'yes' : 'no — ' + (tokenVerifyResult.persistence?.reason || 'storage unavailable')}</p>}<p className="text-xs text-tertiary">This confirms a matching on-chain event for this contract. It does not prove the token is official USDT or that an exchange credited the deposit.</p>{tokenVerifyResult.verified && <button type="button" onClick={handleLookupVerifiedTransfer} disabled={verifiedTransferLookupLoading} className="w-full rounded-lg border border-primary px-lg py-sm text-sm font-semibold text-brand-primary disabled:opacity-50">{verifiedTransferLookupLoading ? 'Checking saved verification…' : 'Check saved verified-transfer record'}</button>}{verifiedTransferLookup && <p className="break-all text-xs text-tertiary">{verifiedTransferLookup.success ? 'Saved record found for exact network, contract, parties, amount and event index.' : 'Saved record lookup: ' + (verifiedTransferLookup.error || verifiedTransferLookup.message || 'not found')}</p>}</div>}
                </div>}
                {tokenBalanceResult && <div className="rounded-xl border border-secondary bg-secondary p-lg space-y-xs"><p className="text-sm font-semibold text-primary">Solidified receiver token balance</p><p className="break-all text-xs text-tertiary">Network: {tokenBalanceResult.network}</p><p className="break-all text-xs text-tertiary">Contract: {tokenBalanceResult.tokenContract}</p><p className="break-all text-xs text-tertiary">Receiver: {tokenBalanceResult.receiverAddress}</p><p className="text-lg font-semibold text-primary">Balance: {formatTokenUnits(tokenBalanceResult.balanceBaseUnits, tokenBalanceResult.decimals)} tokens</p><p className="text-xs text-tertiary">Raw units: {tokenBalanceResult.balanceBaseUnits} · Decimals: {tokenBalanceResult.decimals}. This is the balance of this exact contract only; it does not prove exchange deposit credit or that the token is official USDT.</p></div>}

                {/* Button recipe: primary */}
                <button
                  type="button"
                  onClick={handleTransfer}
                  disabled={transferring}
                  className="w-full inline-flex items-center justify-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50"
                >
                  {transferring ? (
                    <>
                      <RefreshCw className="size-4 animate-spin text-primary-on-brand shrink-0" />
                      Broadcasting...
                    </>
                  ) : (
                    <>
                      <Send className="size-4 shrink-0 text-primary-on-brand" />
                      Execute TRC-20 Transfer
                    </>
                  )}
                </button>

                {actionMessage && (
                  /* Alert recipe */
                  <div
                    className={`flex gap-lg rounded-xl p-xl ${
                      actionMessage.type === 'success'
                        ? 'bg-utility-success-50 text-utility-success-700'
                        : 'bg-utility-brand-50 text-brand-primary'
                    }`}
                  >
                    <div className="text-xs leading-relaxed">{actionMessage.text}</div>
                  </div>
                )}
              </div>
            </section>
            <ReceiverHistory network={network} address={queryAddress || walletAddress} contract={contractAddress} />
          </div>
        )}

        {/* Native TRX is the network coin, not a TRC-20 contract token. */}
        {activeTab === 'trx' && (
          <div className="grid grid-cols-1 gap-xl lg:grid-cols-3">
            <section className="lg:col-span-2 rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-xl">
              <div className="border-b border-secondary pb-md">
                <h2 className="text-heading-xs font-semibold text-primary">Native TRX Transfer</h2>
                <p className="mt-xxs text-xs text-tertiary">
                  {network === 'shasta' ? 'Send native TRX on Shasta testnet. Testnet coins have no Mainnet or exchange deposit value.' : 'Send real native TRX on TRON Mainnet. Confirm the receiver supports TRX on the TRON network before sending.'} This does not mint TRX or create a token contract.
                </p>
              </div>
              <div className="rounded-lg border border-secondary bg-secondary p-lg">
                <p className="text-sm font-semibold text-primary">1. Prepare a test wallet</p>
                <p className="mt-xs text-xs text-tertiary">Generate a wallet on the Deploy tab or use a test wallet you control. Obtain Shasta test TRX from a testnet faucet to pay network fees. Never paste a wallet holding valuable mainnet funds.</p>
                <p className="mt-md text-sm font-semibold text-primary">2. Enter the receiver and amount</p>
              </div>
              <div className="grid grid-cols-1 gap-lg sm:grid-cols-2">
                <div className="flex flex-col gap-sm sm:col-span-2">
                  <label className="text-sm font-medium text-secondary">Receiver TRON Address</label>
                  <input type="text" value={recipientAddress} onChange={(e) => setRecipientAddress(e.target.value)} placeholder="T..." className="rounded-md bg-primary px-lg py-sm text-sm font-mono text-primary border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring" />
                </div>
                <div className="flex flex-col gap-sm">
                  <label className="text-sm font-medium text-secondary">Amount (TRX)</label>
                  <input type="number" min="0.000001" step="0.000001" value={trxAmount} onChange={(e) => setTrxAmount(e.target.value)} className="rounded-md bg-primary px-lg py-sm text-sm text-primary border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring" />
                  <p className="text-xs text-tertiary">Up to 6 decimal places. Converted to SUN before signing.</p>
                </div>
                <div className="flex flex-col justify-end gap-sm">
                  {walletAddress && <p className="break-all text-xs font-mono text-secondary">Sender: {walletAddress}</p>}
                </div>
              </div>
              <div className="rounded-xl border border-secondary bg-primary p-lg space-y-sm">
                <p className="text-sm font-semibold text-primary">Sender wallet authorization</p>
                <p className="text-xs text-tertiary">This transfer flow uses TronLink for network detection and explicit transaction approval. It does not use the private-key field from the token deployment tab.</p>
                <button type="button" onClick={handleConnectWallet} className="rounded-lg border border-primary px-lg py-sm text-sm font-semibold text-brand-primary">Connect / verify TronLink</button>
                {walletAddress && <p className="break-all text-xs font-mono text-secondary">Connected sender: {walletAddress}</p>}
                <p className="text-xs text-tertiary">Never paste a seed phrase or private key into this tab. Before mainnet sending, confirm the selected network, receiver, amount and fee in TronLink.</p>
              </div>
              <div className="flex flex-wrap gap-sm">
                <button type="button" onClick={handleNativeTrxTransfer} disabled={trxTransferring} className="inline-flex items-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand disabled:opacity-50">
                  {trxTransferring ? <RefreshCw className="size-4 animate-spin" /> : <Send className="size-4" />}
                  {trxTransferring ? 'Broadcasting TRX...' : 'Send Native ' + (network === 'shasta' ? 'Shasta Testnet' : 'Mainnet') + ' TRX'}
                </button>
                <button type="button" onClick={handleQueryNativeBalance} disabled={nativeBalanceLoading} className="rounded-lg border border-primary px-lg py-sm text-sm font-semibold text-secondary disabled:opacity-50">{nativeBalanceLoading ? 'Reading solidified balance…' : 'Verify receiver TRX balance'}</button>
              </div>
              {nativeTransferRecord && <div className="rounded-xl border border-secondary bg-secondary p-lg space-y-sm">
                <p className="text-sm font-semibold text-primary">Latest native TRX transfer</p>
                <p className="text-xs text-tertiary">Network: {nativeTransferRecord.network} · Amount: {nativeTransferRecord.amountTRX} TRX</p>
                <p className="break-all text-xs font-mono text-secondary">Tx: {nativeTransferRecord.transactionId}</p>
                <button type="button" onClick={handleVerifyNativeTransfer} disabled={nativeVerifyLoading} className="rounded-lg border border-primary px-lg py-sm text-sm font-semibold text-brand-primary disabled:opacity-50">{nativeVerifyLoading ? 'Verifying solidified transaction…' : 'Verify sender, receiver & amount'}</button>
                {nativeVerifyResult && <div className="space-y-xs"><p className="text-sm font-semibold">{nativeVerifyResult.verified ? 'Solidified transfer verified' : (nativeVerifyResult.status || 'Not verified')}</p><p className="break-all text-xs text-tertiary">Sender: {nativeVerifyResult.from || nativeTransferRecord.from}</p><p className="break-all text-xs text-tertiary">Receiver: {nativeVerifyResult.to || nativeTransferRecord.to}</p><p className="text-xs text-tertiary">Amount: {nativeVerifyResult.amountTRX ?? nativeTransferRecord.amountTRX} TRX · Block: {nativeVerifyResult.blockNumber ?? 'not solidified yet'}</p><p className="text-xs text-tertiary">On-chain confirmation does not guarantee an exchange credited the deposit.</p></div>}
              </div>}
              {nativeBalanceResult && <div className="rounded-xl border border-secondary bg-secondary p-lg space-y-xs"><p className="text-sm font-semibold text-primary">Receiver solidified native balance</p><p className="text-2xl font-semibold text-brand-primary">{nativeBalanceResult.balanceTRX} TRX</p><p className="text-xs text-tertiary">Network: {nativeBalanceResult.network} · Address: {nativeBalanceResult.address}</p><p className="text-xs text-tertiary">Balance: {nativeBalanceResult.balanceSun} SUN · Account exists: {nativeBalanceResult.accountExists ? 'yes' : 'not yet indexed/created'}</p><p className="text-xs text-tertiary">This is native TRX only. It is not a TRC-20 token balance and does not confirm exchange deposit credit.</p></div>}
              {actionMessage && <div className={`rounded-xl p-lg text-sm ${actionMessage.type === 'success' ? 'bg-utility-success-50 text-utility-success-700' : 'bg-utility-brand-50 text-brand-primary'}`}>{actionMessage.text}</div>}
            </section>
            <aside className="rounded-xl border border-secondary bg-primary p-xl space-y-md">
              <h3 className="text-sm font-semibold text-primary">What this verifies</h3>
              <ul className="space-y-sm text-xs text-tertiary list-disc pl-lg">
                <li>Native TRX transaction authorization in TronLink</li>
                <li>Broadcast to the selected {network === 'shasta' ? 'Shasta testnet' : 'Mainnet'} node</li>
                <li>Transaction ID available for on-chain verification</li>
                <li>Receiver account balance after network confirmation</li>
              </ul>
              <p className="text-xs text-tertiary">This cannot produce mainnet TRX, bypass exchange deposit rules, or guarantee third-party token auto-listing.</p>
            </aside>
          </div>
        )}

        {/* Clearly labeled local-only simulation. No chain transaction is sent. */}
        {activeTab === 'simulation' && <TransferSimulator />}

        {/* Tab 3: Verification */}
        {activeTab === 'verify' && (
          <div className="space-y-xl">
            <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs">
              <h2 className="text-heading-xs font-semibold text-primary mb-sm">Verify TRON Smart Contract Deployment</h2>
              <p className="text-xs text-tertiary mb-lg">
                Check whether a deployment transaction hash has created a verified smart contract on the Tron blockchain.
              </p>

              <div className="flex gap-sm">
                <input
                  type="text"
                  value={verifyTxId}
                  onChange={(e) => setVerifyTxId(e.target.value)}
                  className="flex-1 rounded-md bg-primary px-lg py-sm text-sm font-mono text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                  placeholder="Enter Tron Transaction Hash (64 characters)"
                />
                {/* Button recipe: primary */}
                <button
                  type="button"
                  onClick={handleVerifyTx}
                  disabled={verifying}
                  className="inline-flex items-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50"
                >
                  {verifying ? (
                    <>
                      <RefreshCw className="size-4 animate-spin text-primary-on-brand shrink-0" />
                      Verifying...
                    </>
                  ) : (
                    <>
                      <Search className="size-4 shrink-0 text-primary-on-brand" />
                      Verify On-Chain
                    </>
                  )}
                </button>
              </div>

              {verifyResult && (
                <div className="mt-xl">
                  <div className={`flex gap-lg rounded-xl p-xl ${verifyResult.confirmed ? 'bg-utility-success-50' : 'bg-secondary'}`}>
                    {verifyResult.confirmed ? (
                      <CheckCircle2 className="mt-xxs size-5 shrink-0 text-utility-success-600" aria-hidden="true" />
                    ) : (
                      <AlertCircle className="mt-xxs size-5 shrink-0 text-utility-warning-600" aria-hidden="true" />
                    )}
                    <div className="w-full min-w-0">
                      <p className="text-sm font-semibold text-primary">
                        {verifyResult.error || (verifyResult.confirmed ? 'Transaction solidified and execution succeeded' : 'Not yet confirmed as successful')}
                      </p>
                      {verifyResult.txId && (
                        <div className="mt-sm break-all rounded-md bg-primary p-sm text-xs font-mono border border-primary">
                          <span className="text-tertiary">Transaction ID: </span>{verifyResult.txId}
                        </div>
                      )}
                      <div className="mt-sm grid grid-cols-1 sm:grid-cols-2 gap-sm text-xs">
                        <div className="rounded-md bg-primary p-sm border border-primary">
                          <span className="text-tertiary">Receipt: </span>{verifyResult.receipt || 'Pending or unavailable'}
                        </div>
                        <div className="rounded-md bg-primary p-sm border border-primary">
                          <span className="text-tertiary">Block: </span>{verifyResult.blockNumber ?? 'Not solidified yet'}
                        </div>
                      </div>
                      {verifyResult.contractAddress && (
                        <div className="mt-sm break-all rounded-md bg-primary p-sm text-xs font-mono border border-primary">
                          <span className="text-tertiary">Contract Address: </span>{verifyResult.contractAddress}
                        </div>
                      )}
                      {verifyResult.confirmed && (
                        <p className="mt-sm text-xs text-utility-success-700">The transaction is in a solidified block and the execution receipt reports SUCCESS. Confirm the expected recipient and amount separately.</p>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </section>

            <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs">
              <h3 className="text-sm font-semibold text-primary mb-md">TRC-20 Verification Rules</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-lg">
                <div className="rounded-lg bg-secondary p-md">
                  <div className="flex items-center gap-xs font-semibold text-xs text-primary mb-xs">
                    <CheckCircle2 className="size-4 shrink-0 text-fg-success-primary" />
                    Standard Interface
                  </div>
                  <p className="text-xs text-tertiary">
                    Ensures standard TRC-20 signatures: totalSupply(), balanceOf(), transfer(), approve(), allowance(), transferFrom().
                  </p>
                </div>
                <div className="rounded-lg bg-secondary p-md">
                  <div className="flex items-center gap-xs font-semibold text-xs text-primary mb-xs">
                    <CheckCircle2 className="size-4 shrink-0 text-fg-success-primary" />
                    Token Precision
                  </div>
                  <p className="text-xs text-tertiary">
                    Decimals are token-specific. This project defaults to 18 decimals for its independent VTRC token.
                  </p>
                </div>
                <div className="rounded-lg bg-secondary p-md">
                  <div className="flex items-center gap-xs font-semibold text-xs text-primary mb-xs">
                    <CheckCircle2 className="size-4 shrink-0 text-fg-success-primary" />
                    Event Emission
                  </div>
                  <p className="text-xs text-tertiary">
                    Emits standard Transfer and Approval events to trigger real-time indexers and Tronscan verification.
                  </p>
                </div>
              </div>
            </section>
          </div>
        )}

        {/* Tab 4: Solidity Contract */}
        {activeTab === 'contract' && (
          <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs">
            <div className="flex items-center justify-between mb-md">
              <div>
                <h2 className="text-heading-xs font-semibold text-primary">Independent TRC-20 Solidity Contract Template</h2>
                <p className="text-xs text-tertiary">
                  Standard TRC-20 interface template for your own separately identified token.
                </p>
              </div>
              {/* Button recipe: secondary */}
              <button
                type="button"
                onClick={() => copyToClipboard('contract_source', 'contract_source')}
                className="inline-flex items-center gap-sm rounded-lg bg-primary px-lg py-sm text-sm font-semibold text-secondary border border-primary shadow-xs hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                <Copy className="size-4 shrink-0 text-fg-quaternary" />
                {copied === 'contract_source' ? 'Copied' : 'Copy Code'}
              </button>
            </div>

            <div className="rounded-lg bg-secondary p-md overflow-x-auto">
              <pre className="text-xs font-mono text-secondary leading-relaxed">
{`// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Independent TRC-20 token
 * @notice Independent asset, not official Tether USDT.
 * @dev Fixed supply, 18 decimals, no owner mint function.
 */
contract IndependentTRC20 {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 private _totalSupply;
    address public immutable owner;
    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory tokenName, string memory tokenSymbol, uint256 initialWholeTokenSupply, address recipient) {
        require(keccak256(bytes(tokenName)) == keccak256(bytes("TRC20")), "name must be TRC20");
        require(keccak256(bytes(tokenSymbol)) == keccak256(bytes("VTRC")), "symbol must be VTRC");
        require(initialWholeTokenSupply > 0, "supply must be positive");
        require(recipient != address(0), "zero recipient");
        owner = msg.sender;
        name = tokenName;
        symbol = tokenSymbol;
        uint256 scale = 10 ** uint256(decimals);
        require(initialWholeTokenSupply <= type(uint256).max / scale, "supply overflow");
        _totalSupply = initialWholeTokenSupply * scale;
        _balances[recipient] = _totalSupply;
        emit Transfer(address(0), recipient, _totalSupply);
    }

    function totalSupply() external view returns (uint256) { return _totalSupply; }
    function balanceOf(address account) external view returns (uint256) { return _balances[account]; }
    function allowance(address tokenOwner, address spender) external view returns (uint256) {
        return _allowances[tokenOwner][spender];
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        require(recipient != address(0), "zero recipient");
        require(_balances[msg.sender] >= amount, "insufficient balance");
        _balances[msg.sender] -= amount;
        _balances[recipient] += amount;
        emit Transfer(msg.sender, recipient, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        require(spender != address(0), "zero spender");
        _allowances[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool) {
        require(recipient != address(0), "zero recipient");
        require(_balances[sender] >= amount, "insufficient balance");
        require(_allowances[sender][msg.sender] >= amount, "allowance exceeded");
        _allowances[sender][msg.sender] -= amount;
        _balances[sender] -= amount;
        _balances[recipient] += amount;
        emit Transfer(sender, recipient, amount);
        return true;
    }
}`}
              </pre>
            </div>
          </section>
        )}
      </main>
    </div>
  )
}
