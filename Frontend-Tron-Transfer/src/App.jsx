import { useEffect, useMemo, useRef, useState } from 'react'
import { TronWeb } from 'tronweb'
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, Building2, CheckCircle2, Coins, Copy, ExternalLink, History, Landmark, LockKeyhole, LogOut, Plus, RefreshCw, Settings, ShieldCheck, Wallet, X } from 'lucide-react'
import { connectTronLinkMainnet, discoverTronLink, readTronLinkMainnetContext, subscribeTronLink } from './lib/tronlink-wallet.mjs'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'https://trc20-usdt-token-cloner-api.onrender.com').replace(/\/+$/, '')
const MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const MAINNET_MONITORED_ADDRESS = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const OWNER_SESSION_KEY = 'tron-transfer:owner-session:v1'
const REQUESTER_SESSION_KEY = 'tron-transfer:requester-wallet-session:v1'

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
  const [connectedWallet,setConnectedWallet]=useState(null)
  const [walletProviderDetected,setWalletProviderDetected]=useState(false)
  const [walletConnecting,setWalletConnecting]=useState(false)
  const walletProviderRef=useRef(null)
  const tronWebRef=useRef(null)
  const [monitorAddress,setMonitorAddress]=useState(MAINNET_MONITORED_ADDRESS)
  const [monitorData,setMonitorData]=useState(null)
  const [monitorError,setMonitorError]=useState('')
  const [monitorBusy,setMonitorBusy]=useState(false)
  const [requestInspection,setRequestInspection]=useState(null)
  const [requestInspectionBusy,setRequestInspectionBusy]=useState(false)
  const [requestInspectionError,setRequestInspectionError]=useState('')
  const [notice,setNotice]=useState('')
  const [error,setError]=useState('')
  const [busy,setBusy]=useState(false)
  const [requestRecipient,setRequestRecipient]=useState('')
  const [requestAmount,setRequestAmount]=useState('')
  const [ownerAddress,setOwnerAddress]=useState('')
  const [ownerPassword,setOwnerPassword]=useState('')
  const [requesterSession,setRequesterSession]=useState(null)
  const [ownerSession,setOwnerSession]=useState(null)
  const [requests,setRequests]=useState([])
  const [readiness,setReadiness]=useState(null)
  const [sponsorFundingHistory,setSponsorFundingHistory]=useState([])
  const [sponsorFundingHistoryBusy,setSponsorFundingHistoryBusy]=useState(false)
  const [sponsorFundingHistoryError,setSponsorFundingHistoryError]=useState('')
  const connectedAddress=connectedWallet?.address || ''
  const addressLink=useMemo(()=>isValidAddress(monitorAddress)?'https://tronscan.org/#/address/'+encodeURIComponent(monitorAddress):null,[monitorAddress])

  useEffect(()=>{
    let disposed=false
    let removeWalletListeners=()=>{}
    if(typeof window!=='undefined'){
      void discoverTronLink(window).then(provider=>{
        if(disposed||!provider)return
        walletProviderRef.current=provider
        setWalletProviderDetected(true)
        const clearConnectedIdentity=(message)=>{
          tronWebRef.current=null
          setConnectedWallet(null)
          setRequesterSession(null)
          setMonitorData(null)
          try{sessionStorage.removeItem(REQUESTER_SESSION_KEY)}catch{}
          setNotice(message)
        }
        removeWalletListeners=subscribeTronLink(provider,{
          onAccountsChanged:()=>clearConnectedIdentity('The TronLink account changed. Reconnect and verify the newly selected account.'),
          onChainChanged:()=>clearConnectedIdentity('The TronLink network changed. Select TRON Mainnet and reconnect before continuing.'),
          onDisconnect:()=>clearConnectedIdentity('TronLink disconnected. Reconnect the owner wallet to continue.'),
        })
      }).catch(()=>setWalletProviderDetected(false))
    }
    void inspectAddress(MAINNET_MONITORED_ADDRESS).catch(e=>setMonitorError(e.message))
    try {
      const owner=sessionStorage.getItem(OWNER_SESSION_KEY); if(owner) void restoreOwner(owner)
      const requester=sessionStorage.getItem(REQUESTER_SESSION_KEY); if(requester) void restoreRequester(requester)
    } catch {}
    return ()=>{disposed=true;removeWalletListeners()}
  },[])

  async function perform(fn) {
    setBusy(true); setError('')
    try { return await fn() } catch(e) { setError(e instanceof Error?e.message:'Operation failed.'); return null } finally { setBusy(false) }
  }
  async function connectOwnerWallet(){
    setWalletConnecting(true)
    try{
      const context=await connectTronLinkMainnet({windowRef:window})
      if(requesterSession?.address&&requesterSession.address!==context.address) signOutRequester()
      walletProviderRef.current=context.provider
      tronWebRef.current=context.tronWeb
      setConnectedWallet({address:context.address,network:context.network,nodeUrl:context.nodeUrl,connectedAt:Date.now()})
      setWalletProviderDetected(true)
      setOwnerAddress(context.address)
      await inspectAddress(context.address)
      setNotice('TronLink connected to TRON Mainnet. The wallet remains in control of its keys; no funds were moved.')
      return context
    }finally{setWalletConnecting(false)}
  }
  function disconnectOwnerWallet(){
    walletProviderRef.current=null
    tronWebRef.current=null
    setConnectedWallet(null)
    setMonitorData(null)
    signOutRequester()
    setNotice('Tron Transfer disconnected from the wallet. TronLink authorization itself was not revoked.')
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
  async function restoreRequester(token) {
    try {
      const p=await api('/api/auth/tron/session',{headers:{Authorization:'Bearer '+token}})
      if(p.authenticated!==true||p.network!=='mainnet'||!isValidAddress(p.address)||!Number.isFinite(p.expiresAt)||p.expiresAt<=Date.now()) {
        sessionStorage.removeItem(REQUESTER_SESSION_KEY);setRequesterSession(null);return
      }
      setRequesterSession({address:p.address,expiresAt:p.expiresAt,sessionToken:token})
    } catch {setRequesterSession(null)}
  }
  async function verifyRequester() {
    const provider=walletProviderRef.current
    const context=readTronLinkMainnetContext(provider)
    if(!connectedWallet?.address||context.address!==connectedWallet.address) throw new Error('Reconnect the same TronLink account before verifying ownership.')
    const challenge=await api('/api/auth/tron/challenge',{method:'POST',body:JSON.stringify({address:context.address,network:'mainnet'})})
    if(challenge.network!=='mainnet'||typeof challenge.message!=='string'||typeof challenge.nonce!=='string'||!Number.isFinite(challenge.expiresAt)||challenge.expiresAt<=Date.now()) throw new Error('Invalid Mainnet identity challenge.')
    const signature=await context.tronWeb.trx.signMessageV2(challenge.message)
    if(typeof signature!=='string'||!/^0x[0-9a-f]{130}$/i.test(signature)) throw new Error('Invalid wallet identity signature.')
    const verified=await api('/api/auth/tron/verify',{method:'POST',body:JSON.stringify({address:context.address,network:'mainnet',nonce:challenge.nonce,signature})})
    if(verified.authenticated!==true||verified.address!==context.address||verified.network!=='mainnet'||typeof verified.sessionToken!=='string'||!Number.isFinite(verified.expiresAt)) throw new Error('Wallet ownership verification failed.')
    sessionStorage.setItem(REQUESTER_SESSION_KEY,verified.sessionToken)
    setRequesterSession({address:verified.address,expiresAt:verified.expiresAt,sessionToken:verified.sessionToken})
    setNotice('TronLink wallet ownership verified. This identity signature is not a transaction and authorizes no funds.')
  }
  function signOutRequester(){
    const token=requesterSession?.sessionToken
    try{sessionStorage.removeItem(REQUESTER_SESSION_KEY)}catch{}
    setRequesterSession(null)
    if(token) void api('/api/auth/tron/logout',{method:'POST',headers:{Authorization:'Bearer '+token}}).catch(()=>undefined)
  }
  async function inspectRequestRecipient() {
    const address = requestRecipient.trim()
    if (!isValidAddress(address)) throw new Error('Enter a valid TRON Mainnet recipient address first.')
    setRequestInspectionBusy(true)
    setRequestInspectionError('')
    try {
      const query = new URLSearchParams({ network: 'mainnet', address, tokenContract: MAINNET_USDT })
      const inspection = await api('/api/tron-transfer/recipient?' + query.toString())
      setRequestInspection({ address, inspectedAt: Date.now(), data: inspection })
      return inspection
    } catch (cause) {
      setRequestInspection(null)
      setRequestInspectionError(cause.message || 'Recipient inspection failed.')
      throw cause
    } finally {
      setRequestInspectionBusy(false)
    }
  }

  async function restoreOwner(token) {
    try {
      const p=await api('/api/auth/owner/session',{headers:{Authorization:'Bearer '+token}})
      if(p.authenticated!==true||p.network!=='mainnet'||!isValidAddress(p.address)||!Number.isFinite(p.expiresAt)||p.expiresAt<=Date.now()) {
        sessionStorage.removeItem(OWNER_SESSION_KEY);setOwnerSession(null);return
      }
      setOwnerSession({address:p.address,expiresAt:p.expiresAt,sessionToken:token})
      await loadRequests(token);await refreshReadiness(token);await loadSponsorFundingHistory(token)
    } catch {setOwnerSession(null)}
  }
  async function signInOwner() {
    if(!connectedWallet?.address||connectedWallet.address!==ownerAddress.trim()) throw new Error('Connect the configured owner TronLink account first.')
    if(!requesterSession?.sessionToken||requesterSession.address!==connectedWallet.address) throw new Error('Verify owner wallet control with the TronLink signature prompt before owner sign-in.')
    if(!ownerPassword) throw new Error('Enter the configured owner password.')
    const p=await api('/api/auth/owner/login',{method:'POST',body:JSON.stringify({address:ownerAddress.trim(),password:ownerPassword})})
    if(p.authenticated!==true||p.network!=='mainnet'||typeof p.sessionToken!=='string'||!Number.isFinite(p.expiresAt)) throw new Error('Owner authentication failed.')
    sessionStorage.setItem(OWNER_SESSION_KEY,p.sessionToken);setOwnerPassword('')
    setOwnerSession({address:p.address,expiresAt:p.expiresAt,sessionToken:p.sessionToken})
    await loadRequests(p.sessionToken);await refreshReadiness(p.sessionToken);await loadSponsorFundingHistory(p.sessionToken)
    setNotice('Owner session active. TronLink identity is verified; live transfers remain blocked until a Tatum-only signing and funding flow is ready.')
  }
  async function loadRequests(token) {
    const p=await api('/api/tron-transfer/sponsor-requests',{headers:{Authorization:'Bearer '+token}})
    setRequests(Array.isArray(p.requests)?p.requests:[])
  }
  async function refreshReadiness(token=ownerSession?.sessionToken) {
    if(!token){setReadiness(null);return}
    try{setReadiness(await api('/api/tron-transfer/readiness',{headers:{Authorization:'Bearer '+token}}))}
    catch{setReadiness(null)}
  }
  async function loadSponsorFundingHistory(token=ownerSession?.sessionToken) {
    if(!token){setSponsorFundingHistory([]);setSponsorFundingHistoryError('Owner authentication is required to read the Fincra business ledger.');return}
    setSponsorFundingHistoryBusy(true);setSponsorFundingHistoryError('')
    try {
      const p=await api('/api/tron-transfer/sponsor-funding-history',{headers:{Authorization:'Bearer '+token}})
      setSponsorFundingHistory(Array.isArray(p.rows)?p.rows:[])
    } catch(e) {
      setSponsorFundingHistoryError(e.message)
      setSponsorFundingHistory([])
    } finally {setSponsorFundingHistoryBusy(false)}
  }
  function signOutOwner(){try{sessionStorage.removeItem(OWNER_SESSION_KEY)}catch{};setOwnerSession(null);setRequests([]);setReadiness(null);setSponsorFundingHistory([]);setSponsorFundingHistoryError('')}
  async function ownerAction(id,action) {
    if(action==='fincra-payout') throw new Error('Fincra payout submission is disabled because the selected architecture is Tatum-only.')
    if(!ownerSession?.sessionToken) throw new Error('Sign in as payout owner first.')
    const p=await api('/api/tron-transfer/sponsor-requests/'+encodeURIComponent(id)+'/'+action,{
      method:'POST',headers:{Authorization:'Bearer '+ownerSession.sessionToken},
    })
    await loadRequests(ownerSession.sessionToken)
    setNotice(p.note||p.request?.fincraStatus||p.error||'Payout status refreshed.')
    return p
  }
  const nav=[
    {id:'overview',label:'Dashboard',icon:Wallet},
    {id:'assets',label:'Assets',icon:Coins},
    {id:'recipients',label:'Recipients',icon:ArrowDownLeft},
    {id:'withdrawals',label:'Withdrawals',icon:ArrowUpRight},
    {id:'sponsors',label:'Sponsor funding',icon:Building2},
    {id:'transactions',label:'Transactions',icon:History},
    {id:'settings',label:'Settings',icon:Settings},
  ]

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#"><span className="brand-mark">T</span><span>TRON <b>TRANSFER</b><small>MAINNET USDT PAYOUTS</small></span></a>
      <div className="network-card"><span className="eyebrow">PRODUCTION NETWORK</span><div className="network-chip"><i/> TRON Mainnet</div><span className="network-dot"><i/> OFFICIAL TETHER USDT TRC20</span></div>
      <nav>{nav.map(item=><button key={item.id} className={tab===item.id?'active':''} onClick={()=>{setTab(item.id);if(ownerSession?.sessionToken&&['assets','sponsors','transactions','settings'].includes(item.id)){void loadRequests(ownerSession.sessionToken).catch(e=>setError(e.message));void refreshReadiness(ownerSession.sessionToken)}if(ownerSession?.sessionToken&&item.id==='sponsors'){void loadSponsorFundingHistory(ownerSession.sessionToken)}}}><item.icon size={17}/>{item.label}</button>)}</nav>
      <div className="sidebar-bottom"><div className="security-note"><ShieldCheck size={17}/><span>TronLink wallet signing<br/><b>Keys stay in your wallet</b></span></div>{connectedWallet?<button className="outline-button" onClick={disconnectOwnerWallet}><LogOut size={16}/> Disconnect app</button>:<span className="muted small">Wallet not connected</span>}</div>
    </aside>
    <main className="main-content">
      <header className="topbar"><div><span className="eyebrow">TRON TRANSFER · PRODUCTION MAINNET</span><h1>{{overview:'Mainnet payout dashboard',assets:'Mainnet assets & sponsor funding',recipients:'Recipient balance & incoming history',withdrawals:'Sponsored USDT withdrawal request',sponsors:'Sponsor funding & payout operations',transactions:'Payout transactions & settlement history',settings:'Platform settings'}[tab]||'Tron Transfer'}</h1></div><div className="topbar-actions"><span className="network-chip"><i/> TRON Mainnet</span>{connectedWallet?<button className="outline-button" onClick={disconnectOwnerWallet}><LogOut size={15}/> Disconnect</button>:<button className="primary-button" disabled={walletConnecting} onClick={()=>perform(connectOwnerWallet)}><Wallet size={15}/>{walletConnecting?'Connecting…':'Connect TronLink'}</button>}</div></header>
      <div className="content">
        <section className="notice notice-warning"><AlertTriangle size={18}/><div><b>Tatum-only Mainnet architecture · live withdrawals remain gated</b><p>TronLink is the owner-controlled wallet and signer. Tatum provides TRON Mainnet connectivity and transaction services, not USDT funding. No payout is enabled until the Tatum-only transaction workflow is implemented and the sending wallet has genuine USDT plus required network resources.</p></div></section>
        {notice&&<div className="notice notice-success" role="status"><CheckCircle2 size={17}/><span>{notice}</span><button onClick={()=>setNotice('')} aria-label="Dismiss notice"><X size={15}/></button></div>}
        {error&&<div className="notice notice-error" role="alert"><AlertTriangle size={17}/><span>{error}</span><button onClick={()=>setError('')} aria-label="Dismiss error"><X size={15}/></button></div>}

        {tab==='overview'&&<>
          <section className="wallet-summary">
            <div className="panel balance-card"><div className="panel-heading"><div><span className="eyebrow">MONITORED MAINNET ADDRESS</span><h2>{shorten(monitorAddress)}</h2>{addressLink&&<a href={addressLink} target="_blank" rel="noreferrer">Open TRONSCAN <ExternalLink size={13}/></a>}</div><div className="panel-icon"><Wallet/></div></div><div className="balance-number">{monitorData?.tokenBalance?formatUnits(monitorData.tokenBalance.balanceBaseUnits,monitorData.tokenBalance.decimals):'—'} <small>USDT</small></div><div className="balance-footer"><span>Official TRC20 USDT · Mainnet</span><button className="icon-button" disabled={monitorBusy} onClick={()=>perform(()=>inspectAddress())}><RefreshCw size={16}/> Refresh</button></div></div>
            <div className="panel quick-card"><span className="eyebrow">OWNER WALLET MODEL</span><strong className="status-live"><i/> TronLink-controlled</strong><p>The connected owner wallet is the proposed sender and transaction signer. USDT and network resources must exist on-chain before a withdrawal can be enabled.</p><button className="secondary-button" onClick={()=>setTab('assets')}>View owner wallet assets</button></div>
          </section>
          <section className="panel"><div className="section-heading"><div><span className="eyebrow">OFFICIAL ASSET</span><h2>Tether USD · TRC20</h2><p>The production asset is pinned to the official TRON Mainnet token contract.</p></div><div className="panel-icon"><ShieldCheck/></div></div><div className="asset-row"><div className="asset-symbol token-symbol">US</div><div className="asset-name"><b>Official Tether USD</b><small>{MAINNET_USDT}</small></div><strong>{monitorData?.tokenBalance?formatUnits(monitorData.tokenBalance.balanceBaseUnits,monitorData.tokenBalance.decimals):'Not loaded'} <small>USDT</small></strong></div><p className="fine-print">Only the official Mainnet contract is supported. This dashboard does not display simulated balances or unsupported token contracts.</p></section>
          <section className="panel wallet-access">
            <div className="panel-heading"><div><span className="eyebrow">OWNER-CONTROLLED SIGNING WALLET</span><h2>{connectedWallet?'TronLink connected':'Connect your TronLink wallet'}</h2><p>TronLink retains your private key and recovery phrase. Tron Transfer requests access and signatures without collecting either secret.</p></div><div className="panel-icon"><Wallet/></div></div>
            {connectedWallet?<div className="form-stack">
              <div className="address-box"><span>Connected TRON Mainnet owner account</span><b>{connectedWallet.address}</b></div>
              <div className="request-inspection"><div><span>Network</span><b>{connectedWallet.network.toUpperCase()}</b></div><div><span>Wallet endpoint</span><b>{connectedWallet.nodeUrl}</b></div><div><span>Identity verification</span><b>{requesterSession?.address===connectedWallet.address?'Verified':'Pending'}</b></div><div><span>Official USDT balance</span><b>{monitorData?.address===connectedWallet.address&&monitorData?.tokenBalance?formatUnits(monitorData.tokenBalance.balanceBaseUnits,monitorData.tokenBalance.decimals)+' USDT':'Refresh required'}</b></div></div>
              <div className="button-row"><button className="primary-button" disabled={busy||requesterSession?.address===connectedWallet.address} onClick={()=>perform(verifyRequester)}><ShieldCheck size={16}/>{requesterSession?.address===connectedWallet.address?'Wallet verified':'Verify wallet ownership'}</button><button className="outline-button" onClick={disconnectOwnerWallet}>Disconnect app</button></div>
              <button className="secondary-button" disabled={monitorBusy} onClick={()=>perform(()=>inspectAddress(connectedWallet.address))}><RefreshCw size={15}/> Refresh owner balances</button>
            </div>:<div className="form-stack">
              <p className="fine-print">{walletProviderDetected?'TronLink was detected. Connect to authorize this site.':'Open Tron Transfer in the TronLink Android DApp browser so its wallet provider can be detected.'}</p>
              <button className="primary-button" disabled={busy||walletConnecting} onClick={()=>perform(connectOwnerWallet)}><Wallet size={16}/>{walletConnecting?'Connecting…':'Connect TronLink'}</button>
            </div>}
            <p className="fine-print">Wallet ownership signatures are off-chain login proofs only. Every future withdrawal must have its own transaction review and explicit TronLink signing approval.</p>
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
          <div className="section-heading"><div><span className="eyebrow">OFFICIAL MAINNET ASSETS</span><h2>Wallet assets and sponsor payout liquidity</h2><p>Personal monitored-wallet holdings and sponsor-controlled payout funds are displayed separately. They are never added together.</p></div><button className="secondary-button" disabled={busy} onClick={()=>perform(async()=>{await inspectAddress(MAINNET_MONITORED_ADDRESS);if(ownerSession?.sessionToken)await refreshReadiness(ownerSession.sessionToken)})}><RefreshCw size={15}/> Refresh assets</button></div>
          <div className="asset-source-grid">
            <article className="panel asset-source-card"><span className="eyebrow">MONITORED ADDRESS · NOT PAYOUT FUNDING</span><h3>{shorten(MAINNET_MONITORED_ADDRESS)}</h3><strong className="asset-large">{monitorData?.tokenBalance?formatUnits(monitorData.tokenBalance.balanceBaseUnits,monitorData.tokenBalance.decimals):'—'} <small>USDT</small></strong><span className="fine-print">Official Tether TRC20 balance read from Tatum Mainnet. This address is monitored only.</span><div className="asset-source-meta"><span>TRX: {monitorData?.nativeBalanceTRX??'Not loaded'}</span><span>Account: {monitorData?monitorData.accountExists?'Found':'Not activated / not found':'Not checked'}</span></div></article>
            <article className="panel asset-source-card sponsor-liquidity"><span className="eyebrow">AUTHORIZED FINCRA SOURCE · PAYOUT FUNDING</span><h3>Available sponsor payout balance</h3><strong className="asset-large">{readiness?.fincra?.sourceBalance?.checked?readiness.fincra.sourceBalance.availableBalance:'Not verified'} <small>USDT</small></strong><span className="fine-print">{readiness?.fincra?.sourceBalance?.checked?'Live Fincra business wallet balances returned by the provider.':'Sign in as payout owner and refresh readiness to retrieve the provider balance. No balance is estimated or invented.'}</span><div className="balance-breakdown"><div><small>Available · payout eligible</small><b>{readiness?.fincra?.sourceBalance?.checked?readiness.fincra.sourceBalance.availableBalance:'—'} USDT</b></div><div><small>Locked</small><b>{readiness?.fincra?.sourceBalance?.lockedBalance??'Not returned'} USDT</b></div><div><small>Ledger · total</small><b>{readiness?.fincra?.sourceBalance?.ledgerBalance??'Not returned'} USDT</b></div></div><div className="asset-source-meta"><span>Environment: {readiness?.fincra?.environment||'Not checked'}</span><span>Live payout: {readiness?.fincra?.canSubmitLivePayout?'Eligible for owner review':'Gated'}</span>{readiness?.fincra?.sourceBalance?.walletNumber&&<span>Fincra USDT funding wallet number: {readiness.fincra.sourceBalance.walletNumber}</span>}</div>{!ownerSession&&<button className="secondary-button" onClick={()=>setTab('sponsors')}>Open sponsor operations</button>}</article>
          </div>
          <div className="panel assets-total-panel"><div><span className="eyebrow">FINCRA SPONSOR LEDGER · TOTAL SOURCE ASSETS</span><h2>{readiness?.fincra?.sourceBalance?.checked&&readiness.fincra.sourceBalance.ledgerBalance!==null?readiness.fincra.sourceBalance.ledgerBalance+' USDT':'Not returned by Fincra'}</h2><p>Ledger balance includes available plus locked USDT. Only the separately displayed available balance is eligible to fund a new payout. Your monitored address is excluded.</p></div><div className="panel-icon"><Landmark/></div></div>
          <div className="panel"><div className="section-heading"><div><span className="eyebrow">ASSET IDENTITY</span><h3>Official Tether USD · TRC20</h3><p>Mainnet contract pinned by the backend.</p></div></div><div className="asset-row"><div className="asset-symbol token-symbol">US</div><div className="asset-name"><b>USDT · TRON Mainnet</b><small>{MAINNET_USDT}</small></div><strong>{monitorData?.tokenBalance?formatUnits(monitorData.tokenBalance.balanceBaseUnits,monitorData.tokenBalance.decimals):'Unavailable'} <small>USDT</small></strong></div></div>
        </section>}

        {tab==='withdrawals'&&<section className="panel withdrawals-page">
          <div className="section-heading"><div><span className="eyebrow">MAINNET · SPONSORED SETTLEMENT</span><h2>Request a genuine USDT withdrawal</h2><p>Fincra sends official Tether USDT from its authorized funded business source. Your monitored address is not debited.</p></div><div className="panel-icon"><ArrowUpRight/></div></div>
          {!connectedWallet||requesterSession?.address!==connectedWallet.address?<div className="owner-session-card"><strong><LockKeyhole size={15}/> Wallet ownership not verified</strong><small>{connectedWallet?'Sign an off-chain Mainnet identity challenge in TronLink.':'Connect your TronLink Mainnet account first.'}</small><button className="secondary-button" disabled={busy||!connectedWallet} onClick={()=>perform(verifyRequester)}><ShieldCheck size={15}/> Verify wallet ownership</button></div>:<div className="owner-session-card"><strong><ShieldCheck size={15}/> Mainnet wallet identity verified</strong><small>{shorten(requesterSession.address)} · expires {new Date(requesterSession.expiresAt).toLocaleTimeString()}</small><button className="outline-button" onClick={signOutRequester}>Sign out wallet identity</button></div>}
          <div className="withdrawal-form-grid">
            <div className="form-stack">
              <label>Recipient Mainnet address<input value={requestRecipient} onChange={e=>{setRequestRecipient(e.target.value);setRequestInspection(null);setRequestInspectionError('')}} placeholder="External TRON Mainnet address (T…)" autoComplete="off" spellCheck="false"/></label>
              <button type="button" className="secondary-button" disabled={busy||requestInspectionBusy||!requestRecipient.trim()} onClick={()=>perform(inspectRequestRecipient)}><RefreshCw size={15}/>{requestInspectionBusy?'Inspecting recipient…':'Inspect recipient balance & history'}</button>
              {requestInspectionError&&<div className="notice notice-error"><AlertTriangle size={15}/><span>{requestInspectionError}</span></div>}
              {requestInspection&&requestInspection.address===requestRecipient.trim()&&<div className="request-inspection"><div><span>TRON Mainnet account</span><b>{requestInspection.data.accountExists?'Found':'Not activated / not found'}</b></div><div><span>Official USDT balance</span><b>{requestInspection.data.tokenBalance?formatUnits(requestInspection.data.tokenBalance.balanceBaseUnits,requestInspection.data.tokenBalance.decimals)+' USDT':'Unavailable'}</b></div><div><span>Incoming history</span><b>{requestInspection.data.historyStatus||'Unavailable'}</b></div><small>Inspected {new Date(requestInspection.inspectedAt).toLocaleTimeString()}. Recheck after five minutes or whenever the address changes.</small></div>}
              <label>USDT withdrawal amount<input value={requestAmount} onChange={e=>setRequestAmount(e.target.value)} placeholder="e.g. 25.00" inputMode="decimal"/></label><small className="fine-print">This is the amount submitted in Fincra's payout request. The amount actually received can differ because Fincra reports the net recipient amount after fees. Tron Transfer records the provider's actual amount charged, net amount received and fee separately, then verifies the exact net amount on TRON Mainnet.</small>
              <div className="notice notice-warning"><AlertTriangle size={15}/><span>Transaction submission is not enabled yet. The Tatum-only flow must verify the connected sender's actual USDT balance and TRON resources, prepare the exact transaction, and request owner approval in TronLink before broadcasting.</span></div>
              <button className="primary-button" disabled><LockKeyhole size={16}/> Tatum-only withdrawal preparation pending</button>
            </div>
            <aside className="withdrawal-eligibility"><span className="eyebrow">OWNER-SIGNED MAINNET TRANSFER</span><h3>Production prerequisites</h3><div className="readiness-checks"><span>Network: TRON Mainnet</span><span>Asset: official Tether USDT TRC20</span><span>Blockchain services: Tatum</span><span>Signing authority: connected TronLink owner wallet</span><span>Funding: actual USDT and network resources in the sending wallet</span></div><p className="fine-print">This page currently prepares the workflow only. No sponsor API or simulated balance is used, and no transaction can be broadcast from this screen yet.</p><button className="secondary-button" onClick={()=>setTab('assets')}>View owner wallet readiness</button></aside>
          </div>
        </section>}

        {tab==='transactions'&&<section className="panel transactions-page">
          <div className="section-heading"><div><span className="eyebrow">FINCRA SETTLEMENT + TRON CONFIRMATION</span><h2>Withdrawal transaction history</h2><p>Provider acceptance, final provider status, and independently verified on-chain delivery are separate milestones.</p></div><button className="secondary-button" disabled={!ownerSession||busy} onClick={()=>perform(async()=>{await loadRequests(ownerSession.sessionToken);await refreshReadiness(ownerSession.sessionToken)})}><RefreshCw size={15}/> Refresh records</button></div>
          {!ownerSession?<div className="empty-state"><LockKeyhole size={24}/><b>Owner authentication required</b><p>Sign in under Sponsor funding to view private payout and settlement records.</p><button className="secondary-button" onClick={()=>setTab('sponsors')}>Open sponsor funding</button></div>:!requests.length?<div className="empty-state"><History size={24}/><b>No payout transactions recorded</b><p>Approved sponsor withdrawal requests will appear here after they are created.</p></div>:<div className="transaction-list">{requests.map(request=><article className="transaction-row" key={request.id}><div className="transaction-main"><strong>{request.amount} USDT</strong><span>To {shorten(request.recipientAddress)} · {new Date(request.createdAt).toLocaleString()}</span><small>Fincra: {request.fincraStatus||'not submitted'} · Chain: {request.chainVerificationStatus||'not verified'}</small><small>Recipient received: {request.fincraAmountReceivedBaseUnits?formatUnits(request.fincraAmountReceivedBaseUnits)+' USDT':'Not yet reconciled'} · Sponsor charged: {request.fincraAmountChargedBaseUnits?formatUnits(request.fincraAmountChargedBaseUnits)+' USDT':'Not returned'} · Fee: {request.fincraFeeBaseUnits?formatUnits(request.fincraFeeBaseUnits)+' USDT':'Not returned'}</small>{request.fincraReference&&<small>Provider reference: {request.fincraReference}</small>}{request.transactionHash&&<a href={'https://tronscan.org/#/transaction/'+request.transactionHash} target="_blank" rel="noreferrer">Open verified Mainnet transaction <ExternalLink size={12}/></a>}</div><div className="transaction-actions"><button className="secondary-button" disabled={busy} onClick={()=>perform(()=>ownerAction(request.id,'fincra-status'))}>Refresh Fincra status</button><button className="secondary-button" disabled={busy||request.fincraStatus!=='successful'} onClick={()=>perform(()=>ownerAction(request.id,'verify-recipient-transfer'))}>Verify on-chain</button></div></article>)}</div>}
        </section>}

        {tab==='settings'&&<section className="panel settings-page">
          <div className="section-heading"><div><span className="eyebrow">PRODUCTION CONFIGURATION</span><h2>Tron Transfer settings</h2><p>Mainnet-only configuration and operator access. Provider secrets are never stored in this browser.</p></div><div className="panel-icon"><Settings/></div></div>
          <div className="settings-group"><span className="eyebrow">DEFAULT MONITORED ADDRESS</span><div className="address-box"><span>Read-only monitoring identity</span><b>{MAINNET_MONITORED_ADDRESS}</b></div><a href={'https://tronscan.org/#/address/'+MAINNET_MONITORED_ADDRESS} target="_blank" rel="noreferrer">Open address on TRONSCAN <ExternalLink size={12}/></a><p className="fine-print">This address is not the sponsor treasury and is never used as the payout source. To inspect a different recipient, use the Recipients page.</p></div>
          <div className="settings-group"><span className="eyebrow">PROVIDER READINESS</span><div className="readiness-checks"><span>Tatum Mainnet: {readiness?.tatum?.mainnetNode?.checked?'reachable':readiness?.tatum?.mainnetNode?.reason||'owner refresh required'}</span><span>Fincra environment: {readiness?.fincra?.environment||'not checked'}</span><span>Fincra live payout: {readiness?.fincra?.canSubmitLivePayout?'eligible for owner review':'not enabled / not funded / not verified'}</span><span>Database: {readiness?.storage?.ready?'ready':'not verified'}</span></div><button className="secondary-button" disabled={!ownerSession||busy} onClick={()=>perform(()=>refreshReadiness(ownerSession.sessionToken))}><RefreshCw size={15}/> Recheck provider readiness</button></div>
          <div className="settings-group"><span className="eyebrow">OWNER WALLET IDENTITY</span><p>{connectedWallet?'TronLink account connected: '+connectedWallet.address:'No TronLink wallet is currently connected.'}</p><p className="fine-print">Private keys and recovery phrases remain inside TronLink. The app stores only public account details and a short-lived, server-issued identity session.</p>{connectedWallet&&<button className="outline-button" onClick={disconnectOwnerWallet}><LogOut size={15}/> Disconnect wallet session</button>}</div>
        </section>}
{tab==='sponsors'&&<section className="panel sponsor-panel">
          <div className="section-heading"><div><span className="eyebrow">AUTHORIZED PRINCIPAL / LIVE PAYOUTS</span><h2>Sponsored USDT TRC20 withdrawals</h2><p>Fincra submits live payouts from an authorized funded business source. Tatum verifies the resulting Mainnet transaction.</p></div><div className="panel-icon"><ShieldCheck/></div></div>
          <div className="sponsor-readiness"><div><span className="eyebrow">FINCRA LIVE READINESS</span><strong>{readiness?.fincra?.canSubmitLivePayout?'Live payout prerequisites pass':'Live payouts currently gated'}</strong><small>Environment: {readiness?.fincra?.environment||'Not checked'} · Scheme: usdt_trc20</small></div><button className="secondary-button" onClick={()=>perform(async()=>{await refreshReadiness();await loadSponsorFundingHistory()})}><RefreshCw size={15}/> Refresh readiness & funding</button></div>
          {readiness?.fincra?.sourceBalance?.checked&&readiness.fincra.sourceBalance.currency==='USDT'&&readiness.fincra.sourceBalance.walletNumber&&<div className="panel sponsor-funding-destination">
            <span className="eyebrow">SPONSOR FUNDING DESTINATION · FINCRA USDT BALANCE</span>
            <h3>Receive sponsor funding into the payout source</h3>
            <div className="funding-wallet-number"><strong>{readiness.fincra.sourceBalance.walletNumber}</strong><button type="button" className="icon-button" onClick={()=>navigator.clipboard?.writeText(readiness.fincra.sourceBalance.walletNumber).then(()=>setNotice('Fincra USDT wallet number copied.')).catch(()=>setError('Clipboard access is unavailable.'))}><Copy size={15}/> Copy</button></div>
            <p>Share this Fincra USDT balance number with an approved sponsor that also holds a Fincra account. The sponsor may use Fincra’s account-to-account transfer only if Fincra enables transfers between both businesses’ USDT balances. Fincra documents same-base-currency transfers; confirm USDT wallet-to-wallet eligibility with Fincra before relying on this route. The sponsor must use its own Fincra account and available funds; Tron Transfer never receives the sponsor’s API key or initiates a debit from the sponsor’s account.</p>
            <small>Fincra wallet number is a receiving account identifier, not a TRON address. Fincra documents no webhook for account-to-account transfers, so after the sponsor provides its transfer reference, use Refresh readiness to confirm the credit from the actual available USDT balance. The provider must confirm that USDT is eligible for this same-currency transfer route.</small>
          </div>}            <div className="panel sponsor-ledger-panel">
              <div className="section-heading"><div><span className="eyebrow">FINCRA BUSINESS BALANCE LEDGER</span><h3>Incoming sponsor credits</h3><p>Read-only credits returned by Fincra’s balance-history API. These are provider ledger records, not manually entered sponsor claims.</p></div><button className="secondary-button" disabled={!ownerSession||sponsorFundingHistoryBusy} onClick={()=>perform(()=>loadSponsorFundingHistory())}><RefreshCw size={15}/>{sponsorFundingHistoryBusy?'Loading ledger…':'Refresh funding history'}</button></div>
              {sponsorFundingHistoryError&&<div className="notice notice-error"><AlertTriangle size={15}/><span>{sponsorFundingHistoryError}</span></div>}
              {!sponsorFundingHistoryError&&!sponsorFundingHistory.length?<div className="empty-state"><Landmark size={23}/><b>No Fincra credit records returned</b><p>Sign in as payout owner and refresh. A sponsor transfer appears only after Fincra records it in this business balance ledger.</p></div>:<div className="sponsor-ledger-list">{sponsorFundingHistory.map((item,index)=><article className="sponsor-ledger-row" key={item.id||item.reference||index}><div><strong>{item.amount||'Amount unavailable'} {item.currency||'USDT'}</strong><span>{item.sender||item.description||'Fincra business wallet credit'}</span><small>{item.createdAt?new Date(item.createdAt).toLocaleString():'Provider timestamp unavailable'} · {item.status||'status unavailable'}</small></div><div className="ledger-reference">{item.reference||item.customerReference||item.id||'No provider reference'}</div></article>)}</div>}
            </div>

          {readiness?.fincra&&<div className="readiness-checks">
            <span>Tatum Mainnet {readiness.tatum?.mainnetNode?.checked?'solidified node reachable':readiness.tatum?.mainnetNode?.reason||'not verified'}</span>
            <span>Fincra API key {readiness.fincra.apiKeyConfigured?'configured':'missing'}</span>
            <span>Fincra business ID {readiness.fincra.businessIdConfigured?'configured':'missing'}</span>
            <span>Webhook secret {readiness.fincra.webhookSecretConfigured?'configured':'missing'}</span>
            <span>Available source USDT {readiness.fincra.sourceBalance?.checked?readiness.fincra.sourceBalance.availableBalance+' USDT':'not verified'}</span>
            <span>Live stablecoin permission {readiness.fincra.liveStablecoinPayoutsConfirmed?'confirmed':'not confirmed'}</span>
            <span>Live payout gate {readiness.fincra.canSubmitLivePayout?'open for owner review':'closed'}</span>
          </div>}
          <div className="sponsor-admin-card"><span className="eyebrow">02 / AUTHORIZED PAYOUT OPERATOR</span><h3>Owner authentication</h3>
              {!ownerSession?<div className="form-stack"><label>Connected owner Mainnet address<input value={connectedWallet?.address||ownerAddress} readOnly placeholder="Connect TronLink first" autoComplete="off"/></label><label>Owner password<input value={ownerPassword} onChange={e=>setOwnerPassword(e.target.value)} type="password" autoComplete="current-password"/></label><button className="secondary-button" disabled={busy||!connectedWallet||requesterSession?.address!==connectedWallet.address||!ownerPassword} onClick={()=>perform(signInOwner)}><LockKeyhole size={16}/> Sign in as verified owner</button></div>:<div className="owner-session-card"><strong><ShieldCheck size={15}/> Owner session active</strong><small>{shorten(ownerSession.address)} · expires {new Date(ownerSession.expiresAt).toLocaleTimeString()}</small><div className="button-row"><button className="secondary-button" onClick={()=>perform(()=>loadRequests(ownerSession.sessionToken))}><RefreshCw size={15}/> Refresh queue</button><button className="outline-button" onClick={signOutOwner}>Sign out</button></div></div>}
            </div>
          {ownerSession&&<div className="sponsor-queue"><div className="section-heading"><div><span className="eyebrow">03 / PAYOUT OPERATIONS</span><h3>Mainnet withdrawal queue</h3><p>Fincra acceptance, payout settlement and chain confirmation remain separate states.</p></div></div>
            {!requests.length?<div className="empty-state"><ShieldCheck size={25}/><b>No sponsor requests in the queue</b><p>Submitted requests will appear here.</p></div>:requests.map(request=><article className="sponsor-request-row" key={request.id}>
              <div className="sponsor-request-details"><strong>{request.amount} USDT</strong><small>To {shorten(request.recipientAddress)} · {new Date(request.createdAt).toLocaleString()}</small><small>Requester {shorten(request.requesterAddress)} · {request.beneficiaryName}</small><span className="status-text">{request.status} · Fincra: {request.fincraStatus||'not submitted'} · Chain: {request.chainVerificationStatus}</span><small>Net recipient amount: {request.fincraAmountReceivedBaseUnits?formatUnits(request.fincraAmountReceivedBaseUnits)+' USDT':'Pending Fincra settlement reconciliation'} · Sponsor charge: {request.fincraAmountChargedBaseUnits?formatUnits(request.fincraAmountChargedBaseUnits)+' USDT':'Not returned'} · Fincra fee: {request.fincraFeeBaseUnits?formatUnits(request.fincraFeeBaseUnits)+' USDT':'Not returned'}</small>{request.transactionHash&&<a href={'https://tronscan.org/#/transaction/'+request.transactionHash} target="_blank" rel="noreferrer">View verified transfer <ExternalLink size={12}/></a>}</div>
              <div className="sponsor-request-actions"><button className="secondary-button" disabled={busy||request.status==='fincra-successful'} onClick={()=>perform(()=>ownerAction(request.id,'fincra-status'))}>Requery Fincra</button><button className="primary-button" disabled title="Disabled: Tatum-only architecture selected">Fincra payout disabled</button><button className="secondary-button" disabled={busy||request.fincraStatus!=='successful'} onClick={()=>perform(()=>ownerAction(request.id,'verify-recipient-transfer'))}>Verify recipient on-chain</button></div>
            </article>)}
          </div>}
        </section>}
      </div>
      <footer className="app-footer">TRON TRANSFER · TRON MAINNET ONLY · OFFICIAL USDT TRC20 SPONSORED PAYOUTS</footer>
    </main>
  </div>
}
