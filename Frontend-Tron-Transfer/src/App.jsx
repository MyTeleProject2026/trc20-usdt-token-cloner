import { useEffect, useMemo, useState } from 'react'
import ProviderPayoutReadiness from './ProviderPayoutReadiness.jsx'
import SponsorDirectPayouts from './SponsorDirectPayouts.jsx'
import { TronWeb } from 'tronweb'
import { discoverTronLinkProvider, requestTronLinkConnection } from './tronlink-provider.mjs'
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, CheckCircle2, Coins, ExternalLink, History, LockKeyhole, LogOut, RefreshCw, Settings, ShieldCheck, Wallet, X } from 'lucide-react'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'https://trc20-usdt-token-cloner-api.onrender.com').replace(/\/+$/, '')
const MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const MAINNET_MONITORED_ADDRESS = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const OWNER_SESSION_KEY = 'tron-transfer:owner-session:v1'

function shorten(value) { return value && value.length > 18 ? value.slice(0, 9) + '…' + value.slice(-7) : value || '—' }
function isValidAddress(value) {
  try { return ADDRESS_RE.test(String(value || '')) && TronWeb.isAddress(String(value)) } catch { return false }
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
  const [tab,setTab]=useState('overview')
  const [unlocked,setUnlocked]=useState(null)
  const [monitorAddress,setMonitorAddress]=useState(MAINNET_MONITORED_ADDRESS)
  const [monitorData,setMonitorData]=useState(null)
  const [monitorError,setMonitorError]=useState('')
  const [monitorBusy,setMonitorBusy]=useState(false)
  const [creditCustomerId,setCreditCustomerId]=useState('')
  const [creditAmountTrx,setCreditAmountTrx]=useState('')
  const [creditReason,setCreditReason]=useState('')
  const [creditAccount,setCreditAccount]=useState(null)
  const [creditBusy,setCreditBusy]=useState(false)
  const [creditError,setCreditError]=useState('')
  const [oneTraxAccounting,setOneTraxAccounting]=useState(null)
  const [oneTraxBusy,setOneTraxBusy]=useState(false)
  const [oneTraxError,setOneTraxError]=useState('')
  const [oneTraxRecipient,setOneTraxRecipient]=useState('TKmwZgALZPatKVJpcAx93XVNu6DiaauPFk')
  const [oneTraxAmount,setOneTraxAmount]=useState('100')
  const [oneTraxMintBusy,setOneTraxMintBusy]=useState(false)
  const [oneTraxMintResult,setOneTraxMintResult]=useState(null)
  const [notice,setNotice]=useState('')
  const [error,setError]=useState('')
  const [busy,setBusy]=useState(false)
  const [ownerAddress,setOwnerAddress]=useState(MAINNET_MONITORED_ADDRESS)
  const [ownerPassword,setOwnerPassword]=useState('')
  const [ownerSession,setOwnerSession]=useState(null)
  const [ownerSessionResolved,setOwnerSessionResolved]=useState(false)
  const addressLink=useMemo(()=>isValidAddress(monitorAddress)?'https://tronscan.org/#/address/'+encodeURIComponent(monitorAddress):null,[monitorAddress])

  useEffect(()=>{
    let token = ''
    try { token = sessionStorage.getItem(OWNER_SESSION_KEY) || '' } catch {}
    if (token) {
      void restoreOwner(token).finally(() => setOwnerSessionResolved(true))
    } else {
      setOwnerSessionResolved(true)
    }
  },[])

  useEffect(() => {
    if (!ownerSession?.expiresAt) return undefined
    const expireSession = () => {
      void signOutOwner()
      setNotice('The private owner session expired. Sign in again to continue.')
    }
    const remaining = ownerSession.expiresAt - Date.now()
    if (remaining <= 0) {
      expireSession()
      return undefined
    }
    const timer = window.setTimeout(expireSession, remaining)
    return () => window.clearTimeout(timer)
  }, [ownerSession?.expiresAt])

  useEffect(()=>{
    if (!ownerSession?.sessionToken) return
    void inspectAddress(MAINNET_MONITORED_ADDRESS).catch(e=>setMonitorError(e.message))
  },[ownerSession?.sessionToken])

  async function perform(fn) {
    setBusy(true); setError('')
    try { return await fn() } catch(e) { setError(e instanceof Error?e.message:'Operation failed.'); return null } finally { setBusy(false) }
  }

  async function connectTronLink() {
    const provider=await discoverTronLinkProvider(window)
    if(!provider) throw new Error('TronLink was not detected. Open this page in the TronLink DApp browser, unlock your wallet, and connect again.')
    const {address,tronWeb}=await requestTronLinkConnection(provider,window)
    if(!isValidAddress(address)) throw new Error('TronLink returned an invalid account address. Select a valid TRON account and retry.')
    let node=''
    try { node=new URL(String(tronWeb.fullNode?.host||'')).hostname.toLowerCase() } catch {}
    if(node!=='api.trongrid.io') throw new Error('Network mismatch. Tron Transfer requires TRON Mainnet. Switch TronLink to Mainnet, then reconnect.')
    setUnlocked({address,tronWeb,provider})
    setNotice('TronLink connected to TRON Mainnet. Your private key stays in TronLink; this wallet proves requester identity only. Payout execution depends on a provider-approved funding arrangement; your wallet is not the source of payout principal.')
  }
  useEffect(()=>{
    const provider=unlocked?.provider
    if(!provider||typeof provider.on!=='function') return undefined
    const invalidateWallet=()=>{
      setUnlocked(null)
      setTab('overview')
      setNotice('The TronLink account or network changed. Reconnect and verify the configured owner wallet before continuing.')
    }
    const events=['accountsChanged','chainChanged','disconnect']
    for(const event of events) provider.on(event,invalidateWallet)
    return ()=>{
      if(typeof provider.removeListener==='function') {
        for(const event of events) provider.removeListener(event,invalidateWallet)
      }
    }
  },[unlocked?.provider])

  function lockWallet() {
    setUnlocked(null)
    setTab('overview')
    setNotice('TronLink disconnected from this application. Your wallet remains in TronLink.')
  }
  async function loadRestrictedCredits() {
    const customerId=creditCustomerId.trim()
    if(!/^[A-Za-z0-9._:-]{1,128}$/.test(customerId)) throw new Error('Enter a valid customer ID or TRON address.')
    setCreditBusy(true);setCreditError('')
    try {
      const result=await api('/api/ripple-custody/credits/'+encodeURIComponent(customerId),{headers:{Authorization:'Bearer '+ownerSession.sessionToken}})
      if(result.success!==true) throw new Error(result.error||'Restricted credit ledger unavailable.')
      setCreditAccount(result.account);return result.account
    } catch(e) {setCreditError(e.message);throw e} finally {setCreditBusy(false)}
  }
  async function allocateRestrictedCredits() {
    const customerId=creditCustomerId.trim(),amount=creditAmountTrx.trim(),reason=creditReason.trim()
    if(!/^[A-Za-z0-9._:-]{1,128}$/.test(customerId)) throw new Error('Enter a valid customer ID or TRON address.')
    if(!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(amount)||!/[1-9]/.test(amount)) throw new Error('Enter a positive TRX amount with up to 6 decimal places.')
    const parts=amount.split('.'),whole=parts[0],fraction=parts[1]||''
    const amountSun=(BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0'))).toString()
    if(reason.length<4||reason.length>500) throw new Error('Enter an audit reason (4–500 characters).')
    const result=await api('/api/ripple-custody/credits/allocate',{method:'POST',headers:{Authorization:'Bearer '+ownerSession.sessionToken},body:JSON.stringify({customerId,amountSun,idempotencyKey:'admin-'+crypto.randomUUID(),reason})})
    if(result.success!==true) throw new Error(result.error||'Credit allocation failed.')
    setNotice('Restricted TRX-denominated internal credit recorded. No blockchain transfer or Bitpie deposit was made.')
    setCreditAmountTrx('');await loadRestrictedCredits();return result
  }
  async function loadOneTraxAccounting() {
    setOneTraxBusy(true); setOneTraxError('')
    try {
      const result=await api('/api/ripple-custody/1trax/accounting',{headers:{Authorization:'Bearer '+ownerSession.sessionToken}})
      if(result.success!==true) throw new Error(result.error||'1TRAX accounting unavailable.')
      setOneTraxAccounting(result); return result
    } catch(e) {setOneTraxError(e.message);throw e} finally {setOneTraxBusy(false)}
  }
  async function prepareAndMintOneTrax() {
    if (!unlocked?.tronWeb || !unlocked?.address) throw new Error('Connect the configured owner wallet in TronLink on TRON Mainnet first.')
    if (!isValidAddress(oneTraxRecipient.trim())) throw new Error('Enter a valid TRON Mainnet recipient address.')
    if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(oneTraxAmount) || !/[1-9]/.test(oneTraxAmount)) throw new Error('Enter a positive amount with up to 6 decimal places.')
    const parts=oneTraxAmount.split('.'), amountUnits=(BigInt(parts[0])*1000000n+BigInt((parts[1]||'').padEnd(6,'0'))).toString()
    if (!oneTraxAccounting?.configured || !oneTraxAccounting?.liability?.contractAddress || !oneTraxAccounting?.reserve?.address) { await loadOneTraxAccounting(); throw new Error('Mainnet accounting was refreshed. Review it, then request minting again.') }
    const tokenAddress=oneTraxAccounting.liability.contractAddress, vaultAddress=oneTraxAccounting.reserve.address, tronWeb=unlocked.tronWeb
    let walletNodeHost=''; try { walletNodeHost=new URL(String(tronWeb.fullNode?.host||'')).hostname.toLowerCase() } catch {}
    if (walletNodeHost!=='api.trongrid.io') throw new Error('Wallet network is not confirmed as TRON Mainnet.')
    const abi=[
      {constant:true,inputs:[],name:'owner',outputs:[{name:'',type:'address'}],stateMutability:'view',type:'function'},
      {constant:true,inputs:[],name:'name',outputs:[{name:'',type:'string'}],stateMutability:'view',type:'function'},
      {constant:true,inputs:[],name:'symbol',outputs:[{name:'',type:'string'}],stateMutability:'view',type:'function'},
      {constant:true,inputs:[],name:'decimals',outputs:[{name:'',type:'uint8'}],stateMutability:'view',type:'function'},
      {constant:true,inputs:[],name:'paused',outputs:[{name:'',type:'bool'}],stateMutability:'view',type:'function'},
      {constant:true,inputs:[],name:'mintingEnabled',outputs:[{name:'',type:'bool'}],stateMutability:'view',type:'function'},
      {constant:true,inputs:[],name:'reserveVault',outputs:[{name:'',type:'address'}],stateMutability:'view',type:'function'},
      {constant:true,inputs:[],name:'totalSupply',outputs:[{name:'',type:'uint256'}],stateMutability:'view',type:'function'},
      {constant:true,inputs:[],name:'authorizedToken',outputs:[{name:'',type:'address'}],stateMutability:'view',type:'function'},
      {constant:false,inputs:[{name:'recipient',type:'address'},{name:'amount',type:'uint256'}],name:'mint',outputs:[],stateMutability:'nonpayable',type:'function'}
    ]
    setOneTraxMintBusy(true); setOneTraxMintResult(null); setOneTraxError('')
    try {
      const token=await tronWeb.contract(abi).at(tokenAddress)
      const [contractOwner,tokenName,tokenSymbol,tokenDecimals,paused,mintingEnabled,linkedVault,supply,vaultToken]=await Promise.all([token.owner().call(),token.name().call(),token.symbol().call(),token.decimals().call(),token.paused().call(),token.mintingEnabled().call(),token.reserveVault().call(),token.totalSupply().call(),(await tronWeb.contract([{constant:true,inputs:[],name:'authorizedToken',outputs:[{name:'',type:'address'}],stateMutability:'view',type:'function'}]).at(vaultAddress)).authorizedToken().call()])
      if (tokenName!=='TRӾ' || tokenSymbol!=='TRX' || Number(tokenDecimals)!==6) throw new Error('Deployed contract metadata does not match the approved TRӾ / TRX six-decimal specification.')
      if (tronWeb.address.toHex(contractOwner)!==tronWeb.address.toHex(unlocked.address)) throw new Error('Connected TronLink account is not the token contract owner.')
      if (paused!==false || mintingEnabled!==true) throw new Error('Minting is not enabled and unpaused on-chain. Do not bypass this safety lock.')
      if (tronWeb.address.toHex(linkedVault)!==tronWeb.address.toHex(vaultAddress) || tronWeb.address.toHex(vaultToken)!==tronWeb.address.toHex(tokenAddress)) throw new Error('Token and reserve-vault authorization links do not match the configured Mainnet contracts.')
      const reserveSun=BigInt(String(await tronWeb.trx.getBalance(vaultAddress))), outstanding=BigInt(String(supply))
      if (reserveSun < outstanding+BigInt(amountUnits)) throw new Error('Insufficient native TRX reserve for this issuance.')
      const txid=await token.mint(oneTraxRecipient.trim(),amountUnits).send({feeLimit:100000000,callValue:0,shouldPollResponse:true,keepTxID:true})
      setOneTraxMintResult({txid,recipient:oneTraxRecipient.trim(),amount:oneTraxAmount,status:'Submitted; independent solidified confirmation is still required.'})
      setNotice('Mint transaction submitted. Verify its solidified result on TRONSCAN before treating the credit as delivered.')
      await loadOneTraxAccounting()
    } catch(e) { setOneTraxError(e instanceof Error?e.message:'Mainnet mint request failed.'); throw e }
    finally { setOneTraxMintBusy(false) }
  }
  async function inspectAddress(address=monitorAddress) {
    if(!isValidAddress(address)) throw new Error('Enter a valid TRON Mainnet address.')
    setMonitorBusy(true); setMonitorError('')
    try {
      if (!ownerSession?.sessionToken) throw new Error('Sign in to the private owner account first.')
      const query=new URLSearchParams({network:'mainnet',address,tokenContract:MAINNET_USDT})
      const result=await api('/api/tron-transfer/recipient?'+query.toString(), {
        headers: { Authorization: 'Bearer ' + ownerSession.sessionToken },
      })
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
    setOwnerSessionResolved(true)
    } catch {setOwnerSession(null)} finally {setOwnerSessionResolved(true)}
  }
  async function signInOwner() {
    if(!isValidAddress(ownerAddress.trim())||!ownerPassword) throw new Error('Enter the configured owner Mainnet address and password.')
    const p=await api('/api/auth/owner/login',{method:'POST',body:JSON.stringify({address:ownerAddress.trim(),password:ownerPassword})})
    if(p.authenticated!==true||p.network!=='mainnet'||typeof p.sessionToken!=='string'||!Number.isFinite(p.expiresAt)) throw new Error('Owner authentication failed.')
    sessionStorage.setItem(OWNER_SESSION_KEY,p.sessionToken);setOwnerPassword('')
    setOwnerSession({address:p.address,expiresAt:p.expiresAt,sessionToken:p.sessionToken})
    setOwnerSessionResolved(true)
    setNotice('Private platform-owner session active. Your TronLink wallet is not used as the source of payout funds. External payouts remain disabled until a provider authorizes provider-owned liquidity or an approved credit facility for this account.')
  }
  async function signOutOwner() {
    const token = ownerSession?.sessionToken
    // Lock this browser immediately, even if the network is unavailable.
    try { sessionStorage.removeItem(OWNER_SESSION_KEY) } catch {}
    setOwnerSession(null)
    setUnlocked(null)
    setMonitorData(null)
    setTab('overview')
    if (!token) return
    try {
      await api('/api/auth/owner/logout', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token },
      })
    } catch {
      setError('Server-side session revocation could not be confirmed. The server session will expire automatically.')
    }
  }
  const nav=[
    {id:'overview',label:'Dashboard',icon:Wallet},
    {id:'assets',label:'Assets',icon:Coins},
    {id:'recipients',label:'Recipients',icon:ArrowDownLeft},
    {id:'withdrawals',label:'Withdrawals',icon:ArrowUpRight},
    {id:'provider',label:'Funding provider',icon:ShieldCheck},
    {id:'credits',label:'Restricted credits',icon:LockKeyhole},
    {id:'1trax',label:'TRӾ Mainnet',icon:Coins},
    {id:'sponsors',label:'Sponsor approvals',icon:ShieldCheck},
    {id:'transactions',label:'Transactions',icon:History},
    {id:'settings',label:'Settings',icon:Settings},
  ]

  if (!ownerSessionResolved) return (
    <div className="app-shell">
      <main className="main-content">
        <div className="content"><section className="panel"><div className="section-heading"><div><span className="eyebrow">PRIVATE OWNER WORKSPACE</span><h2>Checking owner session</h2><p>Verifying the configured platform-owner session before opening Tron Transfer.</p></div><div className="panel-icon"><ShieldCheck/></div></div></section></div>
      </main>
    </div>
  )

  if (!ownerSession) return (
    <div className="app-shell">
      <main className="main-content">
        <div className="content">
          <section className="panel provider-panel">
            <div className="section-heading"><div><span className="eyebrow">TRON TRANSFER · PRIVATE ACCESS</span><h2>Platform owner sign-in</h2><p>This workspace is reserved for the configured owner account. Sponsors use a separate TronLink wallet portal and cannot enter the owner console.</p></div><div className="panel-icon"><LockKeyhole/></div></div>
            {error&&<div className="notice notice-error" role="alert"><AlertTriangle size={17}/><span>{error}</span></div>}
            <div className="form-stack">
              <label>Configured owner TRON Mainnet address<input value={ownerAddress} onChange={e=>setOwnerAddress(e.target.value)} placeholder="T..." autoComplete="username"/></label>
              <label>Owner password<input value={ownerPassword} onChange={e=>setOwnerPassword(e.target.value)} type="password" autoComplete="current-password"/></label>
              <button className="primary-button" disabled={busy||!ownerAddress.trim()||!ownerPassword} onClick={()=>perform(signInOwner)}><LockKeyhole size={16}/>{busy?'Signing in…':'Sign in to private workspace'}</button>
            </div>
            <p className="fine-print">Never share your password, wallet private key or recovery phrase. This password authenticates the platform owner; it does not fund withdrawals.</p>
          </section>
        </div>
      </main>
    </div>
  )

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#"><span className="brand-mark">T</span><span>TRON <b>TRANSFER</b><small>MAINNET USDT PAYOUTS</small></span></a>
      <div className="network-card"><span className="eyebrow">PRODUCTION NETWORK</span><div className="network-chip"><i/> TRON Mainnet</div><span className="network-dot"><i/> OFFICIAL TETHER USDT TRC20</span></div>
      <nav>{nav.map(item=><button key={item.id} className={tab===item.id?'active':''} onClick={()=>setTab(item.id)}><item.icon size={17}/>{item.label}</button>)}</nav>
      <div className="sidebar-bottom"><div className="security-note"><ShieldCheck size={17}/><span>TronLink signing<br/><b>No imported private keys</b></span></div>{unlocked?<button className="outline-button" onClick={lockWallet}><LockKeyhole size={16}/> Disconnect wallet</button>:<span className="muted small">Wallet not connected</span>}</div>
    </aside>
    <main className="main-content">
      <header className="topbar"><div><span className="eyebrow">TRON TRANSFER · PRODUCTION MAINNET</span><h1>{{overview:'Mainnet payout workspace',assets:'Mainnet assets & provider funding',recipients:'Recipient balance & incoming history',withdrawals:'Sponsored USDT withdrawal',provider:'External payout funding','1trax':'TRӾ Mainnet reserve accounting',sponsors:'Sponsor approvals',transactions:'Sponsored payout history',settings:'Platform settings'}[tab]||'Tron Transfer'}</h1></div><div className="topbar-actions"><span className="network-chip"><i/> TRON Mainnet</span><span className="muted small">Owner {shorten(ownerSession.address)}</span><button className="outline-button" onClick={signOutOwner}><LogOut size={15}/> Sign out</button>{unlocked&&<button className="outline-button" onClick={lockWallet}><LockKeyhole size={15}/> Lock wallet</button>}</div></header>
      <div className="content">
        <section className="notice notice-warning"><AlertTriangle size={18}/><div><b>Private owner-only USDT withdrawals</b><p>Only the configured platform owner can operate this workspace. Your personal TronLink wallet is not treated as the source of payout funds. A real withdrawal requires a provider that has expressly authorized this owner account and verified provider-owned liquidity or an approved credit facility. Tatum provides TRON Mainnet infrastructure and independent chain verification.</p></div></section>
        {notice&&<div className="notice notice-success" role="status"><CheckCircle2 size={17}/><span>{notice}</span><button onClick={()=>setNotice('')} aria-label="Dismiss notice"><X size={15}/></button></div>}
        {error&&<div className="notice notice-error" role="alert"><AlertTriangle size={17}/><span>{error}</span><button onClick={()=>setError('')} aria-label="Dismiss error"><X size={15}/></button></div>}

        {tab==='overview'&&<>
          <section className="wallet-summary">
            <div className="panel balance-card"><div className="panel-heading"><div><span className="eyebrow">MONITORED MAINNET ADDRESS</span><h2>{shorten(monitorAddress)}</h2>{addressLink&&<a href={addressLink} target="_blank" rel="noreferrer">Open TRONSCAN <ExternalLink size={13}/></a>}</div><div className="panel-icon"><Wallet/></div></div><div className="balance-number">{monitorData?.tokenBalance?formatUnits(monitorData.tokenBalance.balanceBaseUnits,monitorData.tokenBalance.decimals):'—'} <small>USDT</small></div><div className="balance-footer"><span>Official TRC20 USDT · Mainnet</span><button className="icon-button" disabled={monitorBusy} onClick={()=>perform(()=>inspectAddress())}><RefreshCw size={16}/> Refresh</button></div></div>
            <div className="panel quick-card"><span className="eyebrow">PAYOUT MODEL</span><strong className="status-live"><i/> Owner-requested · sponsor-funded</strong><p>Your wallet is used for identity only. A separate, approved sponsor wallet must hold the requested official USDT, cover its own TRON resources and sign the exact transfer before any funds move.</p><button className="secondary-button" onClick={()=>setTab('sponsors')}>Review sponsor wallets</button></div>
          </section>
          <section className="panel"><div className="section-heading"><div><span className="eyebrow">OFFICIAL ASSET</span><h2>Tether USD · TRC20</h2><p>The production asset is pinned to the official TRON Mainnet token contract.</p></div><div className="panel-icon"><ShieldCheck/></div></div><div className="asset-row"><div className="asset-symbol token-symbol">US</div><div className="asset-name"><b>Official Tether USD</b><small>{MAINNET_USDT}</small></div><strong>{monitorData?.tokenBalance?formatUnits(monitorData.tokenBalance.balanceBaseUnits,monitorData.tokenBalance.decimals):'Not loaded'} <small>USDT</small></strong></div><p className="fine-print">Only the official Mainnet contract is supported. This dashboard displays only actual Mainnet balances for the monitored address and does not display simulated tokens.</p></section>
          <section className="panel wallet-access">
            <div className="panel-heading"><div><span className="eyebrow">REQUESTER WALLET · TRONLINK</span><h2>{unlocked?'TronLink connected':'Connect your TronLink wallet'}</h2><p>Your personal TronLink account establishes the configured owner identity. It is not used as the source of payout USDT or TRX.</p></div><div className="panel-icon"><Wallet/></div></div>
            {unlocked?<div className="form-stack"><div className="address-box"><span>Connected TRON Mainnet account</span><b>{unlocked.address}</b></div><div className="button-row"><button className="secondary-button" disabled={busy} onClick={()=>perform(connectTronLink)}><RefreshCw size={15}/> Refresh connection</button><button className="outline-button" onClick={lockWallet}><LogOut size={15}/> Disconnect</button></div></div>:<div className="form-stack"><p className="fine-print">Open this application in the TronLink DApp browser on Android, unlock your wallet, then connect. Never paste a private key or recovery phrase into this website.</p><button className="primary-button" disabled={busy} onClick={()=>perform(connectTronLink)}><Wallet size={16}/> Connect TronLink</button></div>}
            <p className="fine-print">Wallet connection alone does not authorize a payout. You sign only an identity message. A connected owner wallet does not authorize spending or create payout funds; each payout must be funded and signed by a separately approved sponsor wallet.</p>
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
          <p className="fine-print">Balance and history reads are Mainnet-only. A withdrawal is not marked complete until Tatum confirms the exact solidified Tether Transfer on Mainnet.</p>
        </section>}

        
        {tab==='assets'&&<section className="assets-page">
          <div className="section-heading"><div><span className="eyebrow">OFFICIAL TRON MAINNET ASSETS</span><h2>Wallet assets</h2><p>Read-only holdings for the monitored address. These balances are not assumed to fund external payouts.</p></div><button className="secondary-button" disabled={busy} onClick={()=>perform(()=>inspectAddress(MAINNET_MONITORED_ADDRESS))}><RefreshCw size={15}/> Refresh monitored balance</button></div>
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
              <span className="eyebrow">SELF-CUSTODY SPONSOR FUNDING</span>
              <h3>Actual payout funding</h3>
              <p>No sponsor wallet has yet been owner-approved and verified with sufficient live USDT and TRON resources. Your personal wallet remains identity-only. Open Sponsor approvals to review a voluntary sponsor wallet.</p>
              <button className="primary-button" onClick={()=>setTab('sponsors')}><ShieldCheck size={16}/> Review sponsor wallets</button>
            </article>
          </div>
          <div className="panel assets-total-panel">
            <div><span className="eyebrow">OFFICIAL TOKEN IDENTITY</span><h2>USDT · TRON TRC20</h2><p>Only the official Tether Mainnet contract is supported: {MAINNET_USDT}. Test tokens and simulated balances are not included.</p></div>
            <div className="panel-icon"><ShieldCheck/></div>
          </div>
        </section>}

        {tab==='withdrawals'&&<SponsorDirectPayouts wallet={unlocked} ownerSession={ownerSession} mode="withdraw" />}

        {tab==='transactions'&&<SponsorDirectPayouts wallet={unlocked} ownerSession={ownerSession} mode="history" />}

        {tab==='sponsors'&&<section className="panel provider-panel">
          <div className="section-heading"><div><span className="eyebrow">PRIVATE OWNER · SPONSOR WALLET REVIEW</span><h2>Approved sponsor wallets</h2><p>Invite a separate wallet owner to the sponsor portal. You review each wallet and set its per-payout and daily caps; every Mainnet transfer still requires that sponsor to sign the exact transaction.</p><a href="#/sponsor" target="_blank" rel="noreferrer">Open the separate sponsor portal <ExternalLink size={12}/></a></div><div className="panel-icon"><ShieldCheck/></div></div>
          <SponsorDirectPayouts wallet={unlocked} ownerSession={ownerSession} mode="sponsor" />
        </section>}

        {tab==='credits'&&<section className="panel provider-panel">
          <div className="section-heading"><div><span className="eyebrow">OWNER-ONLY · APPEND-ONLY LEDGER</span><h2>Restricted TRX-denominated credits</h2><p>Allocate and inspect internal credits for a customer ID or TRON address. These entries are not native TRX, are not withdrawable on-chain, and do not change any Bitpie wallet balance.</p></div><div className="panel-icon"><LockKeyhole/></div></div>
          <div className="transfer-form">
            <label className="wide-field">Customer ID / recipient TRON address<input value={creditCustomerId} onChange={e=>setCreditCustomerId(e.target.value)} placeholder="Customer ID or T…" autoComplete="off" spellCheck="false"/></label>
            <div className="button-row wide-field"><button className="secondary-button" disabled={creditBusy||!creditCustomerId.trim()} onClick={()=>perform(loadRestrictedCredits)}><RefreshCw size={15}/>{creditBusy?'Loading…':'View restricted balance'}</button></div>
            <label>Credit amount (TRX denomination)<input value={creditAmountTrx} onChange={e=>setCreditAmountTrx(e.target.value)} placeholder="e.g. 25.000000" inputMode="decimal"/></label>
            <label className="wide-field">Audit reason<input value={creditReason} onChange={e=>setCreditReason(e.target.value)} placeholder="Reason for this internal credit allocation"/></label>
            <button className="primary-button" disabled={busy||creditBusy||!creditCustomerId.trim()||!creditAmountTrx.trim()||creditReason.trim().length<4} onClick={()=>perform(allocateRestrictedCredits)}><LockKeyhole size={16}/> Allocate restricted internal credit</button>
          </div>
          {creditError&&<div className="notice notice-error" role="alert"><AlertTriangle size={16}/><span>{creditError}</span></div>}
          {creditAccount&&<div className="recipient-balance-grid"><article className="metric-card"><span>Restricted balance</span><strong>{formatUnits(creditAccount.balanceSun,6)} <small>TRX-credit</small></strong></article><article className="metric-card"><span>Ledger entries</span><strong>{creditAccount.entryCount}</strong></article><article className="metric-card"><span>Account status</span><strong>{creditAccount.status}</strong></article><article className="metric-card"><span>On-chain withdrawal</span><strong>Not supported</strong></article></div>}
          <div className="notice notice-warning"><AlertTriangle size={17}/><div><b>Accounting boundary</b><p>These credits exist only in Tron Transfer's internal ledger. They are not actual TRX custody, a blockchain transaction, a Bitpie deposit, or a balance Bitpie can display. Actual TRX must be deposited and confirmed on TRON separately.</p></div></div>
        </section>}
        {tab==='1trax'&&<section className="panel provider-panel">
          <div className="section-heading"><div><span className="eyebrow">OWNER-ONLY · TRON MAINNET READ-ONLY</span><h2>TRӾ reserve reconciliation</h2><p>Compares the dedicated native TRX reserve address with the separate custom TRӾ (TRX ticker) contract supply. This is a Mainnet node snapshot, not proof of redemption liquidity or a guaranteed market price.</p></div><div className="panel-icon"><Coins/></div></div>
          <div className="button-row"><button className="secondary-button" disabled={oneTraxBusy} onClick={()=>perform(loadOneTraxAccounting)}><RefreshCw size={15}/>{oneTraxBusy?'Reading Mainnet…':'Refresh Mainnet accounting'}</button></div>
          {oneTraxError&&<div className="notice notice-error" role="alert"><AlertTriangle size={16}/><span>{oneTraxError}</span></div>}
          {oneTraxAccounting?.configured===false&&<div className="notice notice-warning"><AlertTriangle size={17}/><div><b>Mainnet accounting not configured</b><p>Backend settings required: {(oneTraxAccounting.missing||[]).join(', ')}. Configure the deployed Mainnet contract and dedicated reserve vault addresses.</p></div></div>}
          {oneTraxAccounting?.configured===true&&<div className="recipient-balance-grid">
            <article className="metric-card"><span>Network</span><strong>{oneTraxAccounting.network}</strong></article>
            <article className="metric-card"><span>Native TRX reserve</span><strong>{formatUnits(oneTraxAccounting.reserve.balanceSun,6)} <small>TRX</small></strong></article>
            <article className="metric-card"><span>TRӾ outstanding</span><strong>{formatUnits(oneTraxAccounting.liability.totalSupplyUnits,6)} <small>TRӾ</small></strong></article>
            <article className="metric-card"><span>Reserve shortfall</span><strong>{formatUnits(oneTraxAccounting.reconciliation.shortfallSun,6)} <small>TRX-equivalent units</small></strong></article>
            <article className="metric-card"><span>Reserve surplus</span><strong>{formatUnits(oneTraxAccounting.reconciliation.surplusSun,6)} <small>TRX</small></strong></article>
            <article className="metric-card"><span>Backing ratio</span><strong>{oneTraxAccounting.reconciliation.backingRatioBasisPoints===null?'—':(Number(oneTraxAccounting.reconciliation.backingRatioBasisPoints)/100).toFixed(2)+'%'}</strong></article>
          </div>}
          <div className="settings-group">
            <span className="eyebrow">OWNER-ONLY MAINNET ISSUANCE</span>
            <h3>Mint restricted TRӾ</h3>
            <p>Minting requires the deployed token owner in TronLink, an unpaused contract, enabled minting, and sufficient native TRX reserve. The button requests a wallet signature and submits a real Mainnet transaction.</p>
            <label>Recipient TRON address<input value={oneTraxRecipient} onChange={e=>setOneTraxRecipient(e.target.value)} autoComplete="off" spellCheck="false"/></label>
            <label>Amount (TRӾ)<input value={oneTraxAmount} onChange={e=>setOneTraxAmount(e.target.value)} inputMode="decimal"/></label>
            <div className="button-row">
              {!unlocked&&<button className="secondary-button" onClick={()=>perform(connectTronLink)}><Wallet size={15}/> Connect owner TronLink</button>}
              <button className="primary-button" disabled={oneTraxMintBusy||!unlocked||!oneTraxAccounting?.configured||!isValidAddress(oneTraxRecipient)||!oneTraxAmount.trim()} onClick={()=>perform(prepareAndMintOneTrax)}><LockKeyhole size={15}/>{oneTraxMintBusy?"Preparing Mainnet mint…":"Review and request wallet signature"}</button>
            </div>
            {oneTraxMintResult&&<div className="notice notice-warning"><CheckCircle2 size={17}/><div><b>Transaction submitted — confirmation pending</b><p>{oneTraxMintResult.amount} TRӾ to {oneTraxMintResult.recipient}</p><a href={"https://tronscan.org/#/transaction/"+oneTraxMintResult.txid} target="_blank" rel="noreferrer">View transaction on TRONSCAN <ExternalLink size={12}/></a><p className="fine-print">{oneTraxMintResult.status}</p></div></div>}
            {oneTraxMintBusy&&<p className="fine-print">Review the exact recipient and amount in TronLink before signing.</p>}
          </div>
          <div className="notice notice-warning"><AlertTriangle size={17}/><div><b>Strict separation</b><p>Reserve TRX is a real native-asset balance at the configured Mainnet vault. TRӾ supply is a separate custom-token liability, not native TRX. They are never added together. A matching ratio is not a guaranteed market price, USD value, or proof that Bitpie displays the token.</p></div></div>
        </section>}
        {tab==='provider'&&<section className="panel provider-panel">
          <div className="section-heading"><div><span className="eyebrow">PRIVATE PLATFORM OWNER · PAYOUT PROVIDER</span><h2>Provider funding authorization</h2><p>Provider-managed payout credit is not configured. The active route is a separately owned, self-custody sponsor wallet that must be reviewed, funded and explicitly sign each transfer.</p></div><div className="panel-icon"><ShieldCheck/></div></div>
          <ProviderPayoutReadiness ownerSession={ownerSession} mode="withdraw" />
        </section>}

        {tab==='settings'&&<section className="panel settings-page">
          <div className="section-heading"><div><span className="eyebrow">PRODUCTION CONFIGURATION</span><h2>Tron Transfer settings</h2><p>Mainnet-only configuration and operator access. Provider secrets remain on the backend and are never stored in this browser.</p></div><div className="panel-icon"><Settings/></div></div>
          <div className="settings-group"><span className="eyebrow">MONITORED ADDRESS</span><div className="address-box"><span>Read-only Mainnet identity</span><b>{MAINNET_MONITORED_ADDRESS}</b></div><a href={'https://tronscan.org/#/address/'+MAINNET_MONITORED_ADDRESS} target="_blank" rel="noreferrer">Open address on TRONSCAN <ExternalLink size={12}/></a><p className="fine-print">Your TronLink wallet is an identity wallet only. It is not the payout funding source; provider funding is checked on the Funding provider page.</p></div>
          <div className="settings-group"><span className="eyebrow">TATUM MAINNET</span><p>Tatum provides TRON Mainnet balance reads, transaction construction/broadcast and solidified-transfer verification. It does not supply USDT or pay fees. A separate sponsor wallet supplies the exact USDT principal and network resources, and its owner signs every transfer.</p><p className="fine-print">Provider credentials and authorization remain server-side. Never place provider secrets, wallet private keys or recovery phrases in this frontend.</p><button className="secondary-button" onClick={()=>setTab('provider')}><ShieldCheck size={15}/> Open provider readiness</button></div>
          <div className="settings-group"><span className="eyebrow">WALLET SIGNING</span><p>{unlocked?'TronLink is connected to '+shorten(unlocked.address)+'.':'No TronLink wallet is connected.'}</p><p className="fine-print">The site never asks for a private key or recovery phrase. Connecting TronLink does not authorize the platform to spend from your wallet and does not create payout funds. External provider execution needs separate provider authorization.</p>{unlocked&&<button className="outline-button" onClick={lockWallet}><LockKeyhole size={15}/> Disconnect wallet</button>}</div>
        </section>}


      </div>
      <footer className="app-footer">TRON TRANSFER · PRIVATE OWNER-ONLY WORKSPACE · TRON MAINNET · OFFICIAL USDT TRC20</footer>
    </main>
  </div>
}
