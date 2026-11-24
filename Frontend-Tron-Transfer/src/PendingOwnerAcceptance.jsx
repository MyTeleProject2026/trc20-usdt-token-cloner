import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, KeyRound, RefreshCw, ShieldCheck, Wallet } from 'lucide-react'
import { createPendingOwnerAcceptanceClient } from './pending-owner-acceptance-client.mjs'
import { createOwnerTronWeb, deriveOwnerAccount } from './owner-wallet-vault.mjs'
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
  const pendingKeyInput=useRef(null)
  const pendingSigner=useRef(null)
  async function refreshState(){const result=await client.state();setChain(result);return result}
  useEffect(()=>{let active=true;Promise.all([client.state(),client.session().catch(()=>null)]).then(([s,a])=>{if(active){setChain(s);if(a?.authenticated)setSession(a)}}).catch(e=>{if(active)setError(String(e.message||e))});return()=>{active=false;pendingSigner.current=null;if(pendingKeyInput.current)pendingKeyInput.current.value=''}},[])
  async function connectPendingOwner(){
    setBusy(true);setError('');setNotice('')
    try{
      const current=await refreshState()
      const account=await deriveOwnerAccount({mode:'private-key',value:pendingKeyInput.current?.value||''})
      if(account.address!==current.pendingOwner)throw new Error('The imported wallet does not match the exact on-chain Pending Owner address.')
      if(account.address===current.owner)throw new Error('The proposed Pending Owner must be different from the current Owner.')
      const signer=createOwnerTronWeb(account.privateKey)
      const challenge=await client.challenge(account.address)
      const signature=await signer.trx.signMessageV2(challenge.message)
      await client.verify(account.address,challenge.nonce,signature)
      const authenticated=await client.session()
      pendingSigner.current=signer
      setSession(authenticated)
      setNotice('Pending-owner wallet verified locally. The private key remains in browser memory only and is never sent to the Resource API.')
      if(pendingKeyInput.current)pendingKeyInput.current.value=''
    }catch(e){pendingSigner.current=null;setError(String(e.message||e))}finally{setBusy(false)}
  }
  async function acceptOwnership(){
    setBusy(true);setError('');setNotice('')
    try{
      if(typed!==CONFIRM_PHRASE)throw new Error('Type the exact confirmation phrase before approving the ownership acceptance.')
      const signer=pendingSigner.current
      if(!signer||!session?.address)throw new Error('Import and verify the proposed pending-owner wallet again before signing.')
      const current=await refreshState()
      if(current.pendingOwner!==session.address)throw new Error('The on-chain Pending Owner proposal changed. Verify the newly proposed wallet before continuing.')
      const prepared=await client.prepare({idempotencyKey:window.crypto.randomUUID(),confirmationPhrase:PREPARE_PHRASE})
      const signed=await signer.trx.sign(prepared.unsignedTransaction)
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
  async function logout(){setBusy(true);try{await client.logout()}catch{}finally{pendingSigner.current=null;if(pendingKeyInput.current)pendingKeyInput.current.value='';setSession(null);setOperation(null);setBusy(false)}}
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
      <div className="pending-owner-card-title"><Wallet/><div><h3>Verify the proposed wallet</h3><p>Import only the existing wallet whose address is shown as Pending Owner above.</p></div></div>
      {session?<><p className="pending-owner-success"><CheckCircle2 size={16}/> Authenticated: {session.address}</p><p className="pending-owner-muted">Session expires automatically and can only authorize this exact contract's acceptance. The local signer is held in memory only.</p><button type="button" className="pending-owner-secondary" onClick={logout} disabled={busy}>End pending-owner session and clear signer</button></>:<><label>Proposed Pending Owner private key<input ref={pendingKeyInput} type="password" autoComplete="off" spellCheck="false" placeholder="Enter the existing wallet private key" /></label><button type="button" className="pending-owner-primary" onClick={connectPendingOwner} disabled={busy||!pending}><KeyRound size={16}/> Import locally and verify wallet</button><p className="pending-owner-muted">The key is used only in this browser session to sign the verification message and acceptance transaction. It is not uploaded, saved to local storage, or sent to an external wallet provider.</p></>}
    </article>
    {session&&<article className="pending-owner-card">
      <div className="pending-owner-card-title"><CheckCircle2/><div><h3>Accept ownership</h3><p>Review the exact action, then sign locally with the verified pending-owner wallet.</p></div></div>
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
