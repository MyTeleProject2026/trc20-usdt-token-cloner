import { useMemo, useState } from 'react'
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, RotateCcw, ShieldCheck } from 'lucide-react'

type DemoTransfer = {
  id: string
  from: string
  to: string
  amount: string
  asset: string
  createdAt: string
}

const demoSender = '0xDEMO_SENDER_00000000000000000000000000000001'
const demoReceiver = '0xDEMO_RECEIVER_00000000000000000000000000000002'

export default function TransferSimulator() {
  const [sender, setSender] = useState(demoSender)
  const [receiver, setReceiver] = useState(demoReceiver)
  const [amount, setAmount] = useState('65')
  const [asset, setAsset] = useState('ETH')
  const [alias, setAlias] = useState('receiver-vanity-demo')
  const [records, setRecords] = useState<DemoTransfer[]>([])
  const [error, setError] = useState('')

  const senderBalance = useMemo(() => {
    const sent = records.filter((r) => r.from === sender && r.asset === asset).reduce((sum, r) => sum + Number(r.amount), 0)
    const received = records.filter((r) => r.to === sender && r.asset === asset).reduce((sum, r) => sum + Number(r.amount), 0)
    return Math.max(0, 1000 - sent + received)
  }, [records, sender, asset])

  const receiverBalance = useMemo(() => {
    const received = records.filter((r) => r.to === receiver && r.asset === asset).reduce((sum, r) => sum + Number(r.amount), 0)
    const sent = records.filter((r) => r.from === receiver && r.asset === asset).reduce((sum, r) => sum + Number(r.amount), 0)
    return Math.max(0, received - sent)
  }, [records, receiver, asset])

  const simulate = () => {
    setError('')
    const value = Number(amount)
    if (!sender.trim() || !receiver.trim()) return setError('Enter demo sender and receiver labels.')
    if (sender.trim() === receiver.trim()) return setError('Sender and receiver labels must be different.')
    if (!Number.isFinite(value) || value <= 0 || value > 1000) return setError('Amount must be greater than 0 and no more than 1,000 demo units.')
    const alreadySent = records.filter((r) => r.from === sender.trim() && r.asset === asset).reduce((sum, r) => sum + Number(r.amount), 0)
    const alreadyReceived = records.filter((r) => r.to === sender.trim() && r.asset === asset).reduce((sum, r) => sum + Number(r.amount), 0)
    if (1000 - alreadySent + alreadyReceived < value) return setError('Insufficient demo balance. Reset the demo ledger or use a smaller amount.')
    setRecords((current) => [{
      id: `SIM-${Date.now().toString(16).toUpperCase()}-${Math.random().toString(16).slice(2, 8).toUpperCase()}`,
      from: sender.trim(),
      to: receiver.trim(),
      amount: String(value),
      asset,
      createdAt: new Date().toLocaleString(),
    }, ...current])
  }

  return (
    <div className="space-y-xl">
      <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-lg">
        <div className="flex items-start gap-md">
          <span className="rounded-xl bg-utility-warning-50 p-md"><AlertTriangle className="size-5 text-utility-warning-600" /></span>
          <div>
            <h2 className="text-heading-xs font-semibold text-primary">Demo Token Transfer Simulator</h2>
            <p className="mt-xs text-sm text-tertiary">Local-only demonstration. These are fictional balances and records, not blockchain transfers. No wallet is accessed and no private key is needed.</p>
          </div>
        </div>
        <div className="rounded-lg border border-utility-warning-200 bg-utility-warning-50 p-md text-sm text-utility-warning-700">
          <strong>SIMULATION ONLY</strong> · A displayed sender address does not authorize spending from that wallet. This panel cannot move real ETH or other assets, create a real transaction hash, or credit an external wallet.
        </div>
        <div className="grid grid-cols-1 gap-lg md:grid-cols-2">
          <div className="flex flex-col gap-sm">
            <label className="text-sm font-medium text-secondary">Sender label / demo address</label>
            <input value={sender} onChange={(e) => setSender(e.target.value)} className="rounded-md bg-primary px-lg py-sm text-sm font-mono text-primary border border-primary" placeholder="Demo sender label" />
            <p className="text-xs text-tertiary">Default demo balance: 1,000 {asset}. Editing this label does not connect to a wallet.</p>
          </div>
          <div className="flex flex-col gap-sm">
            <label className="text-sm font-medium text-secondary">Receiver label / demo address</label>
            <input value={receiver} onChange={(e) => setReceiver(e.target.value)} className="rounded-md bg-primary px-lg py-sm text-sm font-mono text-primary border border-primary" placeholder="Demo receiver label" />
            <p className="text-xs text-tertiary">Use a label or a test address. No funds are sent to it.</p>
          </div>
          <div className="flex flex-col gap-sm">
            <label className="text-sm font-medium text-secondary">Demo amount</label>
            <input type="number" min="0.000001" max="1000" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} className="rounded-md bg-primary px-lg py-sm text-sm text-primary border border-primary" />
          </div>
          <div className="flex flex-col gap-sm">
            <label className="text-sm font-medium text-secondary">Demo asset</label>
            <select value={asset} onChange={(e) => setAsset(e.target.value)} className="rounded-md bg-primary px-lg py-sm text-sm text-primary border border-primary">
              <option value="ETH">ETH (fictional demo units)</option>
              <option value="VTRC">VTRC (fictional demo units)</option>
              <option value="TRX">TRX (fictional demo units)</option>
              <option value="USDT-DEMO">USDT-DEMO (fictional demo units)</option>
            </select>
          </div>
          <div className="flex flex-col gap-sm md:col-span-2">
            <label className="text-sm font-medium text-secondary">Optional vanity-style receiver label</label>
            <input value={alias} onChange={(e) => setAlias(e.target.value)} className="rounded-md bg-primary px-lg py-sm text-sm font-mono text-primary border border-primary" placeholder="e.g. receiver-vanity-demo" />
            <p className="text-xs text-tertiary">This is only a display alias, not an Ethereum address generator and not proof of control over any wallet.</p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-md sm:grid-cols-3">
          <div className="rounded-lg border border-secondary bg-secondary p-lg"><p className="text-xs text-tertiary">Demo sender balance</p><p className="mt-xs text-xl font-semibold text-primary">{senderBalance.toLocaleString()} {asset}</p></div>
          <div className="rounded-lg border border-secondary bg-secondary p-lg"><p className="text-xs text-tertiary">Demo receiver balance</p><p className="mt-xs text-xl font-semibold text-primary">{receiverBalance.toLocaleString()} {asset}</p></div>
          <div className="rounded-lg border border-secondary bg-secondary p-lg"><p className="text-xs text-tertiary">Simulation records</p><p className="mt-xs text-xl font-semibold text-primary">{records.length}</p></div>
        </div>
        {error && <p role="alert" className="rounded-lg bg-utility-error-50 p-md text-sm text-utility-error-700">{error}</p>}
        <div className="flex flex-wrap gap-sm">
          <button type="button" onClick={simulate} className="inline-flex items-center gap-sm rounded-lg bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand"><ArrowUpRight className="size-4" /> Simulate transfer</button>
          <button type="button" onClick={() => { setRecords([]); setError('') }} className="inline-flex items-center gap-sm rounded-lg border border-primary px-lg py-sm text-sm font-semibold text-secondary"><RotateCcw className="size-4" /> Reset demo ledger</button>
        </div>
      </section>
      <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-md">
        <div className="flex items-center gap-sm"><ShieldCheck className="size-5 text-fg-brand-primary" /><h3 className="text-sm font-semibold text-primary">Demo activity ledger</h3></div>
        {records.length === 0 ? <p className="text-sm text-tertiary">No demo transfers yet. Try 65 ETH to create a clearly marked simulation record.</p> : <div className="space-y-sm">{records.map((record) => <div key={record.id} className="rounded-lg border border-secondary p-md">
          <div className="flex flex-wrap items-center justify-between gap-sm"><span className="inline-flex items-center gap-xs text-sm font-semibold text-primary"><ArrowUpRight className="size-4" /> Simulated send: {record.amount} {record.asset}</span><span className="rounded-full bg-utility-warning-50 px-sm py-xxs text-xs font-semibold text-utility-warning-700">NOT ON-CHAIN</span></div>
          <p className="mt-sm break-all font-mono text-xs text-tertiary">From: {record.from}</p>
          <p className="mt-xs break-all font-mono text-xs text-tertiary">To: {record.to}</p>
          {alias.trim() && record.to === receiver.trim() && <p className="mt-xs text-xs text-secondary">Display alias: {alias}</p>}
          <p className="mt-sm text-xs text-tertiary">{record.createdAt} · Demo reference: {record.id}</p>
        </div>)}</div>}
      </section>
      <section className="rounded-xl border border-secondary bg-primary p-xl">
        <h3 className="text-sm font-semibold text-primary">For real transfers</h3>
        <p className="mt-sm text-sm text-tertiary">Use the existing Shasta workflow for native TRX tests. For real Ethereum assets, the sender must authorize a wallet transaction; a contract can transfer a user's ERC-20 tokens only when that user has granted an allowance or another valid authorization path applies.</p>
      </section>
    </div>
  )
}
