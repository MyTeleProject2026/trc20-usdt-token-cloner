import { useState } from 'react'
import { History, RefreshCw, ExternalLink, ChevronDown } from 'lucide-react'
import { formatTokenUnits } from './trax-mainnet.mjs'

function field(result, ...names) {
  for (const name of names) {
    if (result?.[name] !== undefined && result?.[name] !== null) return result[name]
  }
  return ''
}

function normalizeReference(value) {
  const raw = String(value || '')
  if (/^0x[0-9a-f]{64}$/i.test(raw)) return raw.slice(2)
  return raw || 'Unavailable'
}

function mapEvent(event) {
  const result = event.result || {}
  const amount = field(result, 'amount', '_amount')
  let displayAmount = 'Unavailable'
  try { displayAmount = formatTokenUnits(String(amount)) } catch {}
  return {
    recipient: String(field(result, 'recipient', '_recipient') || 'Unavailable'),
    amount: displayAmount,
    referenceId: normalizeReference(field(result, 'referenceId', 'reference_id', '_referenceId')),
    txID: String(event.transaction_id || event.transactionId || ''),
    block: String(event.block_number ?? 'Unavailable'),
    timestamp: Number(event.block_timestamp || 0),
    eventIndex: String(event.event_index ?? ''),
  }
}

export default function TRAXCreditHistory({ wallet, tokenAddress, run, busy = false }) {
  const [events, setEvents] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [fingerprint, setFingerprint] = useState('')
  const [hasMore, setHasMore] = useState(false)

  const fetchPage = (append) => run(append ? 'Loading the next confirmed TRӾ credit-history page' : 'Loading confirmed TRӾ owner-credit history from TRON Mainnet', async () => {
    const tronWeb = wallet?.tronWeb
    if (!tronWeb || !tronWeb.event?.getEventsByContractAddress) {
      throw new Error('This TronWeb provider does not expose the TRON Mainnet contract-event API.')
    }
    if (!tronWeb.isAddress(tokenAddress)) throw new Error('Enter and verify the TRӾ Mainnet contract address first.')
    const options = {
      eventName: 'OwnerCredit',
      onlyConfirmed: true,
      limit: 50,
      orderBy: 'block_timestamp,desc',
    }
    if (append && fingerprint) options.fingerprint = fingerprint
    const response = await tronWeb.event.getEventsByContractAddress(tokenAddress, options)
    if (!response || !Array.isArray(response.data)) {
      throw new Error('TRON Mainnet event service returned an unexpected response. No history was assumed.')
    }
    const rows = response.data.map(mapEvent)
    setEvents(previous => {
      const combined = append ? [...previous, ...rows] : rows
      const seen = new Set()
      return combined.filter(event => {
        const key = event.txID + ':' + event.eventIndex
        if (!event.txID || seen.has(key)) return false
        seen.add(key)
        return true
      })
    })
    const nextFingerprint = String(response.meta?.fingerprint || '')
    setFingerprint(nextFingerprint)
    setHasMore(Boolean(nextFingerprint))
    setLoaded(true)
    return rows.length
  })

  return <section className="trax-actions">
    <div className="button-row" style={{justifyContent:'space-between',alignItems:'center'}}>
      <h3><History size={16}/> Confirmed issuance history</h3>
      <button type="button" className="outline-button" disabled={!tokenAddress || !wallet?.tronWeb || busy} onClick={() => { setFingerprint(''); setHasMore(false); fetchPage(false) }}><RefreshCw size={14}/> Refresh history</button>
    </div>
    <p className="fine-print">Read-only history of confirmed OwnerCredit events indexed by TronGrid. This records on-chain token credits, not exchange customer-ledger deposits. Pages contain up to 50 events; use Load more to follow the API pagination cursor.</p>
    {!loaded ? <p className="fine-print">Refresh to load confirmed Mainnet credits.</p> : events.length === 0
      ? <p className="fine-print">No confirmed OwnerCredit events were returned for this contract.</p>
      : <div className="trax-history-list">{events.map((event, index) => <article className="trax-history-item" key={event.txID + ':' + event.eventIndex + ':' + index}>
        <div><b>{event.amount} TRӾ</b><small>Recipient: {event.recipient}</small><small>Reference: {event.referenceId}</small><small>Block: {event.block}{event.timestamp ? ' · ' + new Date(event.timestamp).toLocaleString() : ''}</small></div>
        {event.txID ? <a href={'https://tronscan.org/#/transaction/' + encodeURIComponent(event.txID)} target="_blank" rel="noreferrer">Transaction <ExternalLink size={12}/></a> : <span>Transaction unavailable</span>}
      </article>)}</div>}
    {loaded && hasMore ? <button type="button" className="outline-button" onClick={() => fetchPage(true)}><ChevronDown size={14}/> Load more history</button> : null}
  </section>
}
