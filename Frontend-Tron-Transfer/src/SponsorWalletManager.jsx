import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, ArrowDownUp, CheckCircle2, CircleAlert, FileKey2, LockKeyhole, LogOut, RefreshCw, ShieldCheck, UnlockKeyhole, Wallet } from 'lucide-react'
import {
  createSponsorTronWeb, deriveSponsorAccount, hasSavedSponsorWallet,
  removeSavedSponsorWallet, saveSponsorWalletVault, unlockSponsorWalletVault,
} from './sponsor-wallet-vault.mjs'
import './sponsor-wallet.css'

const OWNER_ADDRESS = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const SUN = 1_000_000
const API_BASE = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? '' : 'https://trc20-usdt-token-cloner-api.onrender.com')).replace(/\/+$/, '')
const ACTIVITY_KEY = 'tron-transfer.sponsor-activity.v1'

function formatAmount(value, digits = 6) {
  const amount = Number(value || 0) / SUN
  return Number.isFinite(amount) ? amount.toLocaleString(undefined, { maximumFractionDigits: digits }) : '—'
}

function parseTrx(value) {
  const text = String(value || '').trim()
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(text)) throw new Error('Enter a valid TRX amount with up to 6 decimal places.')
  const [whole, fraction = ''] = text.split('.')
  const sun = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))
  if (sun <= 0n || sun > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('The TRX amount is outside the supported range.')
  return Number(sun)
}

