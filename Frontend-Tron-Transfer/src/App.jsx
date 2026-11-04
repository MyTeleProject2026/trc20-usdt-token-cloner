import { useEffect, useMemo, useState } from 'react'
import { TronWeb } from 'tronweb'
import {
  Activity, AlertTriangle, ArrowDownLeft, ArrowUpRight, CheckCircle2, ChevronDown,
  CircleHelp, Copy, ExternalLink, Eye, EyeOff, FileKey2, KeyRound, LockKeyhole,
  LogOut, Plus, RefreshCw, Send, ShieldCheck, Wallet, X,
} from 'lucide-react'
import {
  parseUnitsDecimal,
  estimateTRC20TransferFee,
  buildSignAndBroadcastTransfer,
  verifyTransferRecordOnChain,
  readConfirmedTransferStatus,
} from './lib/wallet-transfer.mjs'
import {
  encryptWalletPrivateKey,
  decryptWalletPrivateKey,
  isEncryptedWalletRecord,
} from './lib/wallet-vault-crypto.mjs'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? '' : 'https://trc20-usdt-token-cloner-api.onrender.com')).replace(/\/+$/, '')
const NETWORKS = Object.freeze({
  nile: { label: 'Nile Testnet', rpc: API_BASE + '/api/tatum/rpc/nile', explorer: 'https://nile.tronscan.org' },
  shasta: { label: 'Shasta Testnet', rpc: API_BASE + '/api/tatum/rpc/shasta', explorer: 'https://shasta.tronscan.org' },
})
const WALLET_KEY = 'tron-transfer:testnet-wallet:v1'
const TOKEN_KEY = 'tron-transfer:testnet-tokens:v1'
const HISTORY_KEY = 'tron-transfer:testnet-history:v1'
const ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const TX_RE = /^[0-9a-f]{64}$/i
const TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const TOKEN_ABI = [
  { constant: true, inputs: [{ name: 'owner', type: 'address' }], name: 'balanceOf', outputs: [{ name: 'balance', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { constant: true, inputs: [], name: 'decimals', outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view', type: 'function' },
  { constant: true, inputs: [], name: 'symbol', outputs: [{ name: '', type: 'string' }], stateMutability: 'view', type: 'function' },
  { constant: true, inputs: [], name: 'name', outputs: [{ name: '', type: 'string' }], stateMutability: 'view', type: 'function' },
]

function clientFor(network, privateKey) {
  const selected = NETWORKS[network]
  if (!selected) throw new Error('Only Nile and Shasta testnets are available in this application.')
  return new TronWeb({ fullHost: selected.rpc, ...(privateKey ? { privateKey } : {}) })
}
function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback } catch { return fallback }
}
function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value))
}
function formatUnits(value, decimals = 6) {
  try {
    const amount = BigInt(String(value || '0'))
    const base = 10n ** BigInt(decimals)
    const whole = amount / base
    const fraction = (amount % base).toString().padStart(decimals, '0').replace(/0+$/, '')
    return fraction ? whole.toString() + '.' + fraction : whole.toString()
  } catch { return '0' }
}
function shorten(value) {
  return value && value.length > 18 ? value.slice(0, 9) + '…' + value.slice(-7) : value || '—'
}
function txUrl(network, txid) {
  return NETWORKS[network] && TX_RE.test(String(txid || ''))
    ? NETWORKS[network].explorer + '/#/transaction/' + txid.toLowerCase() : null
}
function addressUrl(network, address) {
  return NETWORKS[network] && ADDRESS_RE.test(String(address || ''))
    ? NETWORKS[network].explorer + '/#/address/' + encodeURIComponent(address) : null
}
function cleanHistory(value) {
  if (!Array.isArray(value)) return []
  return value.filter(item => item && NETWORKS[item.network] && TX_RE.test(String(item.txid || ''))
    && ADDRESS_RE.test(String(item.from || '')) && ADDRESS_RE.test(String(item.to || ''))
    && ['TRX', 'TRC20'].includes(item.asset) && /^[1-9][0-9]{0,77}$/.test(String(item.amountBaseUnits || ''))
    && Number.isInteger(item.decimals) && item.decimals >= 0 && item.decimals <= 18
    && (item.asset === 'TRX' || ADDRESS_RE.test(String(item.tokenContract || ''))))
    .slice(0, 40)
}
function normalizeHex(value) {
  return String(value || '').replace(/^0x/i, '').replace(/^41/i, '').toLowerCase()
}
async function verifyTokenReceipt(web, item) {
  const info = await web.trx.getTransactionInfo(item.txid)
  if (String(info?.receipt?.result || info?.result || '').toUpperCase() !== 'SUCCESS') {
    return { status: info?.receipt?.result ? 'failed' : 'awaiting-solidification', reason: 'token-receipt-not-successful' }
  }
  const expectedContract = normalizeHex(web.address.toHex(item.tokenContract))
  const expectedFrom = normalizeHex(web.address.toHex(item.from))
  const expectedTo = normalizeHex(web.address.toHex(item.to))
  const logs = Array.isArray(info?.log) ? info.log : Array.isArray(info?.logs) ? info.logs : []
  const match = logs.some(log => {
    const topics = Array.isArray(log?.topics) ? log.topics.map(value => String(value).toLowerCase()) : []
    if (normalizeHex(log?.address) !== expectedContract || topics[0] !== TRANSFER_TOPIC || topics.length < 3) return false
    const from = topics[1].slice(-40)
    const to = topics[2].slice(-40)
    let amount
    try { amount = BigInt('0x' + String(log?.data || '').replace(/^0x/i, '')) } catch { return false }
    return from === expectedFrom && to === expectedTo && amount === BigInt(item.amountBaseUnits)
  })
  return match
    ? { status: 'verified-on-chain', reason: 'successful-transfer-event-matched' }
    : { status: 'verification-mismatch', reason: 'matching-transfer-event-not-found' }
}

