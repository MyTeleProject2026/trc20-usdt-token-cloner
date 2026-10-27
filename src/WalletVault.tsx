import { useEffect, useMemo, useState } from 'react'
import { Activity, ArrowLeft, CheckCircle2, Copy, Download, Eye, EyeOff, FileKey2, KeyRound, LockKeyhole, Plus, RefreshCw, ShieldCheck, Wallet, X } from 'lucide-react'
import { TronWeb } from 'tronweb'
import {
  decryptWalletPrivateKey,
  encryptWalletPrivateKey,
  isEncryptedWalletRecord,
} from './wallet-vault-crypto.mjs'

type NetworkId = 'mainnet' | 'nile' | 'shasta'
type WalletRecord = {
  format: string
  version: number
  address: string
  createdAt: number
  kdf: { name: string; hash: string; iterations: number; salt: string }
  cipher: { name: string; iv: string; tagLength: number }
  ciphertext: string
}
type UnlockedWallet = { record: WalletRecord; privateKey: string }
type TokenBalance = { contract: string; symbol: string; decimals: number; balance: string; error?: string }
type Portfolio = { trx: string; tokens: TokenBalance[]; checkedAt: number }

const API_BASE = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? '' : 'https://trc20-usdt-token-cloner-api.onrender.com')).replace(/\/+$/, '')
const VAULT_KEY = 'tron-token-studio:encrypted-wallet-vault:v1'
const TOKEN_WATCH_KEY = 'tron-token-studio:token-watchlist:v1'
const SESSION_KEY = 'tron-token-studio:auth-session:v1'
const NETWORK_KEY = 'tron-token-studio:auth-network:v1'
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const PRIVATE_KEY_PATTERN = /^(?:0x)?[0-9a-f]{64}$/i
const RPC: Record<NetworkId, string> = {
  mainnet: 'https://api.trongrid.io',
  nile: 'https://nile.trongrid.io',
  shasta: 'https://api.shasta.trongrid.io',
}
const TOKEN_ABI = [
  { constant: true, inputs: [{ name: 'owner', type: 'address' }], name: 'balanceOf', outputs: [{ name: 'balance', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { constant: true, inputs: [], name: 'decimals', outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view', type: 'function' },
  { constant: true, inputs: [], name: 'symbol', outputs: [{ name: '', type: 'string' }], stateMutability: 'view', type: 'function' },
]

function createTronWeb(network: NetworkId, privateKey?: string): any {
  return new TronWeb({ fullHost: RPC[network], ...(privateKey ? { privateKey } : {}) } as any) as any
}

function readWalletRecords(): WalletRecord[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(VAULT_KEY) || '{}')
    if (parsed?.version !== 1 || !Array.isArray(parsed.wallets)) return []
    return parsed.wallets.filter(isEncryptedWalletRecord) as WalletRecord[]
  } catch {
    return []
  }
}

function readTokenWatchlist(network: NetworkId): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(TOKEN_WATCH_KEY) || '{}')
    const values = parsed?.[network]
    return Array.isArray(values)
      ? [...new Set(values.filter((item: unknown) => typeof item === 'string' && ADDRESS_PATTERN.test(item)))]
      : []
  } catch {
    return []
  }
}

function formatUnits(value: unknown, decimals: number): string {
  try {
    const units = BigInt(String(value))
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return units.toString()
    const scale = 10n ** BigInt(decimals)
    const whole = units / scale
    const remainder = units % scale
    if (remainder === 0n || decimals === 0) return whole.toString()
    const fraction = remainder.toString().padStart(decimals, '0').replace(/0+$/, '')
    return whole.toString() + '.' + fraction
  } catch {
    return String(value ?? '0')
  }
}

function explorerUrl(network: NetworkId, address: string): string {
  const host = network === 'mainnet' ? 'https://tronscan.org' : network === 'nile' ? 'https://nile.tronscan.org' : 'https://shasta.tronscan.org'
  return host + '/#/address/' + encodeURIComponent(address)
}

function shortenAddress(address: string): string {
  return address.length > 16 ? address.slice(0, 8) + '…' + address.slice(-6) : address
}

