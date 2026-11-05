import { useEffect, useMemo, useState } from 'react'
import OwnerWithdrawals from './OwnerWithdrawals.jsx'
import { TronWeb } from 'tronweb'
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, Building2, CheckCircle2, Coins, ExternalLink, History, LockKeyhole, LogOut, RefreshCw, Settings, ShieldCheck, Wallet, X } from 'lucide-react'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'https://trc20-usdt-token-cloner-api.onrender.com').replace(/\/+$/, '')
const MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const MAINNET_MONITORED_ADDRESS = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const OWNER_SESSION_KEY = 'tron-transfer:owner-session:v1'

function shorten(value) { return value && value.length > 18 ? value.slice(0, 9) + '…' + value.slice(-7) : value || '—' }
function isValidAddress(value) {
  try { return ADDRESS_RE.test(String(value || '')) && new TronWeb().isAddress(String(value)) } catch { return false }
}
function formatUnits(value, decimals = 6) {
  try {
    const n = BigInt(String(value ?? '0')), base = 10n ** BigInt(decimals)
    const fraction = (n % base).toString().padStart(decimals, '0').replace(/0+$/, '')
    return n / base + (fraction ? '.' + fraction : '')
  } catch { return 'Unavailable' }
}
async function api(path, options = {}) {
  const response = await fetch(API_BASE + path, {
    ...options,
    headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
    credentials: 'omit', cache: 'no-store', redirect: 'error',
  })
  const body = await response.json().catch(() => null)
  if (!response.ok && response.status !== 202) throw new Error(body?.message || body?.error || 'API request failed.')
  if (!body || typeof body !== 'object') throw new Error('The API returned an unreadable response.')
  if (body.success === false && response.status !== 202) throw new Error(body.message || body.error || 'The API rejected the request.')
  return body
}

