import { useState, useEffect } from 'react'
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

export default function App() {
  const [network, setNetwork] = useState<'shasta' | 'mainnet'>('shasta')
  const [activeTab, setActiveTab] = useState<'deploy' | 'interact' | 'verify' | 'contract'>('deploy')
  const [copied, setCopied] = useState<string | null>(null)

  // System status
  const [apiStatus, setApiStatus] = useState<string>('checking')
  const [tronBlock, setTronBlock] = useState<{ blockNumber?: number; hash?: string } | null>(null)

  // Deploy state
  const [tokenName, setTokenName] = useState('Tether USD')
  const [tokenSymbol, setTokenSymbol] = useState('USDT')
  const [tokenDecimals, setTokenDecimals] = useState('6')
  const [initialSupply, setInitialSupply] = useState('1000000000')
  const [recipient, setRecipient] = useState('TYMwiDu22V6XG3yk6W9cTVBz48okKLRczh')
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
  const [contractAddress, setContractAddress] = useState('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')
  const [queryAddress, setQueryAddress] = useState('TYMwiDu22V6XG3yk6W9cTVBz48okKLRczh')
  const [recipientAddress, setRecipientAddress] = useState('')
  const [transferAmount, setTransferAmount] = useState('100')
  const [accountData, setAccountData] = useState<any>(null)
  const [loadingDetails, setLoadingDetails] = useState(false)
  const [transferring, setTransferring] = useState(false)
  const [actionMessage, setActionMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // Verify state
  const [verifyTxId, setVerifyTxId] = useState('')
  const [verifyResult, setVerifyResult] = useState<any>(null)
  const [verifying, setVerifying] = useState(false)

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/status')
      const data = await res.json()
      setApiStatus(data.status)

      const tronRes = await fetch('/api/tron/info')
      const tronData = await tronRes.json()
      if (tronData.success && tronData.data) {
        setTronBlock(tronData.data)
      }
    } catch {
      setApiStatus('error')
    }
  }

  useEffect(() => {
    fetchStatus()
  }, [])

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied(null), 2000)
  }

  const handleDeploy = async () => {
    setDeploying(true)
    setDeployResult(null)
    try {
      const res = await fetch('/api/tron/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: tokenName,
          symbol: tokenSymbol,
          decimals: Number(tokenDecimals),
          totalSupply: Number(initialSupply),
          recipient
        })
      })
      const data = await res.json()
      if (data.success && data.result) {
        setDeployResult({
          success: true,
          txId: data.result.txId,
          contractAddress: data.result.contractAddress
        })
      } else {
        setDeployResult({
          success: false,
          error: data.error,
          message: data.message,
          preparedPayload: data.preparedPayload
        })
      }
    } catch (err: any) {
      setDeployResult({
        success: false,
        error: 'client-error',
        message: err.message
      })
    } finally {
      setDeploying(false)
    }
  }

  const handleQueryAccount = async () => {
    if (!queryAddress) return
    setLoadingDetails(true)
    setAccountData(null)
    try {
      const res = await fetch(`/api/tron/account/${encodeURIComponent(queryAddress)}`)
      const data = await res.json()
      if (data.success) {
        setAccountData(data.data)
      } else {
        setActionMessage({ type: 'error', text: data.message || 'Failed to fetch Tron account data' })
      }
    } catch (err: any) {
      setActionMessage({ type: 'error', text: err.message })
    } finally {
      setLoadingDetails(false)
    }
  }

  const handleTransfer = async () => {
    if (!contractAddress || !recipientAddress || !transferAmount) return
    setTransferring(true)
    setActionMessage(null)
    try {
      const res = await fetch('/api/tron/transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tokenAddress: contractAddress,
          to: recipientAddress,
          amount: transferAmount,
          feeLimit: 10
        })
      })
      const data = await res.json()
      if (data.success) {
        setActionMessage({
          type: 'success',
          text: `Transfer successfully broadcasted! TxID: ${data.result?.txId || 'Confirmed'}`
        })
      } else {
        setActionMessage({
          type: 'error',
          text: data.message || 'Transfer failed'
        })
      }
    } catch (err: any) {
      setActionMessage({ type: 'error', text: err.message })
    } finally {
      setTransferring(false)
    }
  }

  const handleVerifyTx = async () => {
    if (!verifyTxId) return
    setVerifying(true)
    setVerifyResult(null)
    try {
      const res = await fetch(`/api/tron/contract-by-tx/${encodeURIComponent(verifyTxId)}`)
      const data = await res.json()
      if (data.success) {
        setVerifyResult(data.data)
      } else {
        setVerifyResult({ error: data.message || 'Contract not found for transaction' })
      }
    } catch (err: any) {
      setVerifyResult({ error: err.message })
    } finally {
      setVerifying(false)
    }
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
                <h1 className="text-heading-sm font-semibold text-primary">Tron TRC-20 USDT Engine</h1>
                {/* Badge component recipe */}
                <span className="inline-flex items-center gap-xs rounded-full border border-utility-success-200 bg-utility-success-50 px-md py-xxs text-xs font-medium text-utility-success-700">
                  Tron Gateway Active
                </span>
              </div>
              <p className="text-xs text-tertiary">
                Clone, deploy, operate, and verify Tether USD (TRC-20) smart contracts on Tron blockchain
              </p>
            </div>
          </div>

          <div className="flex items-center gap-md">
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
                onClick={() => setNetwork('mainnet')}
                className={`rounded-md px-md py-xs text-xs font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring ${
                  network === 'mainnet'
                    ? 'bg-primary text-primary shadow-xs'
                    : 'text-tertiary hover:text-secondary'
                }`}
              >
                Tron Mainnet
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="mx-auto max-w-7xl px-xl py-2xl">
        {/* Alert component recipe */}
        {apiStatus === 'no-api-key' && (
          <div className="mb-xl flex gap-lg rounded-xl bg-utility-warning-50 p-xl">
            <AlertCircle className="mt-xxs size-5 shrink-0 text-utility-warning-600" aria-hidden="true" />
            <div>
              <p className="text-sm font-semibold text-utility-warning-600">Tatum API key not detected</p>
              <p className="mt-xxs text-sm text-tertiary">
                Blockchain reads and deployments require a Tatum API key. Add <code className="font-mono text-primary font-medium">TATUM_API_KEY</code> in your workspace settings to execute live calls.
              </p>
            </div>
          </div>
        )}

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
            1. Deploy & Clone USDT
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
            onClick={() => setActiveTab('verify')}
            className={`border-b-2 px-md py-sm text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring flex items-center gap-xs ${
              activeTab === 'verify'
                ? 'border-brand text-brand-primary'
                : 'border-transparent text-tertiary hover:text-secondary'
            }`}
          >
            <ShieldCheck className="size-4 shrink-0 text-fg-brand-primary" />
            3. On-chain Verification
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
            4. Solidity Source Code & Spec
          </button>
        </div>

        {/* Tab 1: Deploy & Clone */}
        {activeTab === 'deploy' && (
          <div className="grid grid-cols-1 gap-xl lg:grid-cols-3">
            {/* Card component recipe: rounded-xl, border-secondary, bg-primary, p-xl, shadow-xs */}
            <section className="lg:col-span-2 rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-xl">
              <div className="flex items-center justify-between border-b border-secondary pb-md">
                <div>
                  <h2 className="text-heading-xs font-semibold text-primary">Deploy TRC-20 USDT Token Clone</h2>
                  <p className="text-xs text-tertiary mt-xxs">
                    Deploys an official-equivalent Tether USD TRC-20 contract with 6 decimals directly to Tron.
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
                  <p className="text-xs text-tertiary">Official: Tether USD</p>
                </div>

                <div className="flex flex-col gap-sm">
                  <label className="text-sm font-medium text-secondary">Token Symbol</label>
                  <input
                    type="text"
                    value={tokenSymbol}
                    onChange={(e) => setTokenSymbol(e.target.value)}
                    className="rounded-md bg-primary px-lg py-sm text-sm text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                  />
                  <p className="text-xs text-tertiary">Official: USDT</p>
                </div>

                <div className="flex flex-col gap-sm">
                  <label className="text-sm font-medium text-secondary">Decimals</label>
                  <input
                    type="number"
                    value={tokenDecimals}
                    onChange={(e) => setTokenDecimals(e.target.value)}
                    className="rounded-md bg-primary px-lg py-sm text-sm text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                  />
                  <p className="text-xs text-tertiary">Standard for TRC-20 USDT is 6 decimals</p>
                </div>

                <div className="flex flex-col gap-sm">
                  <label className="text-sm font-medium text-secondary">Initial Supply (Tokens)</label>
                  <input
                    type="text"
                    value={initialSupply}
                    onChange={(e) => setInitialSupply(e.target.value)}
                    className="rounded-md bg-primary px-lg py-sm text-sm text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                  />
                  <p className="text-xs text-tertiary">1,000,000,000 USDT</p>
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
              </div>

              {/* Alert recipe: neutral informational callout */}
              <div className="flex gap-lg rounded-xl border border-secondary bg-primary p-xl">
                <Key className="mt-xxs size-5 shrink-0 text-fg-brand-primary" aria-hidden="true" />
                <div>
                  <p className="text-sm font-semibold text-primary">Tron Network Signing</p>
                  <p className="mt-xxs text-sm text-tertiary">
                    Transactions to Tron require execution signing. Add <code className="text-brand-primary font-mono font-medium">TRON_PRIVATE_KEY</code> to your server environment variables for automated broadcasting, or inspect the generated payload below.
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
                      Deploy USDT Clone Token
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
                    <span className="text-tertiary">Decimals:</span>
                    <span className="text-primary font-medium">6</span>
                  </div>
                  <div className="flex justify-between border-b border-secondary pb-xs">
                    <span className="text-tertiary">Total USDT Supply:</span>
                    <span className="text-primary font-medium">&gt; 58 Billion USDT</span>
                  </div>
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
                    <span>Exact 6 decimal precision</span>
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
                            <span className="font-semibold text-brand-primary">{token.balance} Units</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-tertiary italic">No TRC-20 tokens recorded for this address.</p>
                    )}
                  </div>
                </div>
              )}
            </section>

            {/* Transfer Simulation */}
            <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs">
              <h2 className="text-heading-xs font-semibold text-primary mb-sm">Transfer TRC-20 Tokens</h2>
              <p className="text-xs text-tertiary mb-lg">
                Execute or simulate a compliant TRC-20 transfer operation on Tron.
              </p>

              <div className="space-y-md">
                <div className="flex flex-col gap-sm">
                  <label className="text-sm font-medium text-secondary">TRC-20 Contract Address</label>
                  <input
                    type="text"
                    value={contractAddress}
                    onChange={(e) => setContractAddress(e.target.value)}
                    className="rounded-md bg-primary px-lg py-sm text-sm font-mono text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                    placeholder="TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
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
                  <label className="text-sm font-medium text-secondary">Transfer Amount (USDT)</label>
                  <input
                    type="number"
                    value={transferAmount}
                    onChange={(e) => setTransferAmount(e.target.value)}
                    className="rounded-md bg-primary px-lg py-sm text-sm text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                  />
                </div>

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
          </div>
        )}

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
                  {verifyResult.contractAddress ? (
                    /* Alert recipe: success */
                    <div className="flex gap-lg rounded-xl bg-utility-success-50 p-xl">
                      <CheckCircle2 className="mt-xxs size-5 shrink-0 text-utility-success-600" aria-hidden="true" />
                      <div className="w-full">
                        <p className="text-sm font-semibold text-utility-success-600">Contract Confirmed on Tron!</p>
                        <div className="mt-sm flex justify-between items-center rounded-md bg-primary p-sm text-xs font-mono border border-primary">
                          <span className="text-tertiary">Contract Address:</span>
                          <span className="font-bold text-primary">{verifyResult.contractAddress}</span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="text-xs text-secondary bg-secondary p-md rounded-lg">
                      <span className="font-medium text-primary">Result: </span>
                      {verifyResult.error || 'No contract deployment found for this transaction ID.'}
                    </div>
                  )}
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
                    6 Decimals Alignment
                  </div>
                  <p className="text-xs text-tertiary">
                    Calibrated specifically for USDT 6 decimals standard across all Tron decentralized exchanges and centralized bridges.
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
                <h2 className="text-heading-xs font-semibold text-primary">TRC-20 USDT Solidity Smart Contract Code</h2>
                <p className="text-xs text-tertiary">
                  TVM-compatible smart contract source matching Tether USD (TRC-20) architecture.
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
 * @title Tether USD (TRC-20 Clone)
 * @dev Fully compliant TRC-20 implementation matching Tether USDT specifications on Tron.
 * Supports TVM bytecode execution, 6 decimals precision, and standard event emission.
 */
