import { useState } from 'react'
import { ArrowRightLeft, RefreshCw } from 'lucide-react'
import { callMainnetView } from './trax-mainnet.mjs'
import PendingOwnerAcceptance from './PendingOwnerAcceptance.jsx'

export default function TRAXOwnershipControls({
  wallet, tokenAddress, feeCapSun, busy = false,
  getToken, run, onPrepareOperation,
}) {
  const [nextOwner, setNextOwner] = useState('')
  const [pendingOwner, setPendingOwner] = useState('')

  const readPendingOwner = () => run('Reading pending TRӾ ownership transfer', async () => {
    const { token } = await getToken()
    const pending = await callMainnetView(token.pendingOwner())
    setPendingOwner(String(pending || ''))
    return pending
  })

  const startTransfer = () => {
    const candidate = nextOwner.trim()
    if (!candidate) return
    return onPrepareOperation({
      operationType: 'ownership-transfer',
      nextOwner: candidate,
      summary: 'Propose two-step TRӾ ownership transfer to ' + candidate,
    })
  }

  return <div className="trax-actions">
    <h3>Two-step ownership transfer</h3>
    <p className="fine-print">The current on-chain owner proposes a new address. The proposal is prepared through the authenticated Owner API and requires the same explicit operation review, fresh Mainnet preflight and backend confirmation as other writes.</p>
    <label>New owner TRON Mainnet address<input value={nextOwner} onChange={event => setNextOwner(event.target.value)} autoComplete="off" spellCheck="false" placeholder="T..."/></label>
    <div className="button-row">
      <button type="button" className="outline-button" disabled={!tokenAddress || !wallet?.managedSession || !feeCapSun || busy || !nextOwner.trim()} onClick={startTransfer}><ArrowRightLeft size={15}/> Review ownership proposal</button>
      <button type="button" className="outline-button" disabled={!tokenAddress || !wallet?.managedSession || busy} onClick={readPendingOwner}><RefreshCw size={15}/> Read pending owner</button>
    </div>
    {pendingOwner && <div className="trax-balance-note"><b>On-chain pending owner:</b> {pendingOwner}</div>}
    <p className="fine-print">The new owner must accept from the exact pending-owner address. The configured Owner signer cannot impersonate or accept for that different wallet. Use the acceptance panel below; it verifies the pending-owner address with a one-time TronLink message signature and never reuses this Owner session.</p>
    <details className="pending-owner-inline"><summary>Accept a pending ownership proposal</summary><PendingOwnerAcceptance/></details>
  </div>
}
