import { useState } from 'react'
import { AlertTriangle, LockKeyhole, RefreshCw, Wallet } from 'lucide-react'
import { discoverTronLinkProvider, requestTronLinkConnection } from './tronlink-provider.mjs'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'https://trc20-usdt-token-cloner-api.onrender.com').replace(/\\/+$/, '')
const SESSION_PREFIX = 'tron-transfer:restricted-credit:'
function formatTrx(sun) {
  try {
    const n=BigInt(String(sun||'0')), whole=n/1000000n, fraction=(n%1000000n).toString().padStart(6,'0').replace(/0+$/,'')
    return whole.toString()+(fraction?'.'+fraction:'')
  } catch { return 'Unavailable' }
}
async function api(path, token, options={}) {
  const response=await fetch(API_BASE+path,{...options,headers:{Accept:'application/json',...(options.body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{}),...(options.headers||{})},credentials:'omit',cache:'no-store',redirect:'error'})
  const body=await response.json().catch(()=>null)
  if(!response.ok||!body||body.success===false) throw new Error(body?.message||body?.error||'Request failed.')
  return body
}
export default function CustomerRestrictedCredits() {
  const [wallet,setWallet]=useState(null)
  const [session,setSession]=useState(null)
  const [account,setAccount]=useState(null)
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const [notice,setNotice]=useState('')
  async function connect() {
    setBusy(true);setError('');setNotice('')
    try {
      const provider=await discoverTronLinkProvider(window)
      if(!provider) throw new Error('Open this page in TronLink DApp browser and connect a Mainnet wallet.')
      const {address,tronWeb}=await requestTronLinkConnection(provider,window)
      if(!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)||!tronWeb?.isAddress?.(address)) throw new Error('TronLink returned an invalid TRON address.')
      if(new URL(String(tronWeb.fullNode?.host||'')).hostname.toLowerCase()!=='api.trongrid.io') throw new Error('Switch TronLink to TRON Mainnet.')
      setWallet({address,tronWeb,provider})
      setSession(null);setAccount(null)
      setNotice('Wallet connected. Verify ownership to view the restricted-credit ledger for this address.')
    } catch(e) {setError(e.message)} finally {setBusy(false)}
  }
  async function verify() {
    setBusy(true);setError('');setNotice('')
    try {
      if(!wallet?.tronWeb?.trx?.signMessageV2) throw new Error('Wallet message signing is unavailable.')
      const challenge=await api('/api/auth/tron/challenge',null,{method:'POST',body:JSON.stringify({address:wallet.address,network:'mainnet'})})
      const signature=await wallet.tronWeb.trx.signMessageV2(challenge.message)
      const verified=await api('/api/auth/tron/verify',null,{method:'POST',body:JSON.stringify({address:wallet.address,network:'mainnet',nonce:challenge.nonce,signature})})
      if(verified.authenticated!==true||verified.address!==wallet.address||typeof verified.sessionToken!=='string') throw new Error('Wallet identity verification failed.')
      const next={address:verified.address,sessionToken:verified.sessionToken,expiresAt:verified.expiresAt}
      setSession(next)
      try {sessionStorage.setItem(SESSION_PREFIX+wallet.address,verified.sessionToken)} catch {}
      await refresh(next.sessionToken)
      setNotice('Identity verified. Your displayed amount is an internal restricted credit, not native TRX.')
    } catch(e) {setError(e.message)} finally {setBusy(false)}
  }
  async function refresh(token=session?.sessionToken) {
    if(!token) throw new Error('Verify your wallet first.')
    setBusy(true);setError('')
    try {const result=await api('/api/ripple-custody/credits/me',token);setAccount(result.account);return result.account}
    catch(e) {setError(e.message);throw e} finally {setBusy(false)}
  }
  function signOut() {
    if(wallet?.address) {try {sessionStorage.removeItem(SESSION_PREFIX+wallet.address)} catch {}}
    setSession(null);setAccount(null);setWallet(null);setNotice('Wallet disconnected.')
  }
  return <div className="app-shell sponsor-portal-shell"><main className="main-content">
    <header className="topbar"><div><span className="eyebrow">TRON TRANSFER · CUSTOMER VIEW</span><h1>Restricted credit balance</h1></div><div className="topbar-actions"><a className="outline-button" href="/">Owner workspace</a></div></header>
    <div className="content"><section className="panel provider-panel">
      <div className="section-heading"><div><span className="eyebrow">TRON MAINNET · WALLET OWNERSHIP CHECK</span><h2>View your internal credit account</h2><p>Connect and sign an identity message. The signature does not transfer assets or authorize a withdrawal.</p></div><div className="panel-icon"><LockKeyhole/></div></div>
      {error&&<div className="notice notice-error" role="alert"><AlertTriangle size={16}/><span>{error}</span></div>}
      {notice&&<div className="notice notice-success" role="status">{notice}</div>}
      {!wallet?<button className="primary-button" disabled={busy} onClick={()=>void connect()}><Wallet size={16}/>{busy?'Connecting…':'Connect TronLink'}</button>:<div className="form-stack"><div className="address-box"><span>Connected Mainnet address</span><b>{wallet.address}</b></div><div className="button-row">{!session?<button className="primary-button" disabled={busy} onClick={()=>void verify()}><LockKeyhole size={16}/>{busy?'Verifying…':'Verify wallet ownership'}</button>:<button className="secondary-button" disabled={busy} onClick={()=>void refresh()}><RefreshCw size={15}/> Refresh balance</button>}<button className="outline-button" onClick={signOut}>Disconnect</button></div></div>}
      {account&&<div className="recipient-balance-grid"><article className="metric-card"><span>Restricted credit balance</span><strong>{formatTrx(account.balanceSun)} <small>TRX-credit</small></strong></article><article className="metric-card"><span>Account status</span><strong>{account.status}</strong></article><article className="metric-card"><span>Ledger entries</span><strong>{account.entryCount}</strong></article><article className="metric-card"><span>On-chain withdrawal</span><strong>Not supported</strong></article></div>}
      <div className="notice notice-warning"><AlertTriangle size={17}/><div><b>This is not your Bitpie or blockchain balance</b><p>Restricted credits are internal Tron Transfer bookkeeping entries. They are not actual TRX, cannot be spent or withdrawn on-chain, and do not appear in Bitpie. Only an actual confirmed TRON transfer to a Bitpie-controlled address can appear as a blockchain asset in Bitpie.</p></div></div>
    </section></div><footer className="app-footer">TRON TRANSFER · CUSTOMER RESTRICTED CREDIT VIEW · INTERNAL LEDGER ONLY</footer>
  </main></div>
}
