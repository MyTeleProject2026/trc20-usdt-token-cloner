import { useState } from 'react'
import { History, RefreshCw, ExternalLink } from 'lucide-react'
import { formatTokenUnits } from './trax-mainnet.mjs'

function field(result, ...names) {
  for (const name of names) {
    if (result?.[name] !== undefined && result?.[name] !== null) return result[name]
  }
  return ''
}

export default function TRAXCreditHistory({ wallet, tokenAddress, run }) {
  const [events, setEvents] = useState([])
  const [loaded, setLoaded] = useState(false)

  const load = () => run('Loading confirmed TRӾ owner-credit history from TRON Mainnet', async () => {
    const tronWeb = wallet?.tronWeb
    if (!tronWeb || !tronWeb.event?.getEventsByContractAddress) {
      throw new Error('This TronWeb provider does not expose the TRON Mainnet contract-event API.')
    }
    if (!tronWeb.isAddress(tokenAddress)) throw new Error('Enter and verify the TRӾ Mainnet contract address first.')
    const response = await tronWeb.event.getEventsByContractAddress(tokenAddress, {
      eventName: 'OwnerCredit',
      onlyConfirmed: true,
      limit: 50,
      orderBy: 'block_timestamp,desc',
    })
    if (!response || !Array.isArray(response.data)) {
      throw new Error('TRON Mainnet event service returned an unexpected response. No history was assumed.')
    }
    const rows = response.data.map((event) => {
      const result = event.result || {}
      const amount = field(result, 'amount', '_amount')
      let displayAmount = 'Unavailable'
      try { displayAmount = formatTokenUnits(String(amount)) } catch {}
      return {
        recipient: String(field(result, 'recipient', '_recipient') || 'Unavailable'),
        amount: displayAmount,
        referenceId: String(field(result, 'referenceId', 'reference_id', '_referenceId') || 'Unavailable'),
        txID: String(event.transaction_id || event.transactionId || ''),
        block: String(event.block_number ?? 'Unavailable'),
        timestamp: Number(event.block_timestamp || 0),
        eventIndex: String(event.event_index ?? ''),
      }
    })
    setEvents(rows)
    setLoaded(true)
    return rows.length
  })

  return <section className="trax-actions">
    <div className="button-row" style={{justifyContent:'space-between',alignItems:'center'}}>
      <h3><History size={16}/> Confirmed issuance history</h3>
      <button type="button" className="outline-button" disabled={!tokenAddress || !wallet?.tronWeb} onClick={load}><RefreshCw size={14}/> Refresh history</button>
    </div>
    <p className="fine-print">Read-only history of confirmed OwnerCredit events indexed by TronGrid. This records on-chain token credits, not exchange customer-ledger deposits. The endpoint returns the latest 50 events; older records require pagination.</p>
    {!loaded ? <p className="fine-print">Refresh to load confirmed Mainnet credits.</p> : events.length === 0
      ? <p className="fine-print">No confirmed OwnerCredit events were returned for this contract.</p>
      : <div className="trax-history-list">{events.map((event, index) => <article className="trax-history-item" key={event.txID + ':' + event.eventIndex + ':' + index}>
        <div><b>{event.amount} TRӾ</b><small>Recipient: {event.recipient}</small><small>Reference: {event.referenceId}</small><small>Block: {event.block}{event.timestamp ? ' · ' + new Date(event.timestamp).toLocaleString() : ''}</small></div>
        {event.txID ? <a href={'https://tronscan.org/#/transaction/' + encodeURIComponent(event.txID)} target="_blank" rel="noreferrer">Transaction <ExternalLink size={12}/></a> : <span>Transaction unavailable</span>}
      </article>)}</div>}
  </section>
}
