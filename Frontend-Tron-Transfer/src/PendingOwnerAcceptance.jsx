import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, KeyRound, RefreshCw, ShieldCheck, Wallet } from 'lucide-react'
import { createPendingOwnerAcceptanceClient } from './pending-owner-acceptance-client.mjs'
import './pending-owner-acceptance.css'

const CONFIRM_PHRASE='CONFIRM TRӾ OWNERSHIP ACCEPTANCE'
const PREPARE_PHRASE='PREPARE TRӾ OWNERSHIP ACCEPTANCE'
const client=createPendingOwnerAcceptanceClient()

export default function PendingOwnerAcceptance() {
  const [chain,setChain]=useState(null)
  const [session,setSession]=useState(null)
  const [operation,setOperation]=useState(null)
  const [typed,setTyped]=useState('')
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const [notice,setNotice]=useState('')
  const tronWeb=useMemo(()=>typeof window!=='undefined'?window.tronWeb:null,[])
  async function refreshState(){const result=await client.state();setChain(result);return result}
  useEffect(()=>{let active=true;Promise.all([client.state(),client.session().catch(()=>null)]).then(([s,a])=>{if(active){setChain(s);if(a?.authenticated)setSession(a)}}).catch(e=>{if(active)setError(String(e.message||e))});return()=>{active=false}},[])
  async function connectPendingOwner(){
    setBusy(true);setError('');setNotice('')
    try{
      if(!window.tronWeb?.defaultAddress?.base58&&window.tronLink?.request)await window.tronLink.request({method:'tron_requestAccounts'})
      const injected=window.tronWeb
      const address=String(injected?.defaultAddress?.base58||'')
      if(!address||typeof injected?.trx?.signMessageV2!=='function')throw new Error('Open this page in the TronLink DApp browser and connect the proposed pending-owner account.')
      const current=await refreshState()
      if(address!==current.pendingOwner)throw new Error('The connected TronLink address is not the contract pendingOwner address.')
      const challenge=await client.challenge(address)
      const signature=await injected.trx.signMessageV2(challenge.message)
      await client.verify(address,challenge.nonce,signature)
      const authenticated=await client.session()
      setSession(authenticated)
      setNotice('Pending-owner address verified. This session is separate from the current Owner account.')
    }catch(e){setError(String(e.message||e))}finally{setBusy(false)}
  }
  async function acceptOwnership(){
    setBusy(true);setError('');setNotice('')
    try{
      if(typed!==CONFIRM_PHRASE)throw new Error('Type the exact confirmation phrase before approving the ownership acceptance.')
      const injected=window.tronWeb
      if(String(injected?.defaultAddress?.base58||'')!==session?.address)throw new Error('Reconnect the exact pending-owner address in TronLink before signing.')
      const prepared=await client.prepare({idempotencyKey:window.crypto.randomUUID(),confirmationPhrase:PREPARE_PHRASE})
      const signed=await injected.trx.sign(prepared.unsignedTransaction)
      const result=await client.confirm({operationId:prepared.operation.operation_id,intentSha256:prepared.intentSha256,signedTransaction:signed,confirmationPhrase:CONFIRM_PHRASE})
      const op=result.operation||prepared.operation
      setOperation(op)
      setNotice('The signed acceptance was submitted through the backend. Wait for solidified Mainnet confirmation; do not create a second acceptance transaction.')
      setTyped('')
    }catch(e){setError(String(e.message||e))}finally{setBusy(false)}
  }
  async function checkStatus(){
    if(!operation?.operation_id&&!operation?.operationId)return
    setBusy(true);setError('')
    try{const result=await client.status(operation.operation_id||operation.operationId);setOperation(result.operation);setNotice(result.recovery?.solidified?'Ownership acceptance is solidified and the on-chain Owner now matches this wallet.':result.message||'The original transaction is still being reconciled.')}catch(e){setError(String(e.message||e))}finally{setBusy(false)}
  }
  async function logout(){setBusy(true);try{await client.logout()}catch{}finally{setSession(null);setOperation(null);setBusy(false)}}
  const pending=Boolean(chain?.pendingOwnerAvailable)
  return <section className="pending-owner-page">
    <header><span className="pending-owner-kicker">TRON MAINNET · TWO-STEP OWNERSHIP</span><h2>Accept TRӾ ownership</h2><p>This is a separate pending-owner workflow. It never uses the current Owner password session or Owner private key.</p></header>
    {error&&<div className="pending-owner-alert error" role="alert">{error}</div>}
    {notice&&<div className="pending-owner-alert" role="status">{notice}</div>}
    <article className="pending-owner-card">
      <div className="pending-owner-card-title"><ShieldCheck/><div><h3>On-chain proposal</h3><p>Live contract state from TRON Mainnet</p></div><button type="button" onClick={()=>refreshState().catch(e=>setError(String(e.message||e)))} disabled={busy}><RefreshCw size={15}/> Refresh</button></div>
      <dl><dt>TRӾ contract</dt><dd>{chain?.contractAddress||'Not configured'}</dd><dt>Current Owner</dt><dd>{chain?.owner||'Unavailable'}</dd><dt>Pending Owner</dt><dd>{chain?.pendingOwner||'Unavailable'}</dd></dl>
      {!pending&&<p className="pending-owner-muted">There is no valid pending-owner proposal to accept. The current Owner must first submit a two-step ownership proposal.</p>}
    </article>
    <article className="pending-owner-card">
      <div className="pending-owner-card-title"><Wallet/><div><h3>Verify the proposed wallet</h3><p>Connect only the address shown as Pending Owner above.</p></div></div>
      {session?<><p className="pending-owner-success"><CheckCircle2 size={16}/> Authenticated: {session.address}</p><p className="pending-owner-muted">Session expires automatically and can only authorize this exact contract's acceptance.</p><button type="button" className="pending-owner-secondary" onClick={logout} disabled={busy}>End pending-owner session</button></>:<button type="button" className="pending-owner-primary" onClick={connectPendingOwner} disabled={busy||!pending}><KeyRound size={16}/> Connect and verify with TronLink</button>}
    </article>
    {session&&<article className="pending-owner-card">
      <div className="pending-owner-card-title"><CheckCircle2/><div><h3>Accept ownership</h3><p>Review the exact action, then approve one TronLink signature prompt.</p></div></div>
      <label>Type to confirm<input value={typed} onChange={e=>setTyped(e.target.value)} autoComplete="off" spellCheck="false" placeholder={CONFIRM_PHRASE}/></label>
      <button type="button" className="pending-owner-primary" onClick={acceptOwnership} disabled={busy||typed!==CONFIRM_PHRASE||!pending}>Prepare and approve acceptance</button>
      <p className="pending-owner-muted">The backend checks Energy, Bandwidth, fee cap, signer and permission. It persists the signed transaction before broadcast and never automatically rebroadcasts an ambiguous result.</p>
    </article>}
    {operation&&<article className="pending-owner-card">
      <div className="pending-owner-card-title"><RefreshCw/><div><h3>Acceptance transaction</h3><p>Only the original transaction ID is reconciled.</p></div></div>
      <dl><dt>State</dt><dd>{operation.state}</dd><dt>Transaction ID</dt><dd>{operation.transaction_id||operation.transactionId||'Pending'}</dd></dl>
      <button type="button" className="pending-owner-secondary" onClick={checkStatus} disabled={busy}>Check solidified Mainnet status</button>
    </article>}
  </section>
}