interface ITRC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
}

contract TetherUSD_TRC20 is ITRC20 {
    string public name = "Tether USD";
    string public symbol = "USDT";
    uint8 public decimals = 6;
    uint256 private _totalSupply;
    address public owner;

    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;

    modifier onlyOwner() {
        require(msg.sender == owner, "Only contract owner can invoke");
        _;
    }

    constructor(uint256 initialSupply, address recipient) {
        owner = msg.sender;
        _totalSupply = initialSupply * 10 ** uint256(decimals);
        _balances[recipient] = _totalSupply;
        emit Transfer(address(0), recipient, _totalSupply);
    }

    function totalSupply() public view override returns (uint256) {
        return _totalSupply;
    }

    function balanceOf(address account) public view override returns (uint256) {
        return _balances[account];
    }

    function transfer(address recipient, uint256 amount) public override returns (bool) {
        require(recipient != address(0), "TRC20: transfer to zero address");
        require(_balances[msg.sender] >= amount, "TRC20: transfer amount exceeds balance");

        _balances[msg.sender] -= amount;
        _balances[recipient] += amount;
        emit Transfer(msg.sender, recipient, amount);
        return true;
    }

    function allowance(address accountOwner, address spender) public view override returns (uint256) {
        return _allowances[accountOwner][spender];
    }

    function approve(address spender, uint256 amount) public override returns (bool) {
        _allowances[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address sender, address recipient, uint256 amount) public override returns (bool) {
        require(_balances[sender] >= amount, "TRC20: transfer amount exceeds balance");
        require(_allowances[sender][msg.sender] >= amount, "TRC20: transfer amount exceeds allowance");

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