function CenterToast({ toast, onClose }) {
  if (!toast) return null
  return <div className="sponsor-toast-backdrop" role="presentation">
    <div className={`sponsor-toast ${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
      {toast.kind === 'error' ? <CircleAlert/> : <CheckCircle2/>}
      <div><b>{toast.title}</b><p>{toast.message}</p></div>
      <button type="button" aria-label="Dismiss notification" onClick={onClose}>×</button>
    </div>
  </div>
}

export default function SponsorWalletManager() {
  const [wallet, setWallet] = useState(null)
  const [saved, setSaved] = useState(false)
  const [replacing, setReplacing] = useState(false)
  const [mode, setMode] = useState('private-key')
  const [credential, setCredential] = useState('')
  const [keystorePassword, setKeystorePassword] = useState('')
  const [vaultPassword, setVaultPassword] = useState('')
  const [unlockPassword, setUnlockPassword] = useState('')
  const [amount, setAmount] = useState('10')
  const [resourceType, setResourceType] = useState('ENERGY')
  const [snapshot, setSnapshot] = useState(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState(null)
  const [lastTx, setLastTx] = useState('')
  const [lastDelegation, setLastDelegation] = useState(null)
  const [activity, setActivity] = useState([])
  const toastTimer = useRef(null)

  const notify = useCallback((kind, title, message) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    setToast({ kind, title, message })
    toastTimer.current = window.setTimeout(() => setToast(null), 4800)
  }, [])

  useEffect(() => () => { if (toastTimer.current) window.clearTimeout(toastTimer.current) }, [])

  const recordActivity = useCallback((entry) => {
    setActivity((previous) => {
      const next = [entry, ...previous.filter((item) => item.transactionId !== entry.transactionId)].slice(0, 50)
      try { localStorage.setItem(ACTIVITY_KEY + ':' + entry.sponsorAddress, JSON.stringify(next)) } catch { /* local history is best-effort */ }
      return next
    })
  }, [])

  useEffect(() => {
    if (!wallet?.address) return
    try {
      const stored = JSON.parse(localStorage.getItem(ACTIVITY_KEY + ':' + wallet.address) || '[]')
      const rows = Array.isArray(stored) ? stored.filter((item) => item && item.sponsorAddress === wallet.address).slice(0, 50) : []\n      setActivity(rows)\n      setLastDelegation(rows.find((item) => item.action === 'delegate' && item.status !== 'solidified-mainnet-verified') || null)
    } catch { setActivity([]) }
  }, [wallet?.address])\n\n  useEffect(() => {\n    if (!wallet?.address || !API_BASE) return undefined\n    let cancelled = false\n    const loadVerifiedHistory = async () => {\n      try {\n        const response = await fetch(API_BASE + '/api/tron/sponsorship/resource-delegations?network=mainnet&limit=100', { cache: 'no-store' })\n        if (!response.ok) return\n        const payload = await response.json()\n        if (cancelled || !Array.isArray(payload.delegations)) return\n        for (const row of payload.delegations.filter((item) => item.sponsorAddress === wallet.address)) {\n          recordActivity({ transactionId: row.transactionId, sponsorAddress: row.sponsorAddress, receiverAddress: row.receiverAddress, resourceType: row.resourceType, stakeEquivalentSun: row.stakeEquivalentSun, action: 'delegate', status: 'solidified-mainnet-verified', blockNumber: row.blockNumber, createdAt: row.recordedAt || new Date().toISOString() })\n        }\n      } catch { /* The local audit history remains available if the API is offline. */ }\n    }\n    void loadVerifiedHistory()\n    return () => { cancelled = true }\n  }, [wallet?.address, recordActivity])

  useEffect(() => { setSaved(hasSavedSponsorWallet()) }, [])

  const tronWeb = useMemo(() => wallet ? createSponsorTronWeb(wallet.privateKey) : null, [wallet])

  const refresh = useCallback(async ({ quiet = false } = {}) => {
    if (!wallet || !tronWeb) return
    setBusy(true)
    try {
      const [balance, resources, account, usdtContract, ownerResources, maxEnergyDelegation, maxBandwidthDelegation] = await Promise.all([
        tronWeb.trx.getBalance(wallet.address),
        tronWeb.trx.getAccountResources(wallet.address),
        tronWeb.trx.getAccount(wallet.address),
        tronWeb.contract().at(USDT_CONTRACT),
        tronWeb.trx.getAccountResources(OWNER_ADDRESS),
        tronWeb.trx.getCanDelegatedMaxSize(wallet.address, 'ENERGY', { confirmed: true }),
        tronWeb.trx.getCanDelegatedMaxSize(wallet.address, 'BANDWIDTH', { confirmed: true }),
      ])
      const usdtRaw = await usdtContract.balanceOf(wallet.address).call()
      const delegated = await tronWeb.trx.getDelegatedResourceV2(wallet.address, OWNER_ADDRESS, { confirmed: true }).catch(() => ({ delegatedResource: [] }))
      const rows = Array.isArray(delegated) ? delegated : (Array.isArray(delegated?.delegatedResource) ? delegated.delegatedResource : [])
      const delegatedEnergySun = rows.reduce((sum, row) => sum + BigInt(row.frozen_balance_for_energy || 0), 0n)
      const delegatedBandwidthSun = rows.reduce((sum, row) => sum + BigInt(row.frozen_balance_for_bandwidth || 0), 0n)
      setSnapshot({
        trxSun: String(balance),
        usdt: String(usdtRaw),
        energyLimit: Number(resources.EnergyLimit || 0),
        energyUsed: Number(resources.EnergyUsed || 0),
        netLimit: Number(resources.NetLimit || 0),
        netUsed: Number(resources.NetUsed || 0),
        freeNetLimit: Number(resources.freeNetLimit || 0),
        freeNetUsed: Number(resources.freeNetUsed || 0),
        delegatedEnergySun: delegatedEnergySun.toString(),
        delegatedBandwidthSun: delegatedBandwidthSun.toString(),
        ownerEnergyAvailable: Math.max(0, Number(ownerResources.EnergyLimit || 0) - Number(ownerResources.EnergyUsed || 0)),
        ownerBandwidthAvailable: Math.max(0, Number(ownerResources.NetLimit || 0) - Number(ownerResources.NetUsed || 0)) + Math.max(0, Number(ownerResources.freeNetLimit || 0) - Number(ownerResources.freeNetUsed || 0)),
        maxEnergyDelegatableSun: String(maxEnergyDelegation?.max_size || '0'),
        maxBandwidthDelegatableSun: String(maxBandwidthDelegation?.max_size || '0'),
        activated: Boolean(account?.address),
        checkedAt: new Date().toISOString(),
      })
      if (!quiet) notify('success', 'Sponsor wallet refreshed', 'Balances and current Mainnet resource counters were read from the TRON node.')
    } catch (error) {
      if (!quiet) notify('error', 'Live refresh failed', error instanceof Error ? error.message : 'Could not read Sponsor Wallet data.')
    } finally {
      setBusy(false)
    }
  }, [wallet, tronWeb, notify])

  useEffect(() => { if (wallet) void refresh({ quiet: true }) }, [wallet, refresh])

  useEffect(() => {
    if (!wallet) return undefined
    const timer = window.setInterval(() => { void refresh({ quiet: true }) }, 60_000)
    return () => window.clearInterval(timer)
  }, [wallet, refresh])

  async function importWallet() {
    setBusy(true)
    try {
      const account = await deriveSponsorAccount({ mode, value: credential, secretPassword: keystorePassword })
      if (account.address === OWNER_ADDRESS) throw new Error('The Sponsor Wallet must be independent from the existing Owner Wallet.')
      await saveSponsorWalletVault(account, vaultPassword)
      setWallet(account)
      setSaved(true)
      setReplacing(false)
      setCredential('')
      setKeystorePassword('')
      setVaultPassword('')
      setSnapshot(null)
      notify('success', 'Sponsor Wallet imported', `TRON Mainnet address verified: ${account.address}`)
    } catch (error) {
      notify('error', 'Wallet import failed', error instanceof Error ? error.message : 'Unable to import the Sponsor Wallet.')
    } finally {
      setBusy(false)
    }
  }


  async function unlockWallet() {
    setBusy(true)
    try {
      const account = await unlockSponsorWalletVault(unlockPassword)
      if (account.address === OWNER_ADDRESS) throw new Error('The saved Sponsor Wallet must be independent from the Owner Wallet.')
      setWallet(account)
      setUnlockPassword('')
      setSnapshot(null)
      notify('success', 'Sponsor Wallet unlocked', account.address)
    } catch (error) {
      notify('error', 'Unlock failed', error instanceof Error ? error.message : 'Unable to unlock the Sponsor Wallet.')
    } finally {
      setBusy(false)
    }
  }

  function lockWallet() {
    setWallet(null)
    setSnapshot(null)
    setLastTx('')
    setLastDelegation(null)
    notify('success', 'Sponsor Wallet locked', 'The in-memory signing key was released. The encrypted local backup remains available to unlock.')
  }

  function logoutWallet() {
    setWallet(null)
    setSnapshot(null)
    setLastTx('')
    setLastDelegation(null)
    notify('success', 'Sponsor Wallet logged out', 'The active session is disconnected. Your encrypted local backup is retained.')
  }

  function beginReplace() {
    setWallet(null)
    setSnapshot(null)
    setLastTx('')
    setLastDelegation(null)
    setSaved(false)
    setReplacing(true)
    setMode('private-key')
    notify('info', 'Replace Sponsor Wallet', 'Import the replacement account. The current encrypted backup remains until the new import succeeds.')
  }

  function removeVault() {
    if (!window.confirm('Remove the encrypted Sponsor Wallet backup from this browser? This does not affect the on-chain wallet. Make sure you have your own recovery backup.')) return
    removeSavedSponsorWallet()
    setSaved(false)
    setWallet(null)
    setSnapshot(null)
    notify('success', 'Local wallet backup removed', 'No on-chain account or funds were changed.')
  }

  async function submitResourceTransaction(action) {
    if (!wallet || !tronWeb || busy) return
    let amountSun
    try { amountSun = parseTrx(amount) } catch (error) { notify('error', 'Invalid resource amount', error.message); return }
    if (amountSun < SUN) { notify('error', 'Minimum Stake 2.0 amount', 'Use at least 1 TRX for staking or resource delegation.'); return }
    const available = BigInt(snapshot?.trxSun || '0')
    if (available < BigInt(amountSun) + 1_000_000n) { notify('error', 'Insufficient TRX reserve', 'Keep at least 1 TRX available for network fees. The requested amount cannot consume the full Sponsor Wallet balance.'); return }
    if (action === 'delegate') {
      const maxDelegatable = BigInt(resourceType === 'ENERGY' ? snapshot?.maxEnergyDelegatableSun || '0' : snapshot?.maxBandwidthDelegatableSun || '0')
      if (BigInt(amountSun) > maxDelegatable) { notify('error', 'Insufficient delegatable stake', 'The requested resource amount exceeds the sponsor wallet\'s confirmed Stake 2.0 delegation ceiling. Stake TRX for this resource first or reduce the amount.'); return }
    }
    const verb = action === 'stake' ? 'stake' : 'delegate'
    const target = action === 'stake' ? wallet.address : OWNER_ADDRESS
    const prompt = action === 'stake'
      ? `Stake ${amount} TRX for ${resourceType} in Sponsor Wallet ${wallet.address}?`
      : `Delegate ${amount} TRX-equivalent of ${resourceType} from Sponsor Wallet ${wallet.address} to Owner Wallet ${OWNER_ADDRESS}?`
    if (!window.confirm(`${prompt}

This is a real TRON Mainnet transaction. Network fees may consume TRX. Continue?`)) return
    setBusy(true)
    try {
      const unsigned = action === 'stake'
        ? await tronWeb.transactionBuilder.freezeBalanceV2(amountSun, resourceType, target)
        : await tronWeb.transactionBuilder.delegateResource(amountSun, target, resourceType, wallet.address, false, 0)
      if (!unsigned?.txID || !unsigned?.raw_data_hex) throw new Error('The TRON node returned an incomplete transaction. Nothing was signed.')
      const signed = await tronWeb.trx.sign(unsigned, wallet.privateKey)
      if (!signed?.signature?.length || signed.txID !== unsigned.txID) throw new Error('Signed transaction identity validation failed. Nothing was broadcast.')
      const result = await tronWeb.trx.sendRawTransaction(signed)
      if (result?.result !== true) throw new Error(result?.message ? String(result.message) : 'The TRON node rejected the transaction broadcast.')
      const transactionId = String(result.txid || signed.txID)
      setLastTx(transactionId)
      const event = { transactionId, sponsorAddress: wallet.address, receiverAddress: target, action, resourceType, stakeEquivalentSun: String(amountSun), status: 'broadcast-pending-verification', createdAt: new Date().toISOString() }
      recordActivity(event)
      if (action === 'delegate') setLastDelegation(event)
      notify('success', `${verb[0].toUpperCase() + verb.slice(1)} transaction broadcast`, `Transaction ID: ${transactionId}. Use Verify Mainnet delegation after the transaction is solidified.`)
      await refresh({ quiet: true })
    } catch (error) {
      notify('error', 'Resource transaction failed', error instanceof Error ? error.message : 'The transaction was not completed.')
    } finally {
      setBusy(false)
    }
  }

  async function verifyLastDelegation() {
    if (!lastDelegation || busy) return
    if (!API_BASE) { notify('error', 'Verification API unavailable', 'Configure VITE_API_BASE_URL for the Tron Transfer backend before requesting independent solidified verification.'); return }
    setBusy(true)
    try {
      const response = await fetch(API_BASE + '/api/tron/sponsorship/resource-delegations/verify-wallet', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ network: 'mainnet', transactionId: lastDelegation.transactionId, sponsorAddress: lastDelegation.sponsorAddress, receiverAddress: lastDelegation.receiverAddress, resourceType: lastDelegation.resourceType, stakeEquivalentSun: lastDelegation.stakeEquivalentSun }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.verified !== true || payload.persistence?.persisted !== true) {
        const detail = payload.message || payload.verification?.reason || payload.error || ('Verification service returned HTTP ' + response.status + '.')
        recordActivity({ ...lastDelegation, status: 'verification-pending', verificationMessage: detail })
        notify('error', 'Mainnet verification not complete', detail)
        return
      }
      const verified = { ...lastDelegation, status: 'solidified-mainnet-verified', blockNumber: payload.verification.blockNumber, verifiedAt: payload.verification.checkedAt }
      recordActivity(verified)
      setLastDelegation(null)
      notify('success', 'Delegation independently verified', 'Solidified Mainnet block ' + payload.verification.blockNumber + '; verified record persisted in the project audit ledger.')
      await refresh({ quiet: true })
    } catch (error) {
      notify('error', 'Mainnet verification unavailable', error instanceof Error ? error.message : 'Could not reach the verification service.')
    } finally { setBusy(false) }
  }

  const energyAvailable = Math.max(0, (snapshot?.energyLimit || 0) - (snapshot?.energyUsed || 0))
  const bandwidthAvailable = Math.max(0, (snapshot?.netLimit || 0) - (snapshot?.netUsed || 0))
  const freeBandwidthAvailable = Math.max(0, (snapshot?.freeNetLimit || 0) - (snapshot?.freeNetUsed || 0))

  return <section className="sponsor-manager">
    <CenterToast toast={toast} onClose={() => setToast(null)}/>
    <header className="sponsor-manager-header">
      <div><span className="sponsor-eyebrow">INTEGRATED WALLET · TRON MAINNET</span><h2>TRON TRANSFER SPONSOR</h2><p>Independent sponsor account · Energy and Bandwidth management for the existing Owner Wallet.</p></div>
      <span className="sponsor-network-pill"><i/> TRON MAINNET</span>
    </header>

    {!wallet && !saved && <section className="sponsor-card">
      <div className="sponsor-card-heading"><Wallet/><div><h3>Import existing Sponsor Wallet</h3><p>No wallet creation. Credentials are processed in this browser and encrypted before local storage.</p></div></div>
      <div className="sponsor-import-tabs">{[['private-key','Private key'],['keystore','Keystore JSON'],['mnemonic','Mnemonic phrase']].map(([id,label]) => <button key={id} className={mode === id ? 'active' : ''} onClick={() => {setMode(id);setCredential('')}}>{label}</button>)}</div>
      {mode === 'keystore'
        ? <label className="sponsor-field">Keystore JSON file<input type="file" accept=".json,application/json" onChange={async event => setCredential(await event.target.files?.[0]?.text() || '')}/><small>Standard V3 JSON keystore format.</small></label>
        : <label className="sponsor-field">{mode === 'private-key' ? 'Private key' : 'Recovery mnemonic phrase'}<textarea value={credential} onChange={event => setCredential(event.target.value)} rows={mode === 'mnemonic' ? 3 : 2} autoComplete="off" spellCheck="false" placeholder={mode === 'private-key' ? 'Paste private key locally' : 'Enter recovery words locally'}/></label>}
      {mode === 'keystore' && <label className="sponsor-field">Keystore password<input type="password" value={keystorePassword} onChange={event => setKeystorePassword(event.target.value)} autoComplete="new-password"/></label>}
      <label className="sponsor-field">New local vault password<input type="password" value={vaultPassword} onChange={event => setVaultPassword(event.target.value)} minLength={12} autoComplete="new-password"/><small>At least 12 characters. It encrypts the private key with AES-256-GCM and PBKDF2-SHA256 in this browser.</small></label>
      <div className="sponsor-actions"><button className="sponsor-primary" disabled={busy || !credential.trim() || vaultPassword.length < 12} onClick={() => void importWallet()}>{busy ? 'Importing securely…' : 'Import & encrypt Sponsor Wallet'}</button>{replacing && <button className="sponsor-secondary" onClick={() => {setSaved(hasSavedSponsorWallet());setReplacing(false)}}>Cancel replacement</button>}</div>
      <p className="sponsor-security-note"><ShieldCheck/> Never paste credentials into chat. The private key is not sent to the Tron Transfer API. Browser storage is device-specific; keep your original recovery backup safe.</p>
    </section>}

    {!wallet && saved && <section className="sponsor-card sponsor-unlock-card">
      <div className="sponsor-card-heading"><LockKeyhole/><div><h3>Encrypted Sponsor Wallet saved</h3><p>Unlock this browser's encrypted wallet backup, or replace it by importing another account.</p></div></div>
      <label className="sponsor-field">Vault password<input type="password" value={unlockPassword} onChange={event => setUnlockPassword(event.target.value)} autoComplete="current-password"/></label>
      <div className="sponsor-actions"><button className="sponsor-primary" disabled={busy || !unlockPassword} onClick={() => void unlockWallet()}><UnlockKeyhole size={16}/> {busy ? 'Unlocking…' : 'Unlock Sponsor Wallet'}</button><button className="sponsor-secondary" onClick={() => {setSaved(false);setMode('private-key')}}>Replace / import another</button></div>
      <button className="sponsor-danger-link" onClick={removeVault}>Remove encrypted local backup</button>
    </section>}

    {wallet && <div className="sponsor-dashboard">
      <section className="sponsor-card sponsor-wallet-summary">
        <div className="sponsor-card-heading"><Wallet/><div><h3>Sponsor Wallet Overview</h3><p>{wallet.address}</p></div></div>
        <div className="sponsor-wallet-actions"><span className="sponsor-status"><i/> Imported · Unlocked</span><button onClick={() => void refresh()} disabled={busy}><RefreshCw size={15}/> Refresh</button><button onClick={lockWallet}><LockKeyhole size={15}/> Lock</button><button onClick={logoutWallet}><LogOut size={15}/> Logout</button><button onClick={beginReplace}>Replace</button></div>
        <div className="sponsor-metric-grid">
          <article><small>TRX BALANCE</small><strong>{snapshot ? formatAmount(snapshot.trxSun) : '—'}</strong></article>
          <article><small>OFFICIAL USDT</small><strong>{snapshot ? (Number(snapshot.usdt) / 1e6).toLocaleString(undefined,{maximumFractionDigits:6}) : '—'}</strong></article>
          <article><small>ENERGY AVAILABLE</small><strong>{snapshot ? energyAvailable.toLocaleString() : '—'}</strong><small>{snapshot ? `${snapshot.energyUsed.toLocaleString()} used / ${snapshot.energyLimit.toLocaleString()} limit` : 'Refresh to read'}</small></article>
          <article><small>BANDWIDTH AVAILABLE</small><strong>{snapshot ? (bandwidthAvailable + freeBandwidthAvailable).toLocaleString() : '—'}</strong><small>{snapshot ? `${bandwidthAvailable.toLocaleString()} staked + ${freeBandwidthAvailable.toLocaleString()} free` : 'Refresh to read'}</small></article>
        </div>
        <p className="sponsor-muted">Owner recipient: <code>{OWNER_ADDRESS}</code></p>
        {snapshot?.checkedAt && <p className="sponsor-muted">Last live check: {new Date(snapshot.checkedAt).toLocaleString()}</p>}
        {lastTx && <p className="sponsor-tx-link">Last transaction: <a href={`https://tronscan.org/#/transaction/${lastTx}`} target="_blank" rel="noreferrer">{lastTx}</a></p>}
      </section>

      <section className="sponsor-card">
        <div className="sponsor-card-heading"><ArrowDownUp/><div><h3>Resource Management</h3><p>Stake sponsor-owned TRX or delegate already-staked resources to the existing Owner Wallet.</p></div></div>
        <div className="sponsor-resource-controls">
          <label className="sponsor-field">Amount (TRX)<input inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)}/></label>
          <label className="sponsor-field">Resource<select value={resourceType} onChange={event => setResourceType(event.target.value)}><option value="ENERGY">Energy</option><option value="BANDWIDTH">Bandwidth</option></select></label>
        </div>
        <div className="sponsor-actions"><button className="sponsor-secondary" disabled={busy || !snapshot} onClick={() => void submitResourceTransaction('stake')}>Stake TRX for {resourceType}</button><button className="sponsor-primary" disabled={busy || !snapshot} onClick={() => void submitResourceTransaction('delegate')}>Delegate {resourceType} to Owner</button><button className="sponsor-secondary" disabled={busy || !lastDelegation} onClick={() => void verifyLastDelegation()}>Verify Mainnet delegation</button><button className="sponsor-secondary" disabled title="No authorized Mainnet resource-rental provider is configured">Acquire Energy / Bandwidth · Provider unavailable</button></div>
        <p className="sponsor-muted">Confirmed delegation ceiling: {snapshot ? formatAmount(resourceType === 'ENERGY' ? snapshot.maxEnergyDelegatableSun : snapshot.maxBandwidthDelegatableSun) + ' TRX equivalent' : 'Refresh to read'}.</p><p className="sponsor-warning">These buttons create real Mainnet transactions and can consume TRX fees. Staked TRX is locked under Stake 2.0 rules; delegations are limited by the sponsor's own eligible stake. Incoming delegated resources cannot be re-delegated.</p>
      </section>

      <section className="sponsor-card">
        <div className="sponsor-card-heading"><Activity/><div><h3>Automatic Resource Engine</h3><p>Live owner-resource monitoring and sponsor capacity checks.</p></div></div>
        <div className="sponsor-engine-grid"><div><small>OWNER TARGET</small><strong>{OWNER_ADDRESS}</strong></div><div><small>SPONSOR ENERGY STAKED</small><strong>{snapshot ? formatAmount(snapshot.delegatedEnergySun) + ' TRX eq.' : '—'}</strong></div><div><small>SPONSOR BANDWIDTH STAKED</small><strong>{snapshot ? formatAmount(snapshot.delegatedBandwidthSun) + ' TRX eq.' : '—'}</strong></div><div><small>OWNER ENERGY AVAILABLE</small><strong>{snapshot ? Number(snapshot.ownerEnergyAvailable || 0).toLocaleString() : '—'}</strong></div><div><small>OWNER BANDWIDTH AVAILABLE</small><strong>{snapshot ? Number(snapshot.ownerBandwidthAvailable || 0).toLocaleString() : '—'}</strong></div></div>
        <p className="sponsor-warning">Monitoring is live when refreshed. Automatic unattended signing is intentionally disabled: each stake/delegation requires an explicit on-screen confirmation. A provider rental or free-grant adapter is not configured by this wallet import.</p>
      </section>

      <section className="sponsor-card">
        <div className="sponsor-card-heading"><FileKey2/><div><h3>Sponsor Activity</h3><p>Current browser session and latest observed transaction.</p></div></div>
        <div className="sponsor-activity-row"><span>Wallet connection</span><b>Unlocked locally</b></div>
        <div className="sponsor-activity-row"><span>Network</span><b>TRON Mainnet</b></div>
        <div className="sponsor-activity-row"><span>Resource history</span><b>{activity.length} local records · {activity.filter((item) => item.status === 'solidified-mainnet-verified').length} independently verified</b></div>{activity.slice(0, 8).map((item) => <div className="sponsor-activity-row" key={item.transactionId}><span>{item.action === 'stake' ? 'Stake' : 'Delegation'} · {item.resourceType} · {new Date(item.createdAt).toLocaleString()}</span><b>{item.status === 'solidified-mainnet-verified' ? 'Verified · block ' + item.blockNumber : item.status === 'verification-pending' ? 'Awaiting solidification / retry' : 'Broadcast · not yet verified'} <a href={'https://tronscan.org/#/transaction/' + item.transactionId} target="_blank" rel="noreferrer">View</a></b></div>)}
      </section>
    </div>}
    <CenterToast toast={toast} onClose={() => setToast(null)}/>
  </section>
}
