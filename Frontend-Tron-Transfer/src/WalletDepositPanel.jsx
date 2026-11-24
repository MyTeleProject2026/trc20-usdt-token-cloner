import { useState } from 'react'
import { ArrowDownLeft, Check, Copy, ExternalLink, RefreshCw } from 'lucide-react'
import { getIncomingNativeTrxTransfers, getIncomingUsdtTransfers, formatDepositAmount } from './wallet-deposits.mjs'

export default function WalletDepositPanel({
  role, address, addressHex, transactions = [], tokenTransfers = [],
  transactionsAvailable = false, tokenTransfersAvailable = false,
  onRefresh, refreshing = false,
}) {
  const [copied, setCopied] = useState(false)
  const incomingTrx = getIncomingNativeTrxTransfers(transactions, address, addressHex)
  const incomingUsdt = getIncomingUsdtTransfers(tokenTransfers, address)
  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
    }
  }

  return <section className="wallet-deposit-panel" aria-label={role + ' wallet deposits'}>
    <div className="wallet-deposit-heading">
      <div><span>RECEIVE · TRON MAINNET</span><h3>{role} wallet deposits</h3><p>Send funds directly to this wallet address. No intermediary or new deposit account is created.</p></div>
      <ArrowDownLeft size={20} aria-hidden="true"/>
    </div>
    <label className="wallet-deposit-address-label">Your {role} deposit address
      <div className="wallet-deposit-address"><code>{address}</code><button type="button" onClick={copyAddress} aria-label="Copy deposit address">{copied ? <Check size={16}/> : <Copy size={16}/>}<span>{copied ? 'Copied' : 'Copy'}</span></button></div>
    </label>
    <div className="wallet-deposit-actions">
      <a href={'https://tronscan.org/#/address/' + encodeURIComponent(address)} target="_blank" rel="noreferrer">View address on TRONSCAN <ExternalLink size={13}/></a>
      <button type="button" onClick={onRefresh} disabled={refreshing || !onRefresh}><RefreshCw size={14}/>{refreshing ? 'Refreshing…' : 'Refresh deposits'}</button>
    </div>
    <p className="wallet-deposit-warning">Supported here: native TRX and official USDT (TRC20) on TRON Mainnet. Do not send assets over another network. TRӾ is a separate custom token and is not included in this deposit activity feed.</p>
    <div className="wallet-deposit-history">
      <div className="wallet-deposit-history-title"><b>Incoming confirmed deposits</b><span>Latest indexed records</span></div>
      {!transactionsAvailable && !tokenTransfersAvailable
        ? <p className="wallet-deposit-empty">Deposit history is temporarily unavailable. Your wallet address remains available for receiving funds.</p>
        : <>
          {incomingTrx.slice(0, 5).map(item => <div className="wallet-deposit-row" key={'trx-' + item.txid}><span><b>Received {formatDepositAmount(item.amountSun)} TRX</b><small>{item.timestamp ? new Date(item.timestamp).toLocaleString() : 'Confirmed on-chain'}</small></span><a href={'https://tronscan.org/#/transaction/' + item.txid} target="_blank" rel="noreferrer">View transaction</a></div>)}
          {incomingUsdt.slice(0, 5).map(item => <div className="wallet-deposit-row" key={'usdt-' + item.txid}><span><b>Received {formatDepositAmount(item.value)} USDT</b><small>{item.timestamp ? new Date(item.timestamp).toLocaleString() : 'Confirmed on-chain'} · TRC20</small></span><a href={'https://tronscan.org/#/transaction/' + item.txid} target="_blank" rel="noreferrer">View transaction</a></div>)}
          {incomingTrx.length === 0 && incomingUsdt.length === 0 && <p className="wallet-deposit-empty">No incoming TRX or official USDT deposits were found in the latest confirmed history records.</p>}
        </>}
      <p className="wallet-deposit-footnote">History is confirmed-only and limited to the latest indexed records. For a complete account history, open the address on TRONSCAN.</p>
    </div>
  </section>
}
