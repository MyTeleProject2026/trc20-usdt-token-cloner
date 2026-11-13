import { useEffect, useMemo, useRef, useState } from 'react'
import TRXMainnetPanel from './TRXMainnetPanel.jsx'
import { TronWeb } from 'tronweb'
import { discoverTronLinkProvider, requestTronLinkConnection } from './tronlink-provider.mjs'
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, CheckCircle2, Coins, ExternalLink, History, LockKeyhole, LogOut, MoreHorizontal, RefreshCw, Settings, ShieldCheck, Wallet, X } from 'lucide-react'

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
  const [moreOpen,setMoreOpen]=useState(false)
  const moreTriggerRef=useRef(null)
  const moreMenuRef=useRef(null)
  const wasMoreOpen=useRef(false)
  const [unlocked,setUnlocked]=useState(null)
  const [monitorAddress,setMonitorAddress]=useState(MAINNET_MONITORED_ADDRESS)
  const [monitorData,setMonitorData]=useState(null)
  const [monitorError,setMonitorError]=useState('')
  const [monitorBusy,setMonitorBusy]=useState(false)
  const [notice,setNotice]=useState('')
  const [error,setError]=useState('')
  const [busy,setBusy]=useState(false)
  const [ownerAddress,setOwnerAddress]=useState(MAINNET_MONITORED_ADDRESS)
  const [ownerPassword,setOwnerPassword]=useState('')
  const [ownerSession,setOwnerSession]=useState(null)
  const [ownerSessionResolved,setOwnerSessionResolved]=useState(false)
  const [managedTreasuryReadiness,setManagedTreasuryReadiness]=useState(null)
  const [managedTreasuryReadinessError,setManagedTreasuryReadinessError]=useState('')
  const [managedTreasuryReadinessBusy,setManagedTreasuryReadinessBusy]=useState(false)

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    const closeOnEscape = event => {
      if (event.key === 'Escape') setMoreOpen(false)
    }
    if (moreOpen) {
      document.body.style.overflow = 'hidden'
      window.addEventListener('keydown', closeOnEscape)
      moreMenuRef.current?.querySelector('button')?.focus()
    } else if (wasMoreOpen.current) {
      moreTriggerRef.current?.focus()
    }
    wasMoreOpen.current = moreOpen
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [moreOpen])
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

  useEffect(()=>{
    if (tab !== 'provider' || !ownerSession?.sessionToken) return
    void refreshManagedTreasuryReadiness()
  },[tab,ownerSession?.sessionToken])

  async function perform(fn) {
    setBusy(true); setError('')
    try { return await fn() } catch(e) { setError(e instanceof Error?e.message:'Operation failed.'); return null } finally { setBusy(false) }
  }

  async function connectTronLink() {
    const provider=await discoverTronLinkProvider(window)
    if(!provider) throw new Error('No compatible injected TRON wallet was detected. Open this page in your wallet's DApp browser or enable its browser extension, then reconnect.')
    const {address,tronWeb}=await requestTronLinkConnection(provider,window)
    if(!isValidAddress(address)) throw new Error('The selected wallet returned an invalid TRON account address. Select a valid account and retry.')
    let node=''
    try { node=new URL(String(tronWeb.fullNode?.host||'')).hostname.toLowerCase() } catch {}
    if(node!=='api.trongrid.io') throw new Error('Network mismatch. Tron Transfer requires TRON Mainnet. Switch TronLink to Mainnet, then reconnect.')
    setUnlocked({address,tronWeb,provider})
    setNotice('TRON wallet connected to TRON Mainnet. Your private key stays in your wallet. Mainnet deployment is enabled; this connected wallet becomes the owner of contracts it deploys after separately approving each deployment in TronLink.')
  }
  useEffect(()=>{
    const provider=unlocked?.provider
    if(!provider||typeof provider.on!=='function') return undefined
    const invalidateWallet=()=>{
      setUnlocked(null)
      setTab('overview')
      setMoreOpen(false)
      setNotice('The TronLink account or network changed. Reconnect the wallet you intend to use; only the on-chain contract owner can administer existing contracts.')
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
    setMoreOpen(false)
    setNotice('TRON wallet disconnected from this application. Your wallet remains in your wallet application.')
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
  async function refreshManagedTreasuryReadiness() {
    if (!ownerSession?.sessionToken) return null
    setManagedTreasuryReadinessBusy(true)
    setManagedTreasuryReadinessError('')
    try {
      const result = await api('/api/treasury/withdrawals/readiness', {
        headers: { Authorization: 'Bearer ' + ownerSession.sessionToken },
      })
      setManagedTreasuryReadiness(result)
      return result
    } catch (e) {
      setManagedTreasuryReadiness(null)
      setManagedTreasuryReadinessError(e instanceof Error ? e.message : 'Managed treasury readiness could not be loaded.')
      return null
    } finally {
      setManagedTreasuryReadinessBusy(false)
    }
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
    setNotice('Private platform-owner session active. Your wallet can submit withdrawal requests with zero USDT. Each real payout still requires a separate owner-approved sponsor wallet with sufficient Mainnet USDT and network resources, plus that sponsor’s signature.')
  }
  async function signOutOwner() {
    const token = ownerSession?.sessionToken
    // Lock this browser immediately, even if the network is unavailable.
    try { sessionStorage.removeItem(OWNER_SESSION_KEY) } catch {}
    setOwnerSession(null)
    setUnlocked(null)
    setMonitorData(null)
    setTab('overview')
    setMoreOpen(false)
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
    {id:'provider',label:'Funding status',icon:ShieldCheck},
    {id:'1trax',label:'TRӾ Mainnet',icon:Coins},
    {id:'sponsors',label:'Sponsor approvals',icon:ShieldCheck},
    {id:'transactions',label:'Transactions',icon:History},
    {id:'settings',label:'Settings',icon:Settings},
  ]
  const mobilePrimaryNav = nav.filter(item => ['overview','assets','recipients','withdrawals'].includes(item.id))
  const mobileMoreNav = nav.filter(item => ['provider','1trax','sponsors','transactions','settings'].includes(item.id))
  const mobileMoreDescriptions = {
    provider: 'Sponsor funding and payout requirements',
    '1trax': 'TRӾ token setup · issuance not enabled',
    sponsors: 'Review sponsor wallets and approvals',
    transactions: 'Track submitted and confirmed payouts',
    settings: 'Network, owner and platform configuration',
  }

  return (
    <div className="app-shell trax-only-shell">
      <header className="topbar">
        <div>
          <span className="eyebrow">TRON TRANSFER · TRON MAINNET</span>
          <h1>TRӾ smart-contract manager</h1>
        </div>
        <div className="topbar-actions">
          <span className="network-chip"><i/> TRON Mainnet</span>
          <span className="muted small">Connect a wallet to deploy or administer your contracts</span>
          {unlocked&&<button className="outline-button" onClick={lockWallet}><LockKeyhole size={15}/> Lock wallet</button>}
        </div>
      </header>
      <main className="main-content">
        <div className="content">
          {notice&&<div className="notice notice-success" role="status"><CheckCircle2 size={17}/><span>{notice}</span><button onClick={()=>setNotice('')} aria-label="Dismiss notice"><X size={15}/></button></div>}
          {error&&<div className="notice notice-error" role="alert"><AlertTriangle size={17}/><span>{error}</span><button onClick={()=>setError('')} aria-label="Dismiss error"><X size={15}/></button></div>}
          <TRXMainnetPanel wallet={unlocked} onConnect={()=>perform(connectTronLink)} />
          <p className="fine-print trax-only-footer">TRON TRANSFER · WALLET-CONTROLLED WORKSPACE · TRON MAINNET · TRӾ SMART CONTRACT</p>
        </div>
      </main>
    </div>
  )
}
