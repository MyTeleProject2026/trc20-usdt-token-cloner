import { useEffect, useMemo, useState } from 'react'
import { TronWeb } from 'tronweb'
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, Building2, CheckCircle2, Coins, Copy, ExternalLink, FileKey2, History, KeyRound, Landmark, LockKeyhole, LogOut, Plus, RefreshCw, Settings, ShieldCheck, Wallet, X } from 'lucide-react'
import { encryptWalletPrivateKey, decryptWalletPrivateKey, isEncryptedWalletRecord } from './lib/wallet-vault-crypto.mjs'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'https://trc20-usdt-token-cloner-api.onrender.com').replace(/\/+$/, '')
const MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const MAINNET_MONITORED_ADDRESS = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const WALLET_KEY = 'tron-transfer:mainnet-wallet:v1'
const OWNER_SESSION_KEY = 'tron-transfer:owner-session:v1'
const REQUESTER_SESSION_KEY = 'tron-transfer:requester-wallet-session:v1'
const REQUEST_REFERENCE_KEY = 'tron-transfer:pending-request-reference:v1'

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback } catch { return fallback }
}
function writeJson(key, value) { localStorage.setItem(key, JSON.stringify(value)) }
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
  const [walletRecord,setWalletRecord]=useState(()=>readJson(WALLET_KEY,null))
  const [unlocked,setUnlocked]=useState(null)
  const [password,setPassword]=useState('')
  const [confirmPassword,setConfirmPassword]=useState('')
  const [privateKeyInput,setPrivateKeyInput]=useState('')
  const [backupText,setBackupText]=useState('')
  const [showKey,setShowKey]=useState(false)
  const [walletMode,setWalletMode]=useState('import')
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
  const [beneficiaryName,setBeneficiaryName]=useState('')
  const [beneficiaryEmail,setBeneficiaryEmail]=useState('')
  const [ownerAddress,setOwnerAddress]=useState('')
  const [ownerPassword,setOwnerPassword]=useState('')
  const [requesterSession,setRequesterSession]=useState(null)
  const [ownerSession,setOwnerSession]=useState(null)
  const [requests,setRequests]=useState([])
  const [readiness,setReadiness]=useState(null)
  const unlockedAddress=unlocked?.address || ''
  const addressLink=useMemo(()=>isValidAddress(monitorAddress)?'https://tronscan.org/#/address/'+encodeURIComponent(monitorAddress):null,[monitorAddress])

  useEffect(()=>{
    void inspectAddress(MAINNET_MONITORED_ADDRESS).catch(e=>setMonitorError(e.message))
    try {
      const owner=sessionStorage.getItem(OWNER_SESSION_KEY); if(owner) void restoreOwner(owner)
      const requester=sessionStorage.getItem(REQUESTER_SESSION_KEY); if(requester) void restoreRequester(requester)
    } catch {}
  },[])

  async function perform(fn) {
    setBusy(true); setError('')
    try { return await fn() } catch(e) { setError(e instanceof Error?e.message:'Operation failed.'); return null } finally { setBusy(false) }
  }
  async function saveWallet(key,address,pwd) {
    const record=await encryptWalletPrivateKey(key,address,pwd)
    writeJson(WALLET_KEY,record); setWalletRecord(record); setUnlocked({address,privateKey:key.replace(/^0x/i,'').toLowerCase()})
    setPassword(''); setConfirmPassword(''); setPrivateKeyInput(''); setBackupText('')
    setNotice('Wallet encrypted locally. Its private key was not sent to the server.')
  }
  async function importWallet() {
    if(password.length<12||password!==confirmPassword) throw new Error('Use matching passwords of at least 12 characters.')
    const key=privateKeyInput.trim().replace(/^0x/i,'')
    if(!/^[0-9a-f]{64}$/i.test(key)) throw new Error('Enter a 64-character hexadecimal TRON private key.')
    const signer=new TronWeb({privateKey:key}), address=String(signer.defaultAddress?.base58||'')
    if(!isValidAddress(address)) throw new Error('The key did not produce a valid TRON Mainnet address.')
    await saveWallet(key,address,password)
  }
  async function restoreWallet() {
    if(!backupText.trim()||!password) throw new Error('Choose an encrypted backup and enter its password.')
    const parsed=JSON.parse(backupText), record=parsed?.wallet||parsed
    if(!isEncryptedWalletRecord(record)) throw new Error('Unsupported encrypted wallet backup.')
    const key=await decryptWalletPrivateKey(record,password), signer=new TronWeb({privateKey:key})
    if(String(signer.defaultAddress?.base58||'')!==record.address) throw new Error('Backup key/address mismatch.')
    writeJson(WALLET_KEY,record); setWalletRecord(record); setUnlocked({address:record.address,privateKey:key})
    setPassword(''); setBackupText(''); setNotice('Encrypted Mainnet wallet backup restored locally.')
  }
  async function unlockWallet() {
    if(!walletRecord||!password) throw new Error('Enter the saved wallet password.')
    const key=await decryptWalletPrivateKey(walletRecord,password), signer=new TronWeb({privateKey:key})
    if(String(signer.defaultAddress?.base58||'')!==walletRecord.address) throw new Error('Wallet address verification failed.')
    setUnlocked({address:walletRecord.address,privateKey:key}); setPassword('')
    setNotice('Wallet unlocked. An identity message signature does not require TRX.')
  }
  function lockWallet(){setUnlocked(null);setPassword('');setNotice('Wallet locked and decrypted key cleared from application state.')}
  function removeWallet(){setUnlocked(null);localStorage.removeItem(WALLET_KEY);setWalletRecord(null);setNotice('Encrypted wallet record removed from this browser.')}

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
    if(!unlocked) throw new Error('Import or unlock the Mainnet wallet you control first.')
    const signer=new TronWeb({privateKey:unlocked.privateKey})
    if(String(signer.defaultAddress?.base58||'')!==unlocked.address||typeof signer.trx?.signMessageV2!=='function') throw new Error('The wallet cannot sign the identity challenge.')
    const challenge=await api('/api/auth/tron/challenge',{method:'POST',body:JSON.stringify({address:unlocked.address,network:'mainnet'})})
    if(challenge.network!=='mainnet'||typeof challenge.message!=='string'||typeof challenge.nonce!=='string'||!Number.isFinite(challenge.expiresAt)||challenge.expiresAt<=Date.now()) throw new Error('Invalid Mainnet identity challenge.')
    const signature=await signer.trx.signMessageV2(challenge.message)
    if(typeof signature!=='string'||!/^0x[0-9a-f]{130}$/i.test(signature)) throw new Error('Invalid wallet identity signature.')
    const verified=await api('/api/auth/tron/verify',{method:'POST',body:JSON.stringify({address:unlocked.address,network:'mainnet',nonce:challenge.nonce,signature})})
    if(verified.authenticated!==true||verified.address!==unlocked.address||verified.network!=='mainnet'||typeof verified.sessionToken!=='string'||!Number.isFinite(verified.expiresAt)) throw new Error('Wallet ownership verification failed.')
    sessionStorage.setItem(REQUESTER_SESSION_KEY,verified.sessionToken)
    setRequesterSession({address:verified.address,expiresAt:verified.expiresAt,sessionToken:verified.sessionToken})
    setNotice('Mainnet wallet ownership verified. This off-chain message signature does not send or authorize funds.')
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

  async function submitSponsorRequest() {
    if(!requesterSession?.sessionToken||requesterSession.address!==unlockedAddress) throw new Error('Verify requester wallet ownership first.')
    if(!isValidAddress(requestRecipient.trim())) throw new Error('Enter a valid TRON Mainnet recipient address.')
    if (!requestInspection || requestInspection.address !== requestRecipient.trim() || Date.now() - requestInspection.inspectedAt > 5 * 60 * 1000) {
      throw new Error('Inspect the recipient balance and incoming history for this exact address before creating the payout request.')
    }
    if(!beneficiaryName.trim()) throw new Error('Enter the beneficiary name.')
    const amount=requestAmount.trim()
    if(!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(amount)) throw new Error('Enter a positive USDT amount with up to six decimal places.')
    const parts=amount.split('.'), base=BigInt(parts[0])*1000000n+BigInt((parts[1]||'').padEnd(6,'0')||'0')
    if(base<=0n) throw new Error('USDT amount must be greater than zero.')
    let reference=sessionStorage.getItem(REQUEST_REFERENCE_KEY)
    if(!reference){reference='tt-'+crypto.randomUUID();sessionStorage.setItem(REQUEST_REFERENCE_KEY,reference)}
    const result=await api('/api/tron-transfer/sponsor-requests',{
      method:'POST',headers:{Authorization:'Bearer '+requesterSession.sessionToken},
      body:JSON.stringify({requesterAddress:requesterSession.address,recipientAddress:requestRecipient.trim(),beneficiaryName:beneficiaryName.trim(),beneficiaryEmail:beneficiaryEmail.trim(),amount,customerReference:reference}),
    })
    sessionStorage.removeItem(REQUEST_REFERENCE_KEY);setRequestRecipient('');setRequestInspection(null);setRequestInspectionError('');setRequestAmount('');setBeneficiaryName('');setBeneficiaryEmail('')
    setNotice('Sponsor request recorded. No payout occurs until an authorized owner submits it to live Fincra.')
    if(ownerSession?.sessionToken) await loadRequests(ownerSession.sessionToken)
    return result
  }

  async function restoreOwner(token) {
    try {
      const p=await api('/api/auth/owner/session',{headers:{Authorization:'Bearer '+token}})
      if(p.authenticated!==true||p.network!=='mainnet'||!isValidAddress(p.address)||!Number.isFinite(p.expiresAt)||p.expiresAt<=Date.now()) {
        sessionStorage.removeItem(OWNER_SESSION_KEY);setOwnerSession(null);return
      }
      setOwnerSession({address:p.address,expiresAt:p.expiresAt,sessionToken:token})
      await loadRequests(token);await refreshReadiness(token)
    } catch {setOwnerSession(null)}
  }
  async function signInOwner() {
    if(!isValidAddress(ownerAddress.trim())||!ownerPassword) throw new Error('Enter the configured owner Mainnet address and password.')
    const p=await api('/api/auth/owner/login',{method:'POST',body:JSON.stringify({address:ownerAddress.trim(),password:ownerPassword})})
    if(p.authenticated!==true||p.network!=='mainnet'||typeof p.sessionToken!=='string'||!Number.isFinite(p.expiresAt)) throw new Error('Owner authentication failed.')
    sessionStorage.setItem(OWNER_SESSION_KEY,p.sessionToken);setOwnerPassword('')
    setOwnerSession({address:p.address,expiresAt:p.expiresAt,sessionToken:p.sessionToken})
    await loadRequests(p.sessionToken);await refreshReadiness(p.sessionToken)
    setNotice('Owner session active. Live payout remains gated by Fincra authorization and available USDT.')
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
  function signOutOwner(){try{sessionStorage.removeItem(OWNER_SESSION_KEY)}catch{};setOwnerSession(null);setRequests([]);setReadiness(null)}
  async function ownerAction(id,action) {
    if(!ownerSession?.sessionToken) throw new Error('Sign in as payout owner first.')
    const p=await api('/api/tron-transfer/sponsor-requests/'+encodeURIComponent(id)+'/'+action,{
      method:'POST',headers:{Authorization:'Bearer '+ownerSession.sessionToken},
    })
    await loadRequests(ownerSession.sessionToken)
    setNotice(p.note||p.request?.fincraStatus||p.error||'Payout status refreshed.')
    return p
  }
  async function exportBackup(){
    if(!walletRecord) throw new Error('No encrypted wallet is saved on this device.')
    const blob=new Blob([JSON.stringify({wallet:walletRecord},null,2)],{type:'application/json'})
    const url=URL.createObjectURL(blob),a=document.createElement('a')
    a.href=url;a.download='tron-transfer-mainnet-encrypted-wallet.json';a.click();URL.revokeObjectURL(url)
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
      <nav>{nav.map(item=><button key={item.id} className={tab===item.id?'active':''} onClick={()=>{setTab(item.id);if(ownerSession?.sessionToken&&['assets','sponsors','transactions','settings'].includes(item.id)){void loadRequests(ownerSession.sessionToken).catch(e=>setError(e.message));void refreshReadiness(ownerSession.sessionToken)}}}><item.icon size={17}/>{item.label}</button>)}</nav>
      <div className="sidebar-bottom"><div className="security-note"><ShieldCheck size={17}/><span>Local identity signing<br/><b>No server-held wallet keys</b></span></div>{unlocked?<button className="outline-button" onClick={lockWallet}><LockKeyhole size={16}/> Lock wallet</button>:<span className="muted small">Identity wallet locked</span>}</div>
    </aside>
    <main className="main-content">
      <header className="topbar"><div><span className="eyebrow">TRON TRANSFER · PRODUCTION MAINNET</span><h1>{{overview:'Mainnet payout dashboard',assets:'Mainnet assets & sponsor funding',recipients:'Recipient balance & incoming history',withdrawals:'Sponsored USDT withdrawal request',sponsors:'Sponsor funding & payout operations',transactions:'Payout transactions & settlement history',settings:'Platform settings'}[tab]||'Tron Transfer'}</h1></div><div className="topbar-actions"><span className="network-chip"><i/> TRON Mainnet</span>{unlocked&&<button className="outline-button" onClick={lockWallet}><LogOut size={15}/> Lock</button>}</div></header>
      <div className="content">
        <section className="notice notice-warning"><AlertTriangle size={18}/><div><b>Mainnet-only sponsored withdrawals</b><p>Only official Tether USDT TRC20 Mainnet payouts are supported. Tatum provides Mainnet account and transaction verification; an authorized, funded Fincra business account supplies and executes the payout. Demo balances and local wallet-funded sends are disabled.</p></div></section>
        {notice&&<div className="notice notice-success" role="status"><CheckCircle2 size={17}/><span>{notice}</span><button onClick={()=>setNotice('')} aria-label="Dismiss notice"><X size={15}/></button></div>}
        {error&&<div className="notice notice-error" role="alert"><AlertTriangle size={17}/><span>{error}</span><button onClick={()=>setError('')} aria-label="Dismiss error"><X size={15}/></button></div>}

        {tab==='overview'&&<>
          <section className="wallet-summary">
            <div className="panel balance-card"><div className="panel-heading"><div><span className="eyebrow">MONITORED MAINNET ADDRESS</span><h2>{shorten(monitorAddress)}</h2>{addressLink&&<a href={addressLink} target="_blank" rel="noreferrer">Open TRONSCAN <ExternalLink size={13}/></a>}</div><div className="panel-icon"><Wallet/></div></div><div className="balance-number">{monitorData?.tokenBalance?formatUnits(monitorData.tokenBalance.balanceBaseUnits,monitorData.tokenBalance.decimals):'—'} <small>USDT</small></div><div className="balance-footer"><span>Official TRC20 USDT · Mainnet</span><button className="icon-button" disabled={monitorBusy} onClick={()=>perform(()=>inspectAddress())}><RefreshCw size={16}/> Refresh</button></div></div>
            <div className="panel quick-card"><span className="eyebrow">PAYOUT MODEL</span><strong className="status-live"><i/> Sponsor-funded</strong><p>USDT principal and network resources come from the authorized Fincra payout source. Your monitored wallet is not used as payout funding.</p><button className="secondary-button" onClick={()=>setTab('sponsors')}>Open payout workspace</button></div>
          </section>
          <section className="panel"><div className="section-heading"><div><span className="eyebrow">OFFICIAL ASSET</span><h2>Tether USD · TRC20</h2><p>The production asset is pinned to the official TRON Mainnet token contract.</p></div><div className="panel-icon"><ShieldCheck/></div></div><div className="asset-row"><div className="asset-symbol token-symbol">US</div><div className="asset-name"><b>Official Tether USD</b><small>{MAINNET_USDT}</small></div><strong>{monitorData?.tokenBalance?formatUnits(monitorData.tokenBalance.balanceBaseUnits,monitorData.tokenBalance.decimals):'Not loaded'} <small>USDT</small></strong></div><p className="fine-print">Only the official Mainnet contract is supported. This dashboard does not display simulated balances or unsupported token contracts.</p></section>
          <section className="panel wallet-access">
            <div className="panel-heading"><div><span className="eyebrow">DEVICE-LOCAL IDENTITY WALLET</span><h2>{walletRecord?'Unlock your wallet':'Import or restore your wallet'}</h2><p>Your key stays encrypted in this browser. A signed identity message does not require TRX and does not authorize a payout.</p></div><div className="panel-icon"><LockKeyhole/></div></div>
            {!walletRecord||walletMode==='restore'?<div className="form-stack">
              {!walletRecord&&<label>Private key <div className="input-with-action"><input type={showKey?'text':'password'} value={privateKeyInput} onChange={e=>setPrivateKeyInput(e.target.value)} autoComplete="off" spellCheck="false" placeholder="64-character hexadecimal key"/><button type="button" onClick={()=>setShowKey(!showKey)}>{showKey?'Hide':'Show'}</button></div></label>}
              {walletMode==='restore'&&<label>Encrypted backup JSON<textarea value={backupText} onChange={e=>setBackupText(e.target.value)} rows={4}/></label>}
              <label>Wallet password<input type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="new-password"/></label>
              {!walletRecord&&<label>Confirm password<input type="password" value={confirmPassword} onChange={e=>setConfirmPassword(e.target.value)} autoComplete="new-password"/></label>}
              {!walletRecord&&walletMode==='import'&&<button className="primary-button" disabled={busy||!privateKeyInput||password.length<12||password!==confirmPassword} onClick={()=>perform(importWallet)}><KeyRound size={17}/> Encrypt and import locally</button>}
              {walletMode==='restore'&&<button className="primary-button" disabled={busy||!backupText.trim()||!password} onClick={()=>perform(restoreWallet)}><FileKey2 size={17}/> Restore encrypted backup</button>}
              {!walletRecord&&<button className="text-button" onClick={()=>setWalletMode(walletMode==='import'?'restore':'import')}>{walletMode==='import'?'Restore encrypted backup instead':'Import private key instead'}</button>}
            </div>:<div className="form-stack"><div className="address-box"><span>Saved Mainnet wallet</span><b>{shorten(walletRecord.address)}</b></div><label>Wallet password<input type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password"/></label><button className="primary-button" disabled={busy||!password} onClick={()=>perform(unlockWallet)}><LockKeyhole size={16}/> Unlock wallet</button><div className="button-row"><button className="secondary-button" onClick={()=>perform(exportBackup)}><FileKey2 size={15}/> Export encrypted backup</button><button className="outline-button" onClick={()=>{removeWallet();setWalletMode('import')}}>Remove local wallet</button></div><button className="text-button" onClick={()=>setWalletMode('restore')}>Restore another encrypted backup</button></div>}
            <p className="fine-print">Only import a wallet you control. Do not share a private key or recovery phrase. The local signature proves requester identity only; it never signs a payout transaction.</p>
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
            <article className="panel asset-source-card sponsor-liquidity"><span className="eyebrow">AUTHORIZED FINCRA SOURCE · PAYOUT FUNDING</span><h3>Available sponsor payout balance</h3><strong className="asset-large">{readiness?.fincra?.sourceBalance?.checked?readiness.fincra.sourceBalance.availableBalance:'Not verified'} <small>USDT</small></strong><span className="fine-print">{readiness?.fincra?.sourceBalance?.checked?'Live available balance returned by the configured Fincra business wallet.':'Sign in as payout owner and refresh readiness to retrieve the provider balance. No balance is estimated or invented.'}</span><div className="asset-source-meta"><span>Environment: {readiness?.fincra?.environment||'Not checked'}</span><span>Live payout: {readiness?.fincra?.canSubmitLivePayout?'Eligible for owner review':'Gated'}</span></div>{!ownerSession&&<button className="secondary-button" onClick={()=>setTab('sponsors')}>Open sponsor operations</button>}</article>
          </div>
          <div className="panel assets-total-panel"><div><span className="eyebrow">AVAILABLE FOR SPONSORED PAYOUTS</span><h2>{readiness?.fincra?.sourceBalance?.checked?readiness.fincra.sourceBalance.availableBalance+' USDT':'Unavailable'}</h2><p>This is the Fincra source-wallet availability only. Your monitored wallet balance is not included, and a positive balance alone does not authorize a payout.</p></div><div className="panel-icon"><Landmark/></div></div>
          <div className="panel"><div className="section-heading"><div><span className="eyebrow">ASSET IDENTITY</span><h3>Official Tether USD · TRC20</h3><p>Mainnet contract pinned by the backend.</p></div></div><div className="asset-row"><div className="asset-symbol token-symbol">US</div><div className="asset-name"><b>USDT · TRON Mainnet</b><small>{MAINNET_USDT}</small></div><strong>{monitorData?.tokenBalance?formatUnits(monitorData.tokenBalance.balanceBaseUnits,monitorData.tokenBalance.decimals):'Unavailable'} <small>USDT</small></strong></div></div>
        </section>}

        {tab==='withdrawals'&&<section className="panel withdrawals-page">
          <div className="section-heading"><div><span className="eyebrow">MAINNET · SPONSORED SETTLEMENT</span><h2>Request a genuine USDT withdrawal</h2><p>Fincra sends official Tether USDT from its authorized funded business source. Your monitored address is not debited.</p></div><div className="panel-icon"><ArrowUpRight/></div></div>
          {!requesterSession?<div className="owner-session-card"><strong><LockKeyhole size={15}/> Requester ownership not verified</strong><small>{unlocked?'Sign a Mainnet identity message. This does not require TRX or authorize a payout.':'Import and unlock the Mainnet wallet you control to sign an off-chain ownership challenge.'}</small><button className="secondary-button" disabled={busy||!unlocked} onClick={()=>perform(verifyRequester)}><ShieldCheck size={15}/> Verify wallet ownership</button></div>:<div className="owner-session-card"><strong><ShieldCheck size={15}/> Mainnet requester identity verified</strong><small>{shorten(requesterSession.address)} · expires {new Date(requesterSession.expiresAt).toLocaleTimeString()}</small><button className="outline-button" onClick={signOutRequester}>Sign out requester identity</button></div>}
          <div className="withdrawal-form-grid">
            <div className="form-stack">
              <label>Recipient Mainnet address<input value={requestRecipient} onChange={e=>{setRequestRecipient(e.target.value);setRequestInspection(null);setRequestInspectionError('')}} placeholder="External TRON Mainnet address (T…)" autoComplete="off" spellCheck="false"/></label>
              <button type="button" className="secondary-button" disabled={busy||requestInspectionBusy||!requestRecipient.trim()} onClick={()=>perform(inspectRequestRecipient)}><RefreshCw size={15}/>{requestInspectionBusy?'Inspecting recipient…':'Inspect recipient balance & history'}</button>
              {requestInspectionError&&<div className="notice notice-error"><AlertTriangle size={15}/><span>{requestInspectionError}</span></div>}
              {requestInspection&&requestInspection.address===requestRecipient.trim()&&<div className="request-inspection"><div><span>TRON Mainnet account</span><b>{requestInspection.data.accountExists?'Found':'Not activated / not found'}</b></div><div><span>Official USDT balance</span><b>{requestInspection.data.tokenBalance?formatUnits(requestInspection.data.tokenBalance.balanceBaseUnits,requestInspection.data.tokenBalance.decimals)+' USDT':'Unavailable'}</b></div><div><span>Incoming history</span><b>{requestInspection.data.historyStatus||'Unavailable'}</b></div><small>Inspected {new Date(requestInspection.inspectedAt).toLocaleTimeString()}. Recheck after five minutes or whenever the address changes.</small></div>}
              <label>USDT withdrawal amount<input value={requestAmount} onChange={e=>setRequestAmount(e.target.value)} placeholder="e.g. 25.00" inputMode="decimal"/></label>
              <label>Beneficiary full name<input value={beneficiaryName} onChange={e=>setBeneficiaryName(e.target.value)} placeholder="Wallet beneficiary name"/></label>
              <label>Beneficiary email (optional)<input value={beneficiaryEmail} onChange={e=>setBeneficiaryEmail(e.target.value)} placeholder="name@example.com"/></label>
              <button className="primary-button" disabled={busy||!requesterSession?.sessionToken||!requestRecipient.trim()||!requestInspection||requestInspection.address!==requestRecipient.trim()||Date.now()-requestInspection.inspectedAt>5*60*1000||!requestAmount.trim()||!beneficiaryName.trim()} onClick={()=>perform(submitSponsorRequest)}><Plus size={16}/> Create sponsor withdrawal request</button>
            </div>
            <aside className="withdrawal-eligibility"><span className="eyebrow">SETTLEMENT CONDITIONS</span><h3>Actual Mainnet USDT</h3><div className="readiness-checks"><span>Network: TRON Mainnet</span><span>Asset: official Tether USDT TRC20</span><span>Payout provider: Fincra</span><span>Blockchain verification: Tatum</span><span>Funding: authorized sponsor source</span></div><p className="fine-print">Creating a request does not debit your wallet or guarantee a payout. An authorized owner reviews it, and Fincra must confirm a funded, enabled live payout account.</p><button className="secondary-button" onClick={()=>setTab('sponsors')}>View sponsor funding readiness</button></aside>
          </div>
        </section>}

        {tab==='transactions'&&<section className="panel transactions-page">
          <div className="section-heading"><div><span className="eyebrow">FINCRA SETTLEMENT + TRON CONFIRMATION</span><h2>Withdrawal transaction history</h2><p>Provider acceptance, final provider status, and independently verified on-chain delivery are separate milestones.</p></div><button className="secondary-button" disabled={!ownerSession||busy} onClick={()=>perform(async()=>{await loadRequests(ownerSession.sessionToken);await refreshReadiness(ownerSession.sessionToken)})}><RefreshCw size={15}/> Refresh records</button></div>
          {!ownerSession?<div className="empty-state"><LockKeyhole size={24}/><b>Owner authentication required</b><p>Sign in under Sponsor funding to view private payout and settlement records.</p><button className="secondary-button" onClick={()=>setTab('sponsors')}>Open sponsor funding</button></div>:!requests.length?<div className="empty-state"><History size={24}/><b>No payout transactions recorded</b><p>Approved sponsor withdrawal requests will appear here after they are created.</p></div>:<div className="transaction-list">{requests.map(request=><article className="transaction-row" key={request.id}><div className="transaction-main"><strong>{request.amount} USDT</strong><span>To {shorten(request.recipientAddress)} · {new Date(request.createdAt).toLocaleString()}</span><small>Fincra: {request.fincraStatus||'not submitted'} · Chain: {request.chainVerificationStatus||'not verified'}</small>{request.fincraReference&&<small>Provider reference: {request.fincraReference}</small>}{request.transactionHash&&<a href={'https://tronscan.org/#/transaction/'+request.transactionHash} target="_blank" rel="noreferrer">Open verified Mainnet transaction <ExternalLink size={12}/></a>}</div><div className="transaction-actions"><button className="secondary-button" disabled={busy} onClick={()=>perform(()=>ownerAction(request.id,'fincra-status'))}>Refresh Fincra status</button><button className="secondary-button" disabled={busy||request.fincraStatus!=='successful'} onClick={()=>perform(()=>ownerAction(request.id,'verify-recipient-transfer'))}>Verify on-chain</button></div></article>)}</div>}
        </section>}

        {tab==='settings'&&<section className="panel settings-page">
          <div className="section-heading"><div><span className="eyebrow">PRODUCTION CONFIGURATION</span><h2>Tron Transfer settings</h2><p>Mainnet-only configuration and operator access. Provider secrets are never stored in this browser.</p></div><div className="panel-icon"><Settings/></div></div>
          <div className="settings-group"><span className="eyebrow">DEFAULT MONITORED ADDRESS</span><div className="address-box"><span>Read-only monitoring identity</span><b>{MAINNET_MONITORED_ADDRESS}</b></div><a href={'https://tronscan.org/#/address/'+MAINNET_MONITORED_ADDRESS} target="_blank" rel="noreferrer">Open address on TRONSCAN <ExternalLink size={12}/></a><p className="fine-print">This address is not the sponsor treasury and is never used as the payout source. To inspect a different recipient, use the Recipients page.</p></div>
          <div className="settings-group"><span className="eyebrow">PROVIDER READINESS</span><div className="readiness-checks"><span>Tatum Mainnet: {readiness?.tatum?.mainnetNode?.checked?'reachable':readiness?.tatum?.mainnetNode?.reason||'owner refresh required'}</span><span>Fincra environment: {readiness?.fincra?.environment||'not checked'}</span><span>Fincra live payout: {readiness?.fincra?.canSubmitLivePayout?'eligible for owner review':'not enabled / not funded / not verified'}</span><span>Database: {readiness?.storage?.ready?'ready':'not verified'}</span></div><button className="secondary-button" disabled={!ownerSession||busy} onClick={()=>perform(()=>refreshReadiness(ownerSession.sessionToken))}><RefreshCw size={15}/> Recheck provider readiness</button></div>
          <div className="settings-group"><span className="eyebrow">WALLET IDENTITY</span><p>{unlocked?'A local Mainnet wallet is unlocked for off-chain requester identity signing.':'No local identity wallet is unlocked.'}</p><p className="fine-print">Tron Transfer does not use the monitored address as a payout funding wallet. No private key or provider secret is sent to the frontend API.</p>{unlocked&&<button className="outline-button" onClick={lockWallet}><LockKeyhole size={15}/> Lock identity wallet</button>}</div>
        </section>}
{tab==='sponsors'&&<section className="panel sponsor-panel">
          <div className="section-heading"><div><span className="eyebrow">AUTHORIZED PRINCIPAL / LIVE PAYOUTS</span><h2>Sponsored USDT TRC20 withdrawals</h2><p>Fincra submits live payouts from an authorized funded business source. Tatum verifies the resulting Mainnet transaction.</p></div><div className="panel-icon"><ShieldCheck/></div></div>
          <div className="sponsor-readiness"><div><span className="eyebrow">FINCRA LIVE READINESS</span><strong>{readiness?.fincra?.canSubmitLivePayout?'Live payout prerequisites pass':'Live payouts currently gated'}</strong><small>Environment: {readiness?.fincra?.environment||'Not checked'} · Scheme: usdt_trc20</small></div><button className="secondary-button" onClick={()=>perform(()=>refreshReadiness())}><RefreshCw size={15}/> Refresh readiness</button></div>
          {readiness?.fincra?.sourceBalance?.checked&&readiness.fincra.sourceBalance.currency==='USDT'&&readiness.fincra.sourceBalance.walletNumber&&<div className="panel sponsor-funding-destination">
            <span className="eyebrow">SPONSOR FUNDING DESTINATION · FINCRA USDT BALANCE</span>
            <h3>Receive sponsor funding into the payout source</h3>
            <div className="funding-wallet-number"><strong>{readiness.fincra.sourceBalance.walletNumber}</strong><button type="button" className="icon-button" onClick={()=>navigator.clipboard?.writeText(readiness.fincra.sourceBalance.walletNumber).then(()=>setNotice('Fincra USDT wallet number copied.')).catch(()=>setError('Clipboard access is unavailable.'))}><Copy size={15}/> Copy</button></div>
            <p>Share this Fincra USDT balance number with an approved sponsor that also holds a Fincra account. The sponsor can initiate an authorized Fincra-to-Fincra wallet transfer to this USDT balance. The sponsor must use its own Fincra account and available USDT; Tron Transfer never receives the sponsor’s API key or initiates a debit from the sponsor’s account.</p>
            <small>Fincra wallet number is a receiving account identifier, not a TRON address. Incoming funds are counted only after Fincra reflects them in the available USDT balance.</small>
          </div>}
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
              {!ownerSession?<div className="form-stack"><label>Configured owner Mainnet address<input value={ownerAddress} onChange={e=>setOwnerAddress(e.target.value)} placeholder="T..." autoComplete="off"/></label><label>Owner password<input value={ownerPassword} onChange={e=>setOwnerPassword(e.target.value)} type="password" autoComplete="current-password"/></label><button className="secondary-button" disabled={busy||!ownerAddress.trim()||!ownerPassword} onClick={()=>perform(signInOwner)}><LockKeyhole size={16}/> Sign in as payout owner</button></div>:<div className="owner-session-card"><strong><ShieldCheck size={15}/> Owner session active</strong><small>{shorten(ownerSession.address)} · expires {new Date(ownerSession.expiresAt).toLocaleTimeString()}</small><div className="button-row"><button className="secondary-button" onClick={()=>perform(()=>loadRequests(ownerSession.sessionToken))}><RefreshCw size={15}/> Refresh queue</button><button className="outline-button" onClick={signOutOwner}>Sign out</button></div></div>}
            </div>
          {ownerSession&&<div className="sponsor-queue"><div className="section-heading"><div><span className="eyebrow">03 / PAYOUT OPERATIONS</span><h3>Mainnet withdrawal queue</h3><p>Fincra acceptance, payout settlement and chain confirmation remain separate states.</p></div></div>
            {!requests.length?<div className="empty-state"><ShieldCheck size={25}/><b>No sponsor requests in the queue</b><p>Submitted requests will appear here.</p></div>:requests.map(request=><article className="sponsor-request-row" key={request.id}>
              <div className="sponsor-request-details"><strong>{request.amount} USDT</strong><small>To {shorten(request.recipientAddress)} · {new Date(request.createdAt).toLocaleString()}</small><small>Requester {shorten(request.requesterAddress)} · {request.beneficiaryName}</small><span className="status-text">{request.status} · Fincra: {request.fincraStatus||'not submitted'} · Chain: {request.chainVerificationStatus}</span>{request.transactionHash&&<a href={'https://tronscan.org/#/transaction/'+request.transactionHash} target="_blank" rel="noreferrer">View verified transfer <ExternalLink size={12}/></a>}</div>
              <div className="sponsor-request-actions"><button className="secondary-button" disabled={busy||request.status==='fincra-successful'} onClick={()=>perform(()=>ownerAction(request.id,'fincra-status'))}>Requery Fincra</button><button className="primary-button" disabled={busy||!readiness?.fincra?.canSubmitLivePayout||!['pending-organization-review','fincra-outcome-unknown','fincra-submitting'].includes(request.status)} onClick={()=>perform(()=>ownerAction(request.id,'fincra-payout'))}>Submit / reconcile live payout</button><button className="secondary-button" disabled={busy||request.fincraStatus!=='successful'} onClick={()=>perform(()=>ownerAction(request.id,'verify-recipient-transfer'))}>Verify recipient on-chain</button></div>
            </article>)}
          </div>}
        </section>}
      </div>
      <footer className="app-footer">TRON TRANSFER · TRON MAINNET ONLY · OFFICIAL USDT TRC20 SPONSORED PAYOUTS</footer>
    </main>
  </div>
}
