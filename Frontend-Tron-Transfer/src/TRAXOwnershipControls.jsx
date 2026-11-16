import { useState } from 'react'
import { ArrowRightLeft, ShieldCheck } from 'lucide-react'
import { addressesEqual, callMainnetView, sendAndVerifyContractCall } from './trax-mainnet.mjs'

export default function TRAXOwnershipControls({
  wallet, connectedAddress, tokenAddress, feeCapSun, busy = false,
  getToken, assertOwner, run, refresh, setLastTx, setNotice,
}) {
  const [nextOwner, setNextOwner] = useState('')
  const [pendingOwner, setPendingOwner] = useState('')

  const readPendingOwner = () => run('Reading pending TRӾ ownership transfer', async () => {
    const { tronWeb, token } = await getToken()
    const pending = await callMainnetView(token.pendingOwner())
    setPendingOwner(String(pending || ''))
    return pending
  })

  const startTransfer = () => run('Starting two-step TRӾ ownership transfer · TronLink approval required', async () => {
    const { tronWeb, token } = await getToken()
    await assertOwner(token, tronWeb)
    const candidate = nextOwner.trim()
    if (!tronWeb.isAddress(candidate)) throw new Error('Enter a valid TRON Mainnet address for the new owner.')
    if (addressesEqual(tronWeb, candidate, connectedAddress)) throw new Error('The new owner must be a different address.')
    if (!feeCapSun) throw new Error('Enter a valid transaction fee cap.')
    const result = await sendAndVerifyContractCall(tronWeb, token, 'transferOwnership', [candidate], feeCapSun, connectedAddress)
    setLastTx(result.txID)
    setPendingOwner(candidate)
    setNotice('Ownership transfer has been proposed. The new owner must connect their own TronLink wallet and separately accept it on-chain.')
    await refresh()
  })

  const acceptTransfer = () => run('Accepting TRӾ ownership · pending owner TronLink approval required', async () => {
    const { tronWeb, token } = await getToken()
    const pending = String(await callMainnetView(token.pendingOwner()) || '')
    if (!pending || !addressesEqual(tronWeb, pending, connectedAddress)) {
      throw new Error('The connected wallet is not the contract’s pending owner. Connect the exact pending-owner address.')
    }
    if (!feeCapSun) throw new Error('Enter a valid transaction fee cap.')
    const result = await sendAndVerifyContractCall(tronWeb, token, 'acceptOwnership', [], feeCapSun, connectedAddress)
    setLastTx(result.txID)
    setPendingOwner('')
    setNotice('Ownership acceptance was confirmed. Refreshing the contract under the new owner.')
    await refresh()
  })

  const isPendingOwner = (() => {
    try { return Boolean(pendingOwner && wallet?.tronWeb && addressesEqual(wallet.tronWeb, pendingOwner, connectedAddress)) }
    catch { return false }
  })()

  return <div className="trax-actions">
    <h3>Two-step ownership transfer</h3>
    <p className="fine-print">The current owner proposes a new address. Only that exact address can accept ownership in a separate Mainnet transaction. Never enter an address unless its owner controls the corresponding wallet.</p>
    <label>New owner TRON Mainnet address<input value={nextOwner} onChange={event => setNextOwner(event.target.value)} autoComplete="off" spellCheck="false" placeholder="T..."/></label>
    <div className="button-row">
      <button type="button" className="outline-button" disabled={!tokenAddress || !wallet?.tronWeb || !feeCapSun || busy} onClick={startTransfer}><ArrowRightLeft size={15}/> Propose ownership transfer</button>
      <button type="button" className="outline-button" disabled={!tokenAddress || !wallet?.tronWeb || busy} onClick={readPendingOwner}>Read pending owner</button>
    </div>
    {pendingOwner && <div className="trax-balance-note"><b>Pending owner:</b> {pendingOwner}</div>}
    <button type="button" className="primary-button" disabled={!tokenAddress || !wallet?.tronWeb || !isPendingOwner || !feeCapSun || busy} onClick={acceptTransfer}><ShieldCheck size={15}/> Accept ownership from this wallet</button>
    <p className="fine-print">If the new owner is a different wallet, reconnect TronLink to that address before accepting. This dashboard's configured-owner restriction remains in force for issuance and emergency controls; acceptance is available only to the exact on-chain pending owner.</p>
  </div>
}