export default function App() {
  const [tab,setTab]=useState('recipients')
  const [unlocked,setUnlocked]=useState(null)
  const [monitorAddress,setMonitorAddress]=useState(MAINNET_MONITORED_ADDRESS)
  const [monitorData,setMonitorData]=useState(null)
  const [monitorError,setMonitorError]=useState('')
  const [monitorBusy,setMonitorBusy]=useState(false)
  const addressLink=useMemo(()=>isValidAddress(monitorAddress)?'https://tronscan.org/#/address/'+encodeURIComponent(monitorAddress):null,[monitorAddress])

  async function perform(fn) {
    setBusy(true); setError('')
    try { return await fn() } catch(e) { setError(e instanceof Error?e.message:'Operation failed.'); return null } finally { setBusy(false) }
  }
  async function inspectAddress(address=monitorAddress) {
    if(!isValidAddress(address)) throw new Error('Enter a valid TRON Mainnet address.')
    setMonitorBusy(true); setMonitorError('')
    try {
      const query=new URLSearchParams({network:'mainnet',address,tokenContract:MAINNET_USDT})
      const result=await api('/api/tron-transfer/recipient?'+query.toString())
      setMonitorAddress(address); setMonitorData(result); return result
    } catch(e) {setMonitorError(e.message);throw e} finally {setMonitorBusy(false)}
  }
  async function restoreOwner(token) {
    try {
      const p=await api('/api/auth/owner/session',{headers:{Authorization:'Bearer '+token}})
      if(p.authenticated!==true||p.network!=='mainnet'||!isValidAddress(p.address)||!Number.isFinite(p.expiresAt)||p.expiresAt<=Date.now()) {
        sessionStorage.removeItem(OWNER_SESSION_KEY);setOwnerSession(null);return
      }
      setOwnerSession({address:p.address,expiresAt:p.expiresAt,sessionToken:token})
    } catch {setOwnerSession(null)}
  }
  async function signInOwner() {
    if(!isValidAddress(ownerAddress.trim())||!ownerPassword) throw new Error('Enter the configured owner Mainnet address and password.')
    const p=await api('/api/auth/owner/login',{method:'POST',body:JSON.stringify({address:ownerAddress.trim(),password:ownerPassword})})
    if(p.authenticated!==true||p.network!=='mainnet'||typeof p.sessionToken!=='string'||!Number.isFinite(p.expiresAt)) throw new Error('Owner authentication failed.')
    sessionStorage.setItem(OWNER_SESSION_KEY,p.sessionToken);setOwnerPassword('')
    setOwnerSession({address:p.address,expiresAt:p.expiresAt,sessionToken:p.sessionToken})
    setNotice('Owner session active. Connect the same owner address in TronLink and check its real Mainnet balance before preparing a withdrawal.')
  }
  function signOutOwner(){try{sessionStorage.removeItem(OWNER_SESSION_KEY)}catch{};setOwnerSession(null)}
  const nav=[
    {id:'overview',label:'Dashboard',icon:Wallet},
    {id:'assets',label:'Assets',icon:Coins},
    {id:'recipients',label:'Recipients',icon:ArrowDownLeft},
    {id:'withdrawals',label:'Withdrawals',icon:ArrowUpRight},
    {id:'sponsors',label:'Owner access & funding',icon:Building2},
    {id:'transactions',label:'Transactions',icon:History},
    {id:'settings',label:'Settings',icon:Settings},
  ]

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#"><span className="brand-mark">T</span><span>TRON <b>TRANSFER</b><small>MAINNET USDT PAYOUTS</small></span></a>
      <div className="network-card"><span className="eyebrow">PRODUCTION NETWORK</span><div className="network-chip"><i/> TRON Mainnet</div><span className="network-dot"><i/> OFFICIAL TETHER USDT TRC20</span></div>
      <nav>{nav.map(item=><button key={item.id} className={tab===item.id?'active':''} onClick={()=>setTab(item.id)}><item.icon size={17}/>{item.label}</button>)}</nav>
      <div className="sidebar-bottom"><div className="security-note"><ShieldCheck size={17}/><span>TronLink signing<br/><b>No imported private keys</b></span></div>{unlocked?<button className="outline-button" onClick={lockWallet}><LockKeyhole size={16}/> Disconnect wallet</button>:<span className="muted small">Wallet not connected</span>}</div>
    </aside>
    <main className="main-content">
      <header className="topbar"><div><span className="eyebrow">TRON TRANSFER · PRODUCTION MAINNET</span><h1>{{overview:'Mainnet payout dashboard',assets:'Mainnet assets & sponsor funding',recipients:'Recipient balance & incoming history',withdrawals:'Direct Mainnet USDT withdrawal',sponsors:'Owner access & wallet funding',transactions:'Payout transactions & settlement history',settings:'Platform settings'}[tab]||'Tron Transfer'}</h1></div><div className="topbar-actions"><span className="network-chip"><i/> TRON Mainnet</span>{unlocked&&<button className="outline-button" onClick={lockWallet}><LogOut size={15}/> Lock</button>}</div></header>
      <div className="content">
        <section className="notice notice-warning"><AlertTriangle size={18}/><div><b>Mainnet-only owner-authorized withdrawals</b><p>Tatum provides TRON Mainnet infrastructure. TronLink controls owner approval and signing. Real USDT principal and transaction resources must be present in the sending wallet; withdrawals remain disabled until funding and signing checks are complete.</p></div></section>
        {notice&&<div className="notice notice-success" role="status"><CheckCircle2 size={17}/><span>{notice}</span><button onClick={()=>setNotice('')} aria-label="Dismiss notice"><X size={15}/></button></div>}
        {error&&<div className="notice notice-error" role="alert"><AlertTriangle size={17}/><span>{error}</span><button onClick={()=>setError('')} aria-label="Dismiss error"><X size={15}/></button></div>}

        {tab==='overview'&&<>
          <section className="wallet-summary">
            <div className="panel balance-card"><div className="panel-heading"><div><span className="eyebrow">MONITORED MAINNET ADDRESS</span><h2>{shorten(monitorAddress)}</h2>{addressLink&&<a href={addressLink} target="_blank" rel="noreferrer">Open TRONSCAN <ExternalLink size={13}/></a>}</div><div className="panel-icon"><Wallet/></div></div><div className="balance-number">{monitorData?.tokenBalance?formatUnits(monitorData.tokenBalance.balanceBaseUnits,monitorData.tokenBalance.decimals):'—'} <small>USDT</small></div><div className="balance-footer"><span>Official TRC20 USDT · Mainnet</span><button className="icon-button" disabled={monitorBusy} onClick={()=>perform(()=>inspectAddress())}><RefreshCw size={16}/> Refresh</button></div></div>
            <div className="panel quick-card"><span className="eyebrow">PAYOUT MODEL</span><strong className="status-live"><i/> Sponsor-funded</strong><p>USDT principal and network resources must already be held by the configured owner wallet. TronLink signs each direct Mainnet withdrawal.</p><button className="secondary-button" onClick={()=>setTab('sponsors')}>Open payout workspace</button></div>
          </section>
          <section className="panel"><div className="section-heading"><div><span className="eyebrow">OFFICIAL ASSET</span><h2>Tether USD · TRC20</h2><p>The production asset is pinned to the official TRON Mainnet token contract.</p></div><div className="panel-icon"><ShieldCheck/></div></div><div className="asset-row"><div className="asset-symbol token-symbol">US</div><div className="asset-name"><b>Official Tether USD</b><small>{MAINNET_USDT}</small></div><strong>{monitorData?.tokenBalance?formatUnits(monitorData.tokenBalance.balanceBaseUnits,monitorData.tokenBalance.decimals):'Not loaded'} <small>USDT</small></strong></div><p className="fine-print">Only the official Mainnet contract is supported. This dashboard displays only actual Mainnet balances for the monitored address and does not display simulated tokens.</p></section>
          <section className="panel wallet-access">
            <div className="panel-heading"><div><span className="eyebrow">OWNER WALLET · TRONLINK</span><h2>{unlocked?'TronLink connected':'Connect your TronLink wallet'}</h2><p>TronLink keeps your private key inside the wallet. Tron Transfer requests only account access and explicit message or transaction signatures.</p></div><div className="panel-icon"><Wallet/></div></div>
            {unlocked?<div className="form-stack"><div className="address-box"><span>Connected TRON Mainnet account</span><b>{unlocked.address}</b></div><div className="button-row"><button className="secondary-button" disabled={busy} onClick={()=>perform(connectTronLink)}><RefreshCw size={15}/> Refresh connection</button><button className="outline-button" onClick={lockWallet}><LogOut size={15}/> Disconnect</button></div></div>:<div className="form-stack"><p className="fine-print">Open this application in the TronLink DApp browser on Android, unlock your wallet, then connect. Never paste a private key or recovery phrase into this website.</p><button className="primary-button" disabled={busy} onClick={()=>perform(connectTronLink)}><Wallet size={16}/> Connect TronLink</button></div>}
            <p className="fine-print">Wallet connection alone does not prove owner authorization, fund a balance or enable withdrawals. A separate signature verifies identity, and every transfer requires its own TronLink transaction approval.</p>
          </section>
        </>}

        {tab==='recipients'&&<section className="panel recipient-panel">
          <div className="section-heading"><div><span className="eyebrow">READ-ONLY MAINNET INSPECTION</span><h2>Recipient balance & incoming activity</h2><p>Inspect an exchange or wallet on TRON Mainnet without its private key.</p></div><div className="panel-icon"><ArrowDownLeft/></div></div>
          <div className="transfer-form"><div className="address-box"><span>Network / asset</span><b>TRON Mainnet · Official Tether USDT TRC20</b></div><label className="wide-field">Monitored recipient address<input value={monitorAddress} onChange={e=>{setMonitorAddress(e.target.value);setMonitorData(null);setMonitorError('')}} placeholder="TRON Mainnet address (T…)" autoComplete="off" spellCheck="false"/></label><label className="wide-field">Official USDT contract<input value={MAINNET_USDT} readOnly/></label><div className="button-row wide-field"><button className="primary-button" disabled={monitorBusy||!monitorAddress.trim()} onClick={()=>perform(()=>inspectAddress())}><RefreshCw size={16}/>{monitorBusy?'Checking…':'Inspect Mainnet recipient'}</button><button className="secondary-button" onClick={()=>{setMonitorAddress(MAINNET_MONITORED_ADDRESS);setMonitorData(null);void perform(()=>inspectAddress(MAINNET_MONITORED_ADDRESS))}}>My monitored address</button></div></div>
          {monitorError&&<div className="notice notice-error"><AlertTriangle size={16}/><span>{monitorError}</span></div>}
          {monitorData&&<div className="recipient-results">
            <div className="recipient-balance-grid">
              <article className="metric-card"><span>Native TRX balance</span><strong>{monitorData.nativeBalanceTRX??'Unavailable'} <small>TRX</small></strong></article>
              <article className="metric-card"><span>Official USDT balance</span><strong>{monitorData.tokenBalance?formatUnits(monitorData.tokenBalance.balanceBaseUnits,monitorData.tokenBalance.decimals):'Unavailable'} <small>USDT</small></strong></article>
              <article className="metric-card"><span>Account state</span><strong>{monitorData.accountExists?'Account found':'Not activated / not found'}</strong></article>
              <article className="metric-card"><span>Incoming history</span><strong>{monitorData.historyStatus||'Unavailable'}</strong></article>
            </div>
            <div className="section-heading"><div><span className="eyebrow">CONFIRMED MAINNET ACCOUNT HISTORY</span><h3>Incoming TRC20 activity</h3><p>{monitorData.historyStatus==='complete'?'Mainnet incoming history was retrieved.':monitorData.historyStatus==='partial'?'Only part of the history feed was available.':'History provider did not return a complete result.'}</p></div></div>
            {!monitorData.incomingHistory?.length?<div className="empty-state"><ArrowDownLeft size={25}/><b>No incoming transfers returned</b><p>This provider response is not proof that the address has never received funds.</p></div>:monitorData.incomingHistory.map((item,index)=><article className="history-item" key={item.txid||index}><div className="history-icon incoming"><ArrowDownLeft size={17}/></div><div className="history-main"><b>{item.amountBaseUnits&&item.decimals!==null?formatUnits(item.amountBaseUnits,item.decimals):'Amount unavailable'} {item.symbol||item.asset}</b><small>From {shorten(item.from)} · {item.timestamp?new Date(item.timestamp).toLocaleString():'Timestamp unavailable'}</small><span className={'status-text '+(item.confirmed?'good':'')}>{item.confirmed?'Confirmed':'History candidate'}</span>{item.txid&&<a href={'https://tronscan.org/#/transaction/'+item.txid} target="_blank" rel="noreferrer">View on TRONSCAN <ExternalLink size={12}/></a>}</div></article>)}
          </div>}
          <p className="fine-print">Balance and history reads are Mainnet-only. A withdrawal is not marked complete until Fincra settlement and the exact solidified Tether Transfer are independently verified.</p>
        </section>}

        
        {tab==='assets'&&<section className="assets-page">
          <div className="section-heading"><div><span className="eyebrow">OFFICIAL TRON MAINNET ASSETS</span><h2>Wallet assets</h2><p>Read-only holdings for the monitored address. The live sending-wallet snapshot is shown separately in Direct Withdrawals after owner authentication.</p></div><button className="secondary-button" disabled={busy} onClick={()=>perform(()=>inspectAddress(MAINNET_MONITORED_ADDRESS))}><RefreshCw size={15}/> Refresh monitored balance</button></div>
          <div className="asset-source-grid">
            <article className="panel asset-source-card">
              <span className="eyebrow">MONITORED ADDRESS · READ ONLY</span>
              <h3>{shorten(MAINNET_MONITORED_ADDRESS)}</h3>
              <strong className="asset-large">{monitorData?.tokenBalance?formatUnits(monitorData.tokenBalance.balanceBaseUnits,monitorData.tokenBalance.decimals):'—'} <small>USDT</small></strong>
              <span className="fine-print">Official Tether TRC20 balance from Tatum Mainnet. This read-only card is not a separate treasury and is not added to any other balance.</span>
              <div className="asset-source-meta"><span>TRX: {monitorData?.nativeBalanceTRX??'Not loaded'}</span><span>Account: {monitorData?monitorData.accountExists?'Found':'Not activated / not found':'Not checked'}</span></div>
              <a href={'https://tronscan.org/#/address/'+MAINNET_MONITORED_ADDRESS} target="_blank" rel="noreferrer">Open monitored address on TRONSCAN <ExternalLink size={12}/></a>
            </article>
            <article className="panel asset-source-card">
              <span className="eyebrow">OWNER SENDING WALLET</span>
              <h3>Actual withdrawal balance</h3>
              <p>Connect the configured owner wallet and sign in under Owner access. The Withdrawals page reads its official USDT, TRX, Energy and Bandwidth directly from Tatum Mainnet.</p>
              <button className="primary-button" onClick={()=>setTab('withdrawals')}><ArrowUpRight size={16}/> Open direct withdrawals</button>
            </article>
          </div>
          <div className="panel assets-total-panel">
            <div><span className="eyebrow">OFFICIAL TOKEN IDENTITY</span><h2>USDT · TRON TRC20</h2><p>Only the official Tether Mainnet contract is supported: {MAINNET_USDT}. Test tokens and simulated balances are not included.</p></div>
            <div className="panel-icon"><ShieldCheck/></div>
          </div>
        </section>}

        {tab==='withdrawals'&&<OwnerWithdrawals wallet={unlocked} ownerSession={ownerSession} />}

        {tab==='transactions'&&<OwnerWithdrawals wallet={unlocked} ownerSession={ownerSession} historyOnly />}

        {tab==='settings'&&<section className="panel settings-page">
          <div className="section-heading"><div><span className="eyebrow">PRODUCTION CONFIGURATION</span><h2>Tron Transfer settings</h2><p>Mainnet-only configuration and operator access. Provider secrets remain on the backend and are never stored in this browser.</p></div><div className="panel-icon"><Settings/></div></div>
          <div className="settings-group"><span className="eyebrow">MONITORED ADDRESS</span><div className="address-box"><span>Read-only Mainnet identity</span><b>{MAINNET_MONITORED_ADDRESS}</b></div><a href={'https://tronscan.org/#/address/'+MAINNET_MONITORED_ADDRESS} target="_blank" rel="noreferrer">Open address on TRONSCAN <ExternalLink size={12}/></a><p className="fine-print">The configured sending wallet is authenticated separately and is displayed from the live Tatum snapshot on the Withdrawals page.</p></div>
          <div className="settings-group"><span className="eyebrow">TATUM MAINNET</span><p>Balance reads, unsigned USDT transaction preparation, signed transaction broadcast and solidified receipt verification use the backend Tatum Mainnet Gateway.</p><p className="fine-print">Required backend configuration includes TATUM_MAINNET_API_KEY (or TATUM_API_KEY), DATABASE_URL, OWNER_WALLET_ADDRESS, OWNER_PASSWORD_HASH and the approved frontend origins.</p><button className="secondary-button" onClick={()=>setTab('withdrawals')}><ArrowUpRight size={15}/> Open withdrawal readiness</button></div>
          <div className="settings-group"><span className="eyebrow">WALLET SIGNING</span><p>{unlocked?'TronLink is connected to '+shorten(unlocked.address)+'.':'No TronLink wallet is connected.'}</p><p className="fine-print">The site never asks for a private key or recovery phrase. Every transaction signature must be approved inside TronLink.</p>{unlocked&&<button className="outline-button" onClick={lockWallet}><LockKeyhole size={15}/> Disconnect wallet</button>}</div>
        </section>}

{tab==='sponsors'&&<section className="panel sponsor-panel">
          <div className="section-heading"><div><span className="eyebrow">OWNER AUTHENTICATION · MAINNET SENDER</span><h2>Owner access & wallet funding</h2><p>Only the configured owner address can prepare and authorize direct USDT withdrawals. No sponsor organization or payout provider can silently debit this wallet.</p></div><div className="panel-icon"><ShieldCheck/></div></div>
          <div className="sponsor-admin-card">
            <span className="eyebrow">01 / CONFIGURED OWNER SESSION</span><h3>Owner authentication</h3>
            {!ownerSession?<div className="form-stack"><label>Configured owner Mainnet address<input value={ownerAddress} onChange={e=>setOwnerAddress(e.target.value)} placeholder="T..." autoComplete="off"/></label><label>Owner password<input value={ownerPassword} onChange={e=>setOwnerPassword(e.target.value)} type="password" autoComplete="current-password"/></label><button className="secondary-button" disabled={busy||!ownerAddress.trim()||!ownerPassword} onClick={()=>perform(signInOwner)}><LockKeyhole size={16}/> Sign in as configured owner</button></div>:<div className="owner-session-card"><strong><ShieldCheck size={15}/> Owner session active</strong><small>{shorten(ownerSession.address)} · expires {new Date(ownerSession.expiresAt).toLocaleTimeString()}</small><button className="outline-button" onClick={signOutOwner}>Sign out</button></div>}
          </div>
          <div className="panel sponsor-funding-destination">
            <span className="eyebrow">02 / FUND THE SENDING WALLET</span><h3>Receive real USDT before withdrawing</h3>
            <p>Send genuine Tether USDT on the TRON (TRC20) network to the configured owner wallet from an exchange or another wallet you control, or from an authorized funding source. Use the exact address shown after owner sign-in on the Withdrawals page.</p>
            <p>Keep enough TRX or suitable Energy/Bandwidth resources in that same sending account to pay the network fee. Tatum is blockchain infrastructure only; it does not supply USDT principal, sponsorship funds or TRX.</p>
            <div className="readiness-checks"><span>Asset: official Mainnet USDT TRC20</span><span>Sender: configured owner wallet</span><span>Signing: TronLink owner approval</span><span>Broadcast and monitoring: Tatum Mainnet</span><span>Confirmation: solidified chain receipt and exact Transfer event</span></div>
            <small className="fine-print">Do not use an exchange deposit address as the sending wallet unless that exchange explicitly supports user-controlled withdrawals through the connected wallet. For an incoming transfer, use the configured owner address as the receiving destination.</small>
            <button className="primary-button" onClick={()=>setTab('withdrawals')}><ArrowUpRight size={16}/> Check owner balance and withdraw</button>
          </div>
        </section>}
      </div>
      <footer className="app-footer">TRON TRANSFER · TRON MAINNET ONLY · OFFICIAL USDT TRC20 SPONSORED PAYOUTS</footer>
    </main>
  </div>
}