export default function WalletVault() {
  const [records, setRecords] = useState<WalletRecord[]>(readWalletRecords)
  const [selectedAddress, setSelectedAddress] = useState(() => readWalletRecords()[0]?.address || '')
  const [unlocked, setUnlocked] = useState<UnlockedWallet | null>(null)
  const [network, setNetwork] = useState<NetworkId>('nile')
  const [mode, setMode] = useState<'create' | 'import-key' | 'restore-backup'>('create')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [privateKeyInput, setPrivateKeyInput] = useState('')
  const [backupText, setBackupText] = useState('')
  const [tokenInput, setTokenInput] = useState('')
  const [tokenContracts, setTokenContracts] = useState<string[]>(() => readTokenWatchlist('nile'))
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [busy, setBusy] = useState(false)
  const [balanceLoading, setBalanceLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const selectedRecord = useMemo(() => records.find(item => item.address === selectedAddress) || null, [records, selectedAddress])

  useEffect(() => {
    setTokenContracts(readTokenWatchlist(network))
    setPortfolio(null)
  }, [network])

  useEffect(() => {
    if (!unlocked) return
    let timeout = 0
    const autoLock = () => {
      setUnlocked(null)
      setPortfolio(null)
      setPassword('')
      setConfirmPassword('')
      setNotice('Wallet auto-locked after inactivity or when the app moved to the background. Unlock it again to continue.')
    }
    const resetTimer = () => {
      if (timeout) window.clearTimeout(timeout)
      timeout = window.setTimeout(autoLock, 5 * 60 * 1000)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') autoLock()
    }
    const activityEvents = ['pointerdown', 'keydown', 'touchstart']
    activityEvents.forEach(name => window.addEventListener(name, resetTimer, { passive: true }))
    document.addEventListener('visibilitychange', onVisibilityChange)
    resetTimer()
    return () => {
      if (timeout) window.clearTimeout(timeout)
      activityEvents.forEach(name => window.removeEventListener(name, resetTimer))
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [unlocked])

  useEffect(() => {
    if (!unlocked) {
      setPortfolio(null)
      setBalanceLoading(false)
      return
    }
    let cancelled = false
    const load = async () => {
      setBalanceLoading(true)
      setError('')
      const web = createTronWeb(network)
      try {
        const sun = await web.trx.getBalance(unlocked.record.address)
        const trx = (Number(sun) / 1_000_000).toLocaleString(undefined, {
          minimumFractionDigits: 0,
          maximumFractionDigits: 6,
        })
        const tokens = await Promise.all(tokenContracts.map(async contractAddress => {
          try {
            if (!web.isAddress(contractAddress)) throw new Error('Invalid TRON contract address')
            const contract = await web.contract(TOKEN_ABI, contractAddress)
            const [rawBalance, rawDecimals, rawSymbol] = await Promise.all([
              contract.balanceOf(unlocked.record.address).call(),
              contract.decimals().call(),
              contract.symbol().call().catch(() => 'TRC20'),
            ])
            const decimals = Number(String(rawDecimals))
            const symbol = String(rawSymbol || 'TRC20').slice(0, 32)
            return {
              contract: contractAddress,
              symbol,
              decimals,
              balance: formatUnits(rawBalance, decimals),
            } satisfies TokenBalance
          } catch {
            return { contract: contractAddress, symbol: 'Token', decimals: 0, balance: 'Unavailable', error: 'Balance or token metadata could not be read from this network.' } satisfies TokenBalance
          }
        }))
        if (!cancelled) setPortfolio({ trx, tokens, checkedAt: Date.now() })
      } catch {
        if (!cancelled) {
          setPortfolio(null)
          setError('Could not read this wallet from the selected TRON network. Check the connection or try again.')
        }
      } finally {
        if (!cancelled) setBalanceLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [unlocked, network, tokenContracts, refreshNonce])

  function saveRecord(record: WalletRecord) {
    const next = [...records.filter(item => item.address !== record.address), record]
    window.localStorage.setItem(VAULT_KEY, JSON.stringify({ version: 1, wallets: next }))
    setRecords(next)
    setSelectedAddress(record.address)
    return next
  }

  async function protectAndSave(privateKey: string, address: string, chosenPassword: string) {
    const record = await encryptWalletPrivateKey(privateKey, address, chosenPassword) as WalletRecord
    saveRecord(record)
    setUnlocked({ record, privateKey: privateKey.replace(/^0x/i, '').toLowerCase() })
    setPassword('')
    setConfirmPassword('')
    setPrivateKeyInput('')
    setBackupText('')
    setNotice('Wallet encrypted and saved on this device. Download an encrypted backup before relying on this installation.')
    setError('')
  }

  async function createWallet() {
    if (password.length < 12) throw new Error('Use a wallet password with at least 12 characters.')
    if (password !== confirmPassword) throw new Error('The password confirmation does not match.')
    const web = createTronWeb(network)
    const account = await web.createAccount()
    if (!account || !PRIVATE_KEY_PATTERN.test(String(account.privateKey || '')) || !ADDRESS_PATTERN.test(String(account.address?.base58 || ''))) {
      throw new Error('The wallet SDK did not return a valid local account. Nothing was saved.')
    }
    await protectAndSave(String(account.privateKey), String(account.address.base58), password)
  }

  async function importPrivateKey() {
    if (password.length < 12) throw new Error('Use a wallet password with at least 12 characters.')
    if (password !== confirmPassword) throw new Error('The password confirmation does not match.')
    const key = privateKeyInput.trim().replace(/^0x/i, '')
    if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error('Enter a 64-character hexadecimal private key. It stays in this device and is never sent to the backend.')
    const web = createTronWeb(network, key)
    const address = String(web.defaultAddress?.base58 || '')
    if (!ADDRESS_PATTERN.test(address) || !web.isAddress(address)) throw new Error('The private key could not be converted to a valid TRON wallet address.')
    await protectAndSave(key, address, password)
  }

  async function restoreEncryptedBackup() {
    if (!backupText.trim()) throw new Error('Choose an encrypted TRON Token Studio wallet backup JSON file first.')
    const parsed = JSON.parse(backupText)
    const record = parsed?.wallet || parsed
    if (!isEncryptedWalletRecord(record)) throw new Error('This backup file is not a supported encrypted TRON Token Studio wallet.')
    const key = await decryptWalletPrivateKey(record, password)
    const web = createTronWeb(network, key)
    const derivedAddress = String(web.defaultAddress?.base58 || '')
    if (derivedAddress !== record.address) throw new Error('The decrypted key does not match the address recorded in this backup.')
    saveRecord(record as WalletRecord)
    setUnlocked({ record: record as WalletRecord, privateKey: key })
    setPassword('')
    setBackupText('')
    setNotice('Encrypted backup restored and the wallet is unlocked on this device.')
    setError('')
  }

  async function unlockExistingWallet() {
    if (!selectedRecord) throw new Error('Select a wallet before unlocking it.')
    const key = await decryptWalletPrivateKey(selectedRecord, password)
    const web = createTronWeb(network, key)
    if (String(web.defaultAddress?.base58 || '') !== selectedRecord.address) {
      throw new Error('This encrypted file did not unlock to the expected TRON address.')
    }
    setUnlocked({ record: selectedRecord, privateKey: key })
    setPassword('')
    setError('')
    setNotice('Wallet unlocked. Signing keys remain in application memory until you lock or leave this screen.')
  }

  async function performWalletAction(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Wallet operation failed. No network transaction was submitted.')
    } finally {
      setBusy(false)
    }
  }

  async function loginToWorkspace() {
    if (!unlocked) throw new Error('Unlock a local wallet first.')
    if (network === 'mainnet') throw new Error('The current workspace login gate is testnet-only. Select Nile or Shasta to sign in; this does not move any funds.')
    const address = unlocked.record.address
    const challengeResponse = await fetch(API_BASE + '/api/auth/tron/challenge', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, network }),
      credentials: 'omit',
      cache: 'no-store',
    })
    const challenge = await challengeResponse.json().catch(() => null)
    if (!challengeResponse.ok || challenge?.success !== true || typeof challenge.message !== 'string' || typeof challenge.nonce !== 'string') {
      throw new Error(challenge?.message || challenge?.error || 'The wallet login challenge could not be issued.')
    }
    const signer = createTronWeb(network, unlocked.privateKey)
    const signature = await signer.trx.signMessageV2(challenge.message)
    if (typeof signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(signature)) {
      throw new Error('The wallet SDK did not return a valid message signature.')
    }
    const verifyResponse = await fetch(API_BASE + '/api/auth/tron/verify', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, network, nonce: challenge.nonce, signature }),
      credentials: 'omit',
      cache: 'no-store',
    })
    const verified = await verifyResponse.json().catch(() => null)
    if (!verifyResponse.ok || verified?.success !== true || verified?.authenticated !== true
      || verified.address !== address || verified.network !== network
      || typeof verified.sessionToken !== 'string' || !Number.isFinite(verified.expiresAt)) {
      throw new Error(verified?.message || verified?.error || 'The backend did not verify this wallet signature.')
    }
    window.sessionStorage.setItem(SESSION_KEY, verified.sessionToken)
    window.sessionStorage.setItem(NETWORK_KEY, network)
    window.location.hash = '#/'
  }

  function lockWallet() {
    setUnlocked(null)
    setPassword('')
    setConfirmPassword('')
    setPrivateKeyInput('')
    setPortfolio(null)
    setNotice('Wallet locked. The unencrypted private key was removed from this screen’s React state.')
    setError('')
  }

  function downloadEncryptedBackup() {
    if (!unlocked) return
    const blob = new Blob([JSON.stringify({ wallet: unlocked.record }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'tron-token-studio-wallet-' + unlocked.record.address.slice(0, 8) + '.json'
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    setNotice('Encrypted wallet backup exported. It still requires your wallet password to restore.')
  }

  async function addTokenContract() {
    const contract = tokenInput.trim()
    const web = createTronWeb(network)
    if (!web.isAddress(contract)) throw new Error('Enter a valid TRON contract address for the selected network.')
    if (tokenContracts.includes(contract)) {
      setNotice('This token contract is already in the local watchlist.')
      return
    }
    const next = [...tokenContracts, contract]
    const watchlist = JSON.parse(window.localStorage.getItem(TOKEN_WATCH_KEY) || '{}')
    window.localStorage.setItem(TOKEN_WATCH_KEY, JSON.stringify({ ...watchlist, [network]: next }))
    setTokenContracts(next)
    setTokenInput('')
    setNotice('Token contract added to this device’s read-only watchlist. The contract is not endorsed or allowlisted for transfers.')
  }

  function removeTokenContract(contract: string) {
    const next = tokenContracts.filter(item => item !== contract)
    const watchlist = JSON.parse(window.localStorage.getItem(TOKEN_WATCH_KEY) || '{}')
    window.localStorage.setItem(TOKEN_WATCH_KEY, JSON.stringify({ ...watchlist, [network]: next }))
    setTokenContracts(next)
  }

  async function copyAddress(address: string) {
    try {
      await navigator.clipboard.writeText(address)
      setNotice('Public wallet address copied.')
      setError('')
    } catch {
      setError('Clipboard permission was denied. You can select the public address and copy it manually.')
    }
  }

  async function readBackupFile(file: File | undefined) {
    if (!file) return
    if (file.size > 64 * 1024) {
      setError('The encrypted wallet backup file is unexpectedly large.')
      return
    }
    try {
      setBackupText(await file.text())
      setNotice('Encrypted wallet backup loaded locally. It has not been uploaded.')
      setError('')
    } catch {
      setError('Could not read that wallet backup file.')
    }
  }

  return (
    <main className="wallet-vault-page">
      <header className="wallet-vault-topbar">
        <a className="wallet-vault-brand" href="#/" aria-label="Return to TRON Token Studio workspace">
          <span className="wallet-vault-logo"><Wallet size={22} aria-hidden="true" /></span>
          <span><strong>TRON Token Studio</strong><small>SELF-CUSTODY WALLET</small></span>
        </a>
        <a className="wallet-vault-back" href="#/"><ArrowLeft size={16} aria-hidden="true" /> Workspace</a>
      </header>

      <section className="wallet-vault-hero">
        <p className="wallet-vault-eyebrow"><ShieldCheck size={15} aria-hidden="true" /> LOCAL KEY CUSTODY · REAL TRON NETWORK READS</p>
        <h1>Your wallet. Your keys.</h1>
        <p>Create a new TRON address, import a private key, or restore an encrypted backup. Key creation and encryption happen in this app; the API receives only a public address and a message signature for login.</p>
        <div className="wallet-vault-network" role="group" aria-label="Blockchain network">
          {(['nile', 'shasta', 'mainnet'] as NetworkId[]).map(item => (
            <button type="button" key={item} className={network === item ? 'is-selected' : ''} aria-pressed={network === item} onClick={() => { setNetwork(item); setNotice('Network changed. A wallet address is identical across TRON networks; balances are read separately on the selected network.') }}>
              {item === 'mainnet' ? 'TRON Mainnet' : item === 'nile' ? 'Nile Testnet' : 'Shasta Testnet'}
            </button>
          ))}
        </div>
      </section>

      {error && <div className="wallet-vault-message is-error" role="alert"><X size={17} aria-hidden="true" /> {error}</div>}
      {notice && <div className="wallet-vault-message is-notice" role="status"><CheckCircle2 size={17} aria-hidden="true" /> {notice}</div>}

      <div className="wallet-vault-layout">
        <section className="wallet-vault-panel wallet-vault-setup">
          <div className="wallet-vault-panel-head"><span className="wallet-vault-step">01</span><div><h2>Create or import</h2><p>Keys are generated or decrypted locally.</p></div></div>
          <div className="wallet-vault-mode" role="tablist" aria-label="Wallet setup method">
            <button type="button" role="tab" aria-selected={mode === 'create'} className={mode === 'create' ? 'is-selected' : ''} onClick={() => { setMode('create'); setError(''); setNotice('') }}><Plus size={15} /> Create wallet</button>
            <button type="button" role="tab" aria-selected={mode === 'import-key'} className={mode === 'import-key' ? 'is-selected' : ''} onClick={() => { setMode('import-key'); setError(''); setNotice('') }}><KeyRound size={15} /> Import key</button>
            <button type="button" role="tab" aria-selected={mode === 'restore-backup'} className={mode === 'restore-backup' ? 'is-selected' : ''} onClick={() => { setMode('restore-backup'); setError(''); setNotice('') }}><FileKey2 size={15} /> Restore backup</button>
          </div>

          {mode === 'create' && (
            <div className="wallet-vault-form">
              <p className="wallet-vault-callout">A new random private key is generated on this device using TronWeb. The address is not automatically activated on-chain and has no funds until it receives real assets.</p>
              <label htmlFor="wallet-create-password">Wallet password</label>
              <div className="wallet-vault-password"><input id="wallet-create-password" type={showPassword ? 'text' : 'password'} autoComplete="new-password" minLength={12} value={password} onChange={event => setPassword(event.target.value)} placeholder="At least 12 characters" /><button type="button" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>
              <label htmlFor="wallet-create-confirm">Confirm password</label>
              <input id="wallet-create-confirm" type={showPassword ? 'text' : 'password'} autoComplete="new-password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} placeholder="Re-enter wallet password" />
              <button className="wallet-vault-primary" type="button" disabled={busy} onClick={() => void performWalletAction(createWallet)}><Plus size={17} /> {busy ? 'Creating locally…' : 'Generate encrypted wallet'}</button>
            </div>
          )}

          {mode === 'import-key' && (
            <div className="wallet-vault-form">
              <p className="wallet-vault-callout">The private key is processed locally and encrypted before saving. Never paste a wallet key into chat, a support ticket, or a website you do not trust.</p>
              <label htmlFor="wallet-import-key">Private key (hex)</label>
              <textarea id="wallet-import-key" rows={3} autoComplete="off" spellCheck={false} value={privateKeyInput} onChange={event => setPrivateKeyInput(event.target.value)} placeholder="Paste the 64-character key on this device only" />
              <label htmlFor="wallet-import-password">New local encryption password</label>
              <input id="wallet-import-password" type={showPassword ? 'text' : 'password'} autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} placeholder="At least 12 characters" />
              <label htmlFor="wallet-import-confirm">Confirm password</label>
              <input id="wallet-import-confirm" type={showPassword ? 'text' : 'password'} autoComplete="new-password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} placeholder="Re-enter wallet password" />
              <button className="wallet-vault-primary" type="button" disabled={busy} onClick={() => void performWalletAction(importPrivateKey)}><KeyRound size={17} /> {busy ? 'Encrypting locally…' : 'Encrypt and import wallet'}</button>
            </div>
          )}

          {mode === 'restore-backup' && (
            <div className="wallet-vault-form">
              <p className="wallet-vault-callout">Select a TRON Token Studio encrypted wallet JSON backup. The app reads it locally; the password cannot be reset by the server.</p>
              <label htmlFor="wallet-backup-file">Encrypted backup file</label>
              <input id="wallet-backup-file" type="file" accept=".json,application/json" onChange={event => void readBackupFile(event.target.files?.[0])} />
              <label htmlFor="wallet-backup-password">Wallet password</label>
              <input id="wallet-backup-password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} placeholder="Enter backup password" />
              <button className="wallet-vault-primary" type="button" disabled={busy} onClick={() => void performWalletAction(restoreEncryptedBackup)}><FileKey2 size={17} /> {busy ? 'Restoring locally…' : 'Restore and unlock'}</button>
            </div>
          )}

          <div className="wallet-vault-security-note"><LockKeyhole size={17} /><div><strong>Encrypted locally, not custodial</strong><p>AES-256-GCM with a PBKDF2-SHA-256 password key. The web app does not receive or store your private key. This is password-encrypted web storage, not a hardware-backed mobile keystore.</p></div></div>
        </section>

        <section className="wallet-vault-panel wallet-vault-account">
          <div className="wallet-vault-panel-head"><span className="wallet-vault-step">02</span><div><h2>Wallet vault</h2><p>{records.length} encrypted wallet{records.length === 1 ? '' : 's'} on this device.</p></div></div>

          {records.length > 0 ? (
            <div className="wallet-vault-wallet-list">
              {records.map(record => (
                <button type="button" key={record.address} className={'wallet-vault-wallet-choice' + (selectedAddress === record.address ? ' is-selected' : '')} onClick={() => { setSelectedAddress(record.address); if (unlocked?.record.address !== record.address) setUnlocked(null); setPassword(''); setPortfolio(null); setError(''); setNotice('') }}>
                  <span className="wallet-vault-avatar"><Wallet size={18} /></span>
                  <span className="wallet-vault-wallet-details"><strong>{shortenAddress(record.address)}</strong><small>Saved {new Date(record.createdAt).toLocaleDateString()}</small></span>
                  <span className="wallet-vault-choice-status">{unlocked?.record.address === record.address ? 'Unlocked' : 'Encrypted'}</span>
                </button>
              ))}
              {!unlocked && selectedRecord && (
                <div className="wallet-vault-form wallet-vault-unlock-form">
                  <label htmlFor="wallet-unlock-password">Unlock selected wallet</label>
                  <div className="wallet-vault-password"><input id="wallet-unlock-password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} placeholder="Wallet password" onKeyDown={event => { if (event.key === 'Enter') void performWalletAction(unlockExistingWallet) }} /><button type="button" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>
                  <button className="wallet-vault-primary" type="button" disabled={busy} onClick={() => void performWalletAction(unlockExistingWallet)}><LockKeyhole size={17} /> {busy ? 'Unlocking…' : 'Unlock wallet'}</button>
                </div>
              )}
            </div>
          ) : (
            <div className="wallet-vault-empty"><span className="wallet-vault-empty-icon"><Wallet size={25} /></span><h3>No wallet saved yet</h3><p>Create a new wallet or import an existing key in the first panel. The address does not need USDT to be created.</p></div>
          )}

          {unlocked && (
            <div className="wallet-vault-portfolio">
              <div className="wallet-vault-address-row"><div><small>Public address</small><a href={explorerUrl(network, unlocked.record.address)} target="_blank" rel="noopener noreferrer">{shortenAddress(unlocked.record.address)} ↗</a></div><button type="button" className="wallet-vault-icon-button" aria-label="Copy public address" onClick={() => void copyAddress(unlocked.record.address)}><Copy size={17} /></button></div>
              <div className="wallet-vault-balance">
                <div className="wallet-vault-balance-icon">T</div>
                <div><small>Native TRX balance · {network === 'mainnet' ? 'Mainnet' : network === 'nile' ? 'Nile testnet' : 'Shasta testnet'}</small><strong>{balanceLoading ? 'Reading chain…' : portfolio?.trx ?? '—'} <span>TRX</span></strong><small>Read directly from the selected network; this is not an exchange balance.</small></div>
                <button type="button" className="wallet-vault-icon-button" aria-label="Refresh chain balance" disabled={balanceLoading} onClick={() => setRefreshNonce(value => value + 1)}><RefreshCw size={17} className={balanceLoading ? 'wallet-vault-spinning' : ''} /></button>
              </div>

              <div className="wallet-vault-token-section">
                <div className="wallet-vault-section-title"><div><h3>TRC20 token watchlist</h3><p>Read-only contract queries.</p></div></div>
                <div className="wallet-vault-add-token"><input aria-label="TRC20 token contract address" value={tokenInput} onChange={event => setTokenInput(event.target.value)} placeholder="Token contract address" /><button type="button" disabled={!tokenInput.trim() || busy} onClick={() => void performWalletAction(addTokenContract)}>Add</button></div>
                {tokenContracts.length > 0 && (
                  <div className="wallet-vault-token-list">
                    {(portfolio?.tokens || tokenContracts.map(contract => ({ contract, symbol: 'TRC20', decimals: 0, balance: 'Reading…' }))).map(token => (
                      <div className="wallet-vault-token-row" key={token.contract}>
                        <div><strong>{token.symbol} <span>{token.error ? '· unavailable' : ''}</span></strong><small>{shortenAddress(token.contract)} · {token.error || 'On-chain token balance'}</small></div>
                        <strong className="wallet-vault-token-amount">{token.balance}</strong>
                        <button type="button" className="wallet-vault-icon-button" aria-label={'Remove token ' + token.contract} onClick={() => removeTokenContract(token.contract)}><X size={15} /></button>
                      </div>
                    ))}
                  </div>
                )}
                <p className="wallet-vault-caption">A token symbol or contract address is not proof of legitimacy. This watchlist only reads what the contract reports; it never makes a token authentic or transferable.</p>
              </div>

              <div className="wallet-vault-wallet-actions">
                <button type="button" className="wallet-vault-secondary" onClick={downloadEncryptedBackup}><Download size={16} /> Download encrypted backup</button>
                {network === 'mainnet'
                  ? <button type="button" className="wallet-vault-secondary" disabled><ShieldCheck size={16} /> Workspace login is testnet-only</button>
                  : <button type="button" className="wallet-vault-primary" disabled={busy} onClick={() => void performWalletAction(loginToWorkspace)}><ShieldCheck size={16} /> Sign in to workspace</button>}
                <button type="button" className="wallet-vault-lock" onClick={lockWallet}><LockKeyhole size={16} /> Lock</button>
              </div>
              <p className="wallet-vault-caption"><Activity size={14} /> Workspace login signs a short identity message only. No transfer is authorized or broadcast by this button.</p>
            </div>
          )}
        </section>
      </div>

      <footer className="wallet-vault-footer"><span><ShieldCheck size={15} /> Keys stay on this device</span><span><Activity size={15} /> Real on-chain reads</span><span><LockKeyhole size={15} /> No hidden balance edits</span></footer>
    </main>
  )
}