export default function App() {
  const [network, setNetwork] = useState('nile')
  const [walletRecord, setWalletRecord] = useState(() => readJson(WALLET_KEY, null))
  const [unlocked, setUnlocked] = useState(null)
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [privateKeyInput, setPrivateKeyInput] = useState('')
  const [backupText, setBackupText] = useState('')
  const [walletMode, setWalletMode] = useState('import')
  const [showKey, setShowKey] = useState(false)
  const [tokens, setTokens] = useState(() => readJson(TOKEN_KEY, { nile: [], shasta: [] }))
  const [tokenInput, setTokenInput] = useState('')
  const [portfolio, setPortfolio] = useState(null)
  const [balanceBusy, setBalanceBusy] = useState(false)
  const [history, setHistory] = useState(() => cleanHistory(readJson(HISTORY_KEY, [])))
  const [recipient, setRecipient] = useState('')
  const [asset, setAsset] = useState('TRX')
  const [tokenAddress, setTokenAddress] = useState('')
  const [amount, setAmount] = useState('')
  const [review, setReview] = useState(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState('overview')

  const networkTokens = tokens[network] || []
  const selectedToken = networkTokens.find(token => token.contract === tokenAddress) || networkTokens[0]
  const unlockedAddress = unlocked?.address || ''

  useEffect(() => { writeJson(HISTORY_KEY, history) }, [history])
  useEffect(() => { writeJson(TOKEN_KEY, tokens) }, [tokens])
  useEffect(() => {
    setPortfolio(null)
    setReview(null)
    setAcknowledged(false)
    setNotice('')
    setError('')
    setTokenAddress('')
  }, [network])

  const canReview = Boolean(unlocked && recipient.trim() && amount.trim() && (asset === 'TRX' || selectedToken))
  const explorer = useMemo(() => addressUrl(network, unlockedAddress), [network, unlockedAddress])

  async function saveAndUnlock(key, address, chosenPassword) {
    const record = await encryptWalletPrivateKey(key, address, chosenPassword)
    writeJson(WALLET_KEY, record)
    setWalletRecord(record)
    setUnlocked({ address, privateKey: key.replace(/^0x/i, '').toLowerCase() })
    setPassword('')
    setConfirmPassword('')
    setPrivateKeyInput('')
    setBackupText('')
    setNotice('Wallet encrypted and saved in this browser. The private key is not sent to a server.')
    setError('')
  }
  async function createWallet() {
    if (password.length < 12 || password !== confirmPassword) throw new Error('Use a matching wallet password of at least 12 characters.')
    const web = clientFor(network)
    const account = await web.createAccount()
    if (!account?.privateKey || !ADDRESS_RE.test(account?.address?.base58 || '')) throw new Error('Local wallet generation failed.')
    await saveAndUnlock(account.privateKey, account.address.base58, password)
  }
  async function importWallet() {
    if (password.length < 12 || password !== confirmPassword) throw new Error('Use a matching wallet password of at least 12 characters.')
    const key = privateKeyInput.trim().replace(/^0x/i, '')
    if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error('Enter a 64-character hexadecimal private key.')
    const web = clientFor(network, key)
    const address = String(web.defaultAddress?.base58 || '')
    if (!ADDRESS_RE.test(address) || !web.isAddress(address)) throw new Error('The private key did not produce a valid TRON address.')
    await saveAndUnlock(key, address, password)
  }
  async function restoreWallet() {
    if (!backupText.trim() || !password) throw new Error('Choose an encrypted wallet backup and enter its password.')
    const parsed = JSON.parse(backupText)
    const record = parsed?.wallet || parsed
    if (!isEncryptedWalletRecord(record)) throw new Error('This is not a supported encrypted Tron Token Studio wallet backup.')
    const key = await decryptWalletPrivateKey(record, password)
    const web = clientFor(network, key)
    if (String(web.defaultAddress?.base58 || '') !== record.address) throw new Error('The backup key does not match its recorded address.')
    writeJson(WALLET_KEY, record)
    setWalletRecord(record)
    setUnlocked({ address: record.address, privateKey: key })
    setPassword('')
    setBackupText('')
    setNotice('Encrypted wallet backup restored locally.')
  }
  async function unlockWallet() {
    if (!walletRecord || !password) throw new Error('Choose the saved wallet and enter its password.')
    const key = await decryptWalletPrivateKey(walletRecord, password)
    const web = clientFor(network, key)
    if (String(web.defaultAddress?.base58 || '') !== walletRecord.address) throw new Error('Wallet address verification failed.')
    setUnlocked({ address: walletRecord.address, privateKey: key })
    setPassword('')
    setNotice('Wallet unlocked. The signing key is held in memory only until you lock or leave this page.')
  }
  function lockWallet() {
    setUnlocked(null)
    setPortfolio(null)
    setReview(null)
    setAcknowledged(false)
    setPassword('')
    setNotice('Wallet locked. The decrypted signing key has been cleared from application state.')
  }
  async function refreshBalances() {
    if (!unlocked) throw new Error('Unlock your wallet first.')
    setBalanceBusy(true)
    try {
      const web = clientFor(network)
      const sun = await web.trx.getBalance(unlocked.address)
      const tokenBalances = await Promise.all(networkTokens.map(async token => {
        try {
          const contract = await web.contract(TOKEN_ABI, token.contract)
          const value = await contract.balanceOf(unlocked.address).call()
          return { ...token, balanceBaseUnits: String(value), balance: formatUnits(value, token.decimals), error: null }
        } catch (cause) {
          return { ...token, balanceBaseUnits: '0', balance: 'Unavailable', error: cause instanceof Error ? cause.message : 'Token balance read failed.' }
        }
      }))
      setPortfolio({ trxSun: String(sun), trx: formatUnits(sun, 6), tokens: tokenBalances, checkedAt: new Date().toISOString() })
      setNotice('Balances refreshed directly from the selected TRON testnet.')
      setError('')
    } finally { setBalanceBusy(false) }
  }
  async function addToken() {
    if (!unlocked) throw new Error('Unlock your wallet before adding a token.')
    const address = tokenInput.trim()
    const web = clientFor(network)
    if (!web.isAddress(address) || !ADDRESS_RE.test(address)) throw new Error('Enter a valid TRON contract address.')
    const contract = await web.contract(TOKEN_ABI, address)
    const [symbol, decimals, name] = await Promise.all([
      contract.symbol().call(), contract.decimals().call(), contract.name().call().catch(() => 'Unknown token'),
    ])
    const precision = Number(decimals)
    if (!Number.isInteger(precision) || precision < 0 || precision > 18) throw new Error('The contract returned unsupported token decimals.')
    const token = { contract: address, symbol: String(symbol).slice(0, 16), name: String(name).slice(0, 48), decimals: precision }
    const next = { ...tokens, [network]: [...networkTokens.filter(item => item.contract !== address), token].slice(0, 20) }
    setTokens(next)
    setTokenAddress(address)
    setTokenInput('')
    setNotice('Token contract metadata verified from the selected testnet and added to this browser watchlist.')
  }
  async function prepareTransfer() {
    if (!unlocked) throw new Error('Unlock the wallet before preparing a transfer.')
    const web = clientFor(network, unlocked.privateKey)
    const to = recipient.trim()
    if (!web.isAddress(to) || !ADDRESS_RE.test(to)) throw new Error('Enter a valid TRON Base58 recipient address.')
    if (to === unlocked.address) throw new Error('Sender and recipient must be different.')
    const decimals = asset === 'TRX' ? 6 : selectedToken?.decimals
    if (!Number.isInteger(decimals)) throw new Error('Select a verified testnet TRC-20 token.')
    const amountBaseUnits = parseUnitsDecimal(amount, decimals)
    let symbol = 'TRX'
    let feeLimitSun = 1_000_000
    let energyRequired = null
    if (asset === 'TRX') {
      const balance = BigInt(String(await web.trx.getBalance(unlocked.address)))
      if (balance < BigInt(amountBaseUnits) + 1_000_000n) throw new Error('Insufficient testnet TRX. Keep at least 1 TRX available for network fees.')
    } else {
      symbol = selectedToken.symbol
      const contract = await web.contract(TOKEN_ABI, selectedToken.contract)
      const balance = BigInt(String(await contract.balanceOf(unlocked.address).call()))
      if (balance < BigInt(amountBaseUnits)) throw new Error('Insufficient token balance on the selected testnet.')
      const estimate = await estimateTRC20TransferFee({
        tronWeb: web, from: unlocked.address, to, tokenContract: selectedToken.contract, amountBaseUnits,
      })
      feeLimitSun = estimate.recommendedFeeSun
      energyRequired = estimate.energyRequired
      const nativeBalance = BigInt(String(await web.trx.getBalance(unlocked.address)))
      if (nativeBalance < BigInt(feeLimitSun)) throw new Error('Insufficient testnet TRX for the estimated token-transfer fee. Obtain testnet TRX or arrange genuine testnet resource delegation.')
    }
    setReview({
      network, from: unlocked.address, to, asset, symbol, tokenContract: asset === 'TRC20' ? selectedToken.contract : null,
      amount, amountBaseUnits, decimals, feeLimitSun, energyRequired,
    })
    setAcknowledged(false)
    setNotice('Transfer review prepared from live testnet balances. Nothing has been signed or broadcast yet.')
  }
  async function sendTransfer() {
    if (!unlocked || !review || !acknowledged) throw new Error('Unlock the wallet, review the transfer and acknowledge the exact details.')
    if (review.network !== network || review.from !== unlocked.address) throw new Error('Network or sender changed after review. Prepare the transfer again.')
    const web = clientFor(network, unlocked.privateKey)
    const result = await buildSignAndBroadcastTransfer({
      tronWeb: web, from: review.from, to: review.to, asset: review.asset,
      amountBaseUnits: review.amountBaseUnits, tokenContract: review.tokenContract || undefined,
      feeLimitSun: review.feeLimitSun,
    })
    const item = {
      txid: result.txid, network, from: result.source, to: result.destination, asset: review.asset,
      tokenContract: result.tokenContract, symbol: review.symbol, amountBaseUnits: review.amountBaseUnits,
      amount: review.amount, decimals: review.decimals, status: 'broadcast-accepted',
      verification: 'awaiting-solidification', submittedAt: Date.now(),
    }
    setHistory(current => [item, ...current.filter(entry => entry.txid !== item.txid)].slice(0, 40))
    setReview(null)
    setAcknowledged(false)
    setRecipient('')
    setAmount('')
    setNotice('The selected testnet node accepted the signed transaction. This is not yet proof of successful execution; refresh its on-chain status.')
    setActiveTab('activity')
  }
  async function verifyHistoryItem(item) {
    const web = clientFor(item.network)
    const chainStatus = await readConfirmedTransferStatus(web, item.txid)
    if (chainStatus.status === 'failed') return { ...item, status: 'failed', verification: 'solidified-failed-receipt', blockNumber: chainStatus.blockNumber }
    if (chainStatus.status !== 'confirmed') return { ...item, status: chainStatus.status, verification: 'awaiting-solidification', blockNumber: chainStatus.blockNumber }
    const intent = await verifyTransferRecordOnChain(web, {
      txid: item.txid, from: item.from, to: item.to, asset: item.asset,
      amountBaseUnits: item.amountBaseUnits, tokenContract: item.tokenContract || undefined,
    })
    if (intent.identityMatches !== true) return { ...item, status: 'verification-mismatch', verification: intent.reason || 'transaction-intent-mismatch' }
    if (item.asset === 'TRC20') {
      const event = await verifyTokenReceipt(web, item)
      return { ...item, status: event.status, verification: event.reason, blockNumber: chainStatus.blockNumber }
    }
    return { ...item, status: 'verified-on-chain', verification: 'solidified-transfer-intent-matched', blockNumber: chainStatus.blockNumber }
  }
  async function refreshOne(item) {
    setBusy(true)
    try {
      const updated = await verifyHistoryItem(item)
      setHistory(current => current.map(entry => entry.txid === item.txid ? updated : entry))
      setNotice(updated.status === 'verified-on-chain'
        ? 'The successful solidified transaction and transfer details were verified on the selected testnet.'
        : 'Transaction status refreshed: ' + updated.status + '.')
    } finally { setBusy(false) }
  }
  async function perform(action) {
    setBusy(true); setError('')
    try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : 'Operation failed. Check the selected testnet and retry.'); }
    finally { setBusy(false) }
  }
  async function exportBackup() {
    if (!walletRecord) throw new Error('No encrypted wallet is saved.')
    const blob = new Blob([JSON.stringify({ wallet: walletRecord }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url; anchor.download = 'tron-transfer-encrypted-wallet-backup.json'; anchor.click()
    URL.revokeObjectURL(url)
  }
  async function removeWallet() {
    if (unlocked) lockWallet()
    localStorage.removeItem(WALLET_KEY)
    setWalletRecord(null)
    setPortfolio(null)
    setNotice('Encrypted wallet record removed from this browser. This does not affect the on-chain wallet.')
  }

  const nav = [
    { id: 'overview', label: 'Overview', icon: Wallet },
    { id: 'send', label: 'Send / Withdraw', icon: Send },
    { id: 'activity', label: 'Activity', icon: Activity },
  ]

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#"><span className="brand-mark">T</span><span>TRON <b>TRANSFER</b><small>TESTNET WALLET</small></span></a>
        <div className="network-card">
          <span className="eyebrow">ACTIVE NETWORK</span>
          <select value={network} onChange={event => { setNetwork(event.target.value); setPortfolio(null); setReview(null) }}>
            <option value="nile">Nile Testnet</option><option value="shasta">Shasta Testnet</option>
          </select>
          <span className="network-dot"><i /> TESTNET ONLY</span>
        </div>
        <nav>{nav.map(item => <button key={item.id} className={activeTab === item.id ? 'active' : ''} onClick={() => setActiveTab(item.id)}><item.icon size={17} />{item.label}</button>)}</nav>
        <div className="sidebar-bottom">
          <div className="security-note"><ShieldCheck size={17}/><span>Local signing<br/><b>No server-held keys</b></span></div>
          {unlocked ? <button className="outline-button" onClick={lockWallet}><LockKeyhole size={16}/> Lock wallet</button> : <span className="muted small">Wallet locked</span>}
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div><span className="eyebrow">TRON TESTNET WORKSPACE</span><h1>{activeTab === 'overview' ? 'Wallet overview' : activeTab === 'send' ? 'Send testnet assets' : 'Transaction activity'}</h1></div>
          <div className="topbar-actions"><span className="network-chip"><i/> {NETWORKS[network].label}</span>{unlocked && <button className="outline-button" onClick={lockWallet}><LogOut size={15}/> Lock</button>}</div>
        </header>

        <div className="content">
          <section className="notice notice-warning"><AlertTriangle size={18}/><div><b>Testnet assets only</b><p>Transfers are signed locally and broadcast to Nile or Shasta. They do not create official Mainnet Tether deposits or credits in third-party exchange ledgers.</p></div></section>
          {notice && <div className="notice notice-success" role="status"><CheckCircle2 size={17}/><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss notice"><X size={15}/></button></div>}
          {error && <div className="notice notice-error" role="alert"><AlertTriangle size={17}/><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error"><X size={15}/></button></div>}

          {!walletRecord || !unlocked ? (
            <section className="panel wallet-access">
              <div className="panel-heading"><div><span className="eyebrow">DEVICE-LOCAL WALLET</span><h2>{walletRecord ? 'Unlock your wallet' : 'Create or import a wallet'}</h2><p>Private keys are encrypted in this browser. They are never sent to Tron Token Studio or a backend server.</p></div><div className="panel-icon"><LockKeyhole/></div></div>
              {walletRecord ? (
                <div className="form-stack">
                  <div className="address-box"><span>Saved wallet address</span><b>{walletRecord.address}</b></div>
                  <label>Wallet password<input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password"/></label>
                  <button className="primary-button" disabled={busy || !password} onClick={() => perform(unlockWallet)}><LockKeyhole size={17}/> Unlock wallet</button>
                  <div className="button-row"><button className="text-button" onClick={() => setWalletMode('restore')}>Restore another encrypted backup</button><button className="text-button danger-text" onClick={() => perform(removeWallet)}>Remove local wallet</button></div>
                  {walletMode === 'restore' && <><label>Encrypted backup JSON<textarea value={backupText} onChange={e => setBackupText(e.target.value)} rows={4}/></label><button className="secondary-button" onClick={() => perform(restoreWallet)}>Restore backup</button></>}
                </div>
              ) : (
                <div className="form-stack">
                  <div className="segmented"><button className={walletMode === 'import' ? 'selected' : ''} onClick={() => setWalletMode('import')}>Import private key</button><button className={walletMode === 'create' ? 'selected' : ''} onClick={() => setWalletMode('create')}>Generate wallet</button><button className={walletMode === 'restore' ? 'selected' : ''} onClick={() => setWalletMode('restore')}>Restore backup</button></div>
                  {walletMode === 'import' && <label>Private key <div className="input-with-action"><input type={showKey ? 'text' : 'password'} value={privateKeyInput} onChange={e => setPrivateKeyInput(e.target.value)} autoComplete="off" spellCheck="false" placeholder="64-character hexadecimal private key"/><button type="button" onClick={() => setShowKey(!showKey)} aria-label="Toggle private key visibility">{showKey ? <EyeOff size={17}/> : <Eye size={17}/>}</button></div></label>}
                  {walletMode === 'restore' && <label>Encrypted backup JSON<textarea value={backupText} onChange={e => setBackupText(e.target.value)} rows={4} placeholder="Paste encrypted wallet backup JSON"/></label>}
                  <label>Wallet password<input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" placeholder="At least 12 characters"/></label>
                  <label>Confirm password<input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} autoComplete="new-password"/></label>
                  {walletMode === 'import' && <button className="primary-button" disabled={busy || !privateKeyInput || password.length < 12 || password !== confirmPassword} onClick={() => perform(importWallet)}><KeyRound size={17}/> Encrypt and import locally</button>}
                  {walletMode === 'create' && <button className="primary-button" disabled={busy || password.length < 12 || password !== confirmPassword} onClick={() => perform(createWallet)}><Plus size={17}/> Generate encrypted wallet</button>}
                  {walletMode === 'restore' && <button className="primary-button" disabled={busy || !backupText.trim() || password.length < 12} onClick={() => perform(restoreWallet)}><FileKey2 size={17}/> Restore encrypted backup</button>}
                </div>
              )}
              <p className="fine-print">Use a dedicated testnet wallet. Never import a wallet holding valuable Mainnet assets into an unaudited browser application. Keep an offline backup of your encrypted keystore.</p>
            </section>
          ) : (
            <>
              <section className="wallet-summary">
                <div className="panel balance-card"><div className="panel-heading"><div><span className="eyebrow">UNLOCKED TESTNET ACCOUNT</span><h2>{shorten(unlocked.address)}</h2><a href={explorer} target="_blank" rel="noreferrer">Open address explorer <ExternalLink size={13}/></a></div><div className="panel-icon"><Wallet/></div></div><div className="balance-number">{portfolio ? portfolio.trx : '—'} <small>TRX</small></div><div className="balance-footer"><span>Live balance · {NETWORKS[network].label}</span><button className="icon-button" disabled={balanceBusy} onClick={() => perform(refreshBalances)}><RefreshCw size={16}/>{balanceBusy ? 'Reading…' : 'Refresh'}</button></div></div>
                <div className="panel quick-card"><span className="eyebrow">ACCOUNT STATUS</span><strong className="status-live"><i/> Local wallet unlocked</strong><p>Network: {network.toUpperCase()}<br/>Signing: browser-local<br/>Server key storage: none</p><button className="secondary-button" onClick={() => perform(exportBackup)}><FileKey2 size={16}/> Export encrypted backup</button></div>
              </section>

              {activeTab === 'overview' && (
                <section className="panel">
                  <div className="section-heading"><div><span className="eyebrow">ASSET INSPECTION</span><h2>Testnet assets</h2><p>Balances are read from the selected chain and exact token contracts.</p></div><button className="secondary-button" disabled={balanceBusy} onClick={() => perform(refreshBalances)}><RefreshCw size={16}/> Refresh balances</button></div>
                  <div className="asset-row"><div className="asset-symbol trx-symbol">T</div><div className="asset-name"><b>TRON</b><small>Native testnet TRX</small></div><strong>{portfolio?.trx ?? 'Not loaded'} <small>TRX</small></strong></div>
                  {networkTokens.map(token => { const live = portfolio?.tokens?.find(item => item.contract === token.contract); return <div className="asset-row" key={token.contract}><div className="asset-symbol token-symbol">{token.symbol.slice(0,2)}</div><div className="asset-name"><b>{token.name || token.symbol}</b><small>{token.symbol} · {shorten(token.contract)}</small></div><strong>{live?.balance ?? 'Not loaded'} <small>{token.symbol}</small></strong></div> })}
                  <div className="add-token"><label>Testnet TRC20 contract<input value={tokenInput} onChange={e => setTokenInput(e.target.value)} placeholder="Contract address deployed on this testnet"/></label><button className="secondary-button" disabled={busy || !tokenInput.trim()} onClick={() => perform(addToken)}><Plus size={16}/> Verify and add token</button></div>
                  <p className="fine-print">A token symbol such as USDT does not prove Tether issuance. This screen identifies contracts by their selected testnet address and on-chain metadata.</p>
                </section>
              )}

              {activeTab === 'send' && (
                <section className="panel">
                  <div className="section-heading"><div><span className="eyebrow">ON-CHAIN TESTNET TRANSFER</span><h2>Send / Withdraw</h2><p>Review, sign locally, broadcast to the selected testnet, then verify the solidified receipt.</p></div><div className="panel-icon"><Send/></div></div>
                  <div className="transfer-form">
                    <label>Asset<select value={asset} onChange={e => { setAsset(e.target.value); setReview(null); setAcknowledged(false) }}><option value="TRX">Native testnet TRX</option><option value="TRC20">TRC20 test token</option></select></label>
                    {asset === 'TRC20' && <label>Token contract<select value={tokenAddress || selectedToken?.contract || ''} onChange={e => { setTokenAddress(e.target.value); setReview(null) }}>{networkTokens.map(token => <option key={token.contract} value={token.contract}>{token.symbol} · {shorten(token.contract)}</option>)}</select></label>}
                    <label>Recipient address<input value={recipient} onChange={e => { setRecipient(e.target.value); setReview(null); setAcknowledged(false) }} placeholder="External TRON address (T…)" autoComplete="off" spellCheck="false"/></label>
                    <label>Amount<input value={amount} onChange={e => { setAmount(e.target.value); setReview(null); setAcknowledged(false) }} placeholder="e.g. 10.5" inputMode="decimal"/></label>
                    <div className="button-row"><button className="primary-button" disabled={busy || !canReview} onClick={() => perform(prepareTransfer)}><ShieldCheck size={17}/> Review transfer</button><button className="secondary-button" onClick={() => { setRecipient(''); setAmount(''); setReview(null); setAcknowledged(false) }}>Clear</button></div>
                  </div>
                  {review && <div className="review-card"><div className="review-heading"><ShieldCheck/><div><b>Review exact transaction</b><small>No transaction has been signed or broadcast yet.</small></div></div><dl><div><dt>Network</dt><dd>{NETWORKS[review.network].label}</dd></div><div><dt>From</dt><dd>{review.from}</dd></div><div><dt>To</dt><dd>{review.to}</dd></div><div><dt>Asset / amount</dt><dd>{review.amount} {review.symbol}</dd></div><div><dt>Contract</dt><dd>{review.tokenContract || 'Native TRX'}</dd></div><div><dt>Fee cap</dt><dd>{formatUnits(review.feeLimitSun, 6)} TRX</dd></div>{review.energyRequired && <div><dt>Estimated energy</dt><dd>{review.energyRequired.toLocaleString()}</dd></div>}</dl><label className="acknowledge"><input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)}/> I verified the network, recipient, token contract and amount.</label><button className="primary-button send-button" disabled={busy || !acknowledged} onClick={() => perform(sendTransfer)}><Send size={17}/> Sign and broadcast testnet transaction</button></div>}
                  <p className="fine-print">This sends only from the unlocked wallet's own testnet balance. The recipient must support the same testnet and token contract. An exchange's Mainnet deposit account is not credited by a testnet transaction.</p>
                </section>
              )}

              {activeTab === 'activity' && (
                <section className="panel">
                  <div className="section-heading"><div><span className="eyebrow">CHAIN-VERIFIED HISTORY</span><h2>Transaction activity</h2><p>Each record is checked against the selected network. Local history alone is not proof.</p></div></div>
                  {history.filter(item => item.network === network).length === 0 ? <div className="empty-state"><Activity size={28}/><b>No testnet transactions saved</b><p>Broadcast a testnet transfer to see its transaction ID and verification state here.</p></div> : history.filter(item => item.network === network).map(item => <article className="history-item" key={item.txid}><div className="history-icon"><ArrowUpRight size={17}/></div><div className="history-main"><b>{item.amount} {item.symbol || item.asset}</b><small>To {shorten(item.to)} · {new Date(item.submittedAt).toLocaleString()}</small><span className={'status-text ' + (item.status === 'verified-on-chain' ? 'good' : item.status === 'failed' ? 'bad' : '')}>{item.status} · {item.verification || 'not yet verified'}</span><a href={txUrl(item.network,item.txid)} target="_blank" rel="noreferrer">View on {item.network} TronScan <ExternalLink size={12}/></a></div><div className="history-actions"><button className="icon-button" disabled={busy} onClick={() => perform(() => refreshOne(item))}><RefreshCw size={15}/> Verify</button><button className="icon-button" onClick={() => navigator.clipboard?.writeText(item.txid)}><Copy size={15}/> Copy ID</button></div></article>)}
                </section>
              )}
            </>
          )}
          <footer className="app-footer">TRON TRANSFER · TESTNET-ONLY WALLET · NILE / SHASTA</footer>
        </div>
      </main>
    </div>
  )
}
