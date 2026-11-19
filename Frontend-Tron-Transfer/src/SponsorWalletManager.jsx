import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, ArrowDownUp, CheckCircle2, CircleAlert, FileKey2, LockKeyhole, LogOut, RefreshCw, ShieldCheck, UnlockKeyhole, Wallet } from 'lucide-react'
import {
  createSponsorTronWeb, deriveSponsorAccount, hasSavedSponsorWallet,
  removeSavedSponsorWallet, saveSponsorWalletVault, unlockSponsorWalletVault,
} from './sponsor-wallet-vault.mjs'
import './sponsor-wallet.css'

const OWNER_ADDRESS = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const SUN = 1_000_000

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

  const notify = useCallback((kind, title, message) => {
    setToast({ kind, title, message })
    window.setTimeout(() => setToast(null), 4800)
  }, [])

  useEffect(() => { setSaved(hasSavedSponsorWallet()) }, [])

  const tronWeb = useMemo(() => wallet ? createSponsorTronWeb(wallet.privateKey) : null, [wallet])

  const refresh = useCallback(async () => {
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
      const delegated = await tronWeb.trx.getDelegatedResourceV2(wallet.address, OWNER_ADDRESS).catch(() => ({ delegatedResource: [] }))
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
        activated: Boolean(account?.address),
        checkedAt: new Date().toISOString(),
      })
      notify('success', 'Sponsor wallet refreshed', 'Balances and current Mainnet resource counters were read from the TRON node.')
    } catch (error) {
      notify('error', 'Live refresh failed', error instanceof Error ? error.message : 'Could not read Sponsor Wallet data.')
    } finally {
      setBusy(false)
    }
  }, [wallet, tronWeb, notify])

  useEffect(() => { if (wallet) void refresh() }, [wallet, refresh])

  useEffect(() => {
    if (!wallet) return undefined
    const timer = window.setInterval(() => { void refresh() }, 60_000)
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
    notify('success', 'Sponsor Wallet locked', 'The in-memory signing key was released. The encrypted local backup remains available to unlock.')
  }

  function logoutWallet() {
    lockWallet()
    notify('success', 'Sponsor Wallet logged out', 'The active session is disconnected. Your encrypted local backup is retained.')
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
      setLastTx(String(result.txid || signed.txID))
      notify('success', `${verb[0].toUpperCase() + verb.slice(1)} transaction broadcast`, `Transaction ID: ${result.txid || signed.txID}. Refresh after solidification to verify the resulting resources.`)
      await refresh()
    } catch (error) {
      notify('error', 'Resource transaction failed', error instanceof Error ? error.message : 'The transaction was not completed.')
    } finally {
      setBusy(false)
    }
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
      <button className="sponsor-primary" disabled={busy || !credential.trim() || vaultPassword.length < 12} onClick={() => void importWallet()}>{busy ? 'Importing securely…' : 'Import & encrypt Sponsor Wallet'}</button>
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
        <div className="sponsor-wallet-actions"><span className="sponsor-status"><i/> Imported · Unlocked</span><button onClick={() => void refresh()} disabled={busy}><RefreshCw size={15}/> Refresh</button><button onClick={lockWallet}><LockKeyhole size={15}/> Lock</button><button onClick={logoutWallet}><LogOut size={15}/> Logout</button></div>
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
        <div className="sponsor-actions"><button className="sponsor-secondary" disabled={busy || !snapshot} onClick={() => void submitResourceTransaction('stake')}>Stake TRX for {resourceType}</button><button className="sponsor-primary" disabled={busy || !snapshot} onClick={() => void submitResourceTransaction('delegate')}>Delegate {resourceType} to Owner</button><button className="sponsor-secondary" disabled={busy || !snapshot} onClick={() => void refresh()}>Verify delegation state</button></div>
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
        <div className="sponsor-activity-row"><span>Resource history</span><b>{lastTx ? 'Transaction submitted · refresh to inspect chain state' : 'No action recorded in this session'}</b></div>
      </section>
    </div>}
    <CenterToast toast={toast} onClose={() => setToast(null)}/>
  </section>
}
