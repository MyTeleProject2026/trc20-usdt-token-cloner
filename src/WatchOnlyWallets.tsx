import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowLeft, Copy, ExternalLink, Plus, RefreshCw, ShieldCheck, Trash2, Wallet, X } from 'lucide-react'
import { TronWeb } from 'tronweb'

type NetworkId = 'mainnet' | 'nile' | 'shasta'
type WatchEntry = { address: string; label: string }
type WatchSnapshot = {
  network: NetworkId
  address: string
  trxBalance: string | null
  usdtBalance: string | null
  checkedAt: number
  status: 'verified' | 'partial' | 'unavailable'
  note: string
}

const STORAGE_KEY = 'tron-token-studio:watch-only-addresses:v1'
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const OFFICIAL_MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const RPC: Record<NetworkId, string> = {
  mainnet: 'https://api.trongrid.io',
  nile: 'https://nile.trongrid.io',
  shasta: 'https://api.shasta.trongrid.io',
}
const TOKEN_ABI = [
  { constant: true, inputs: [{ name: 'owner', type: 'address' }], name: 'balanceOf', outputs: [{ name: 'balance', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { constant: true, inputs: [], name: 'decimals', outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view', type: 'function' },
]

function createTronWeb(network: NetworkId): any {
  return new TronWeb({ fullHost: RPC[network] } as any) as any
}

function readWatchList(): WatchEntry[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '[]')
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    return parsed.filter((item: any) => {
      if (!item || typeof item.address !== 'string' || !ADDRESS_PATTERN.test(item.address)) return false
      if (seen.has(item.address)) return false
      seen.add(item.address)
      return true
    }).slice(0, 100).map((item: any) => ({
      address: item.address,
      label: typeof item.label === 'string' ? item.label.trim().slice(0, 48) : '',
    }))
  } catch {
    return []
  }
}

function formatUnits(value: unknown, decimals: number): string {
  try {
    const units = BigInt(String(value))
    const scale = 10n ** BigInt(decimals)
    const whole = units / scale
    const remainder = units % scale
    if (remainder === 0n) return whole.toString()
    return whole.toString() + '.' + remainder.toString().padStart(decimals, '0').replace(/0+$/, '')
  } catch {
    return 'Unavailable'
  }
}

function snapshotKey(network: NetworkId, address: string): string {
  return network + ':' + address
}

function explorerUrl(network: NetworkId, address: string): string {
  const host = network === 'mainnet' ? 'https://tronscan.org' : network === 'nile' ? 'https://nile.tronscan.org' : 'https://shasta.tronscan.org'
  return host + '/#/address/' + encodeURIComponent(address)
}

async function readAddressSnapshot(network: NetworkId, address: string): Promise<WatchSnapshot> {
  const checkedAt = Date.now()
  const web = createTronWeb(network)
  if (!ADDRESS_PATTERN.test(address) || !web.isAddress(address)) {
    return { network, address, trxBalance: null, usdtBalance: null, checkedAt, status: 'unavailable', note: 'Address validation failed.' }
  }
  try {
    const rawTrx = await web.trx.getBalance(address)
    const trxBalance = formatUnits(String(rawTrx), 6)
    if (network !== 'mainnet') {
      return {
        network, address, trxBalance, usdtBalance: null, checkedAt, status: 'verified',
        note: 'TRX balance read from the selected testnet. Official Tether USDT is displayed only on Mainnet.',
      }
    }
    try {
      const token = await web.contract(TOKEN_ABI, OFFICIAL_MAINNET_USDT)
      const [rawUsdt, rawDecimals] = await Promise.all([
        token.balanceOf(address).call(),
        token.decimals().call(),
      ])
      if (Number(String(rawDecimals)) !== 6) {
        throw new Error('The official USDT contract returned unexpected decimal metadata.')
      }
      return {
        network, address, trxBalance, usdtBalance: formatUnits(rawUsdt, 6), checkedAt, status: 'verified',
        note: 'TRX and official Mainnet USDT balances were read from the public chain.',
      }
    } catch {
      return {
        network, address, trxBalance, usdtBalance: null, checkedAt, status: 'partial',
        note: 'TRX balance was read, but the official USDT balance could not be verified. Retry later.',
      }
    }
  } catch {
    return {
      network, address, trxBalance: null, usdtBalance: null, checkedAt, status: 'unavailable',
      note: 'The public TRON node could not read this address. No private-key or signing operation was attempted.',
    }
  }
}

export default function WatchOnlyWallets() {
  const [network, setNetwork] = useState<NetworkId>('mainnet')
  const [watchList, setWatchList] = useState<WatchEntry[]>(readWatchList)
  const [snapshots, setSnapshots] = useState<Record<string, WatchSnapshot>>({})
  const [addressInput, setAddressInput] = useState('')
  const [labelInput, setLabelInput] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [refreshNonce, setRefreshNonce] = useState(0)

  useEffect(() => {
    if (watchList.length === 0) {
      setRefreshing(false)
      return
    }
    let cancelled = false
    setRefreshing(true)
    void Promise.all(watchList.map(async (entry) => ({
      key: snapshotKey(network, entry.address),
      snapshot: await readAddressSnapshot(network, entry.address),
    }))).then((results) => {
      if (cancelled) return
      setSnapshots(current => {
        const next = { ...current }
        for (const result of results) next[result.key] = result.snapshot
        return next
      })
    }).finally(() => {
      if (!cancelled) setRefreshing(false)
    })
    return () => { cancelled = true }
  }, [watchList, network, refreshNonce])

  function persistWatchList(next: WatchEntry[]) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      setWatchList(next)
      return true
    } catch {
      setError('The device could not save the watch-only address list. Check local storage and try again.')
      return false
    }
  }

  function addWatchAddress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setNotice('')
    const candidate = addressInput.trim()
    const web = createTronWeb(network)
    if (!ADDRESS_PATTERN.test(candidate) || !web.isAddress(candidate)) {
      setError('Enter a valid TRON Base58Check address. A wallet address alone cannot recover or reveal its private key.')
      return
    }
    if (watchList.some(item => item.address === candidate)) {
      setError('This address is already on the watch-only list.')
      return
    }
    if (watchList.length >= 100) {
      setError('The watch-only list is limited to 100 addresses on this device.')
      return
    }
    const next = [...watchList, { address: candidate, label: labelInput.trim().slice(0, 48) }]
    if (!persistWatchList(next)) return
    setAddressInput('')
    setLabelInput('')
    setNotice('Address added as watch-only. Balances will be read from the selected network; this does not grant spending authority.')
  }

  function removeWatchAddress(address: string) {
    const next = watchList.filter(item => item.address !== address)
    if (persistWatchList(next)) {
      setNotice('Address removed from this device’s watch-only list. No on-chain transaction was sent.')
    }
  }

  async function copyAddress(address: string) {
    try {
      await navigator.clipboard.writeText(address)
      setNotice('Public wallet address copied.')
      setError('')
    } catch {
      setError('Clipboard permission was denied. Select the public address and copy it manually.')
    }
  }

  return (
    <main className="mx-auto min-h-screen w-full max-w-5xl px-4 py-7 text-[#e6fff7]">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-[#28443f] pb-5">
        <div className="flex items-center gap-3">
          <span className="rounded-xl border border-[#31534c] bg-[#102d27] p-3 text-[#5dffc8]"><Wallet size={23} aria-hidden="true" /></span>
          <div>
            <p className="text-xs uppercase tracking-[0.16em] text-[#91b3aa]">TRON Token Studio · owner tools</p>
            <h1 className="text-2xl font-semibold">Watch-only addresses</h1>
          </div>
        </div>
        <a href="#/wallet" className="inline-flex items-center gap-2 rounded-lg border border-[#31534c] px-4 py-2 text-sm text-[#5dffc8] hover:bg-[#102d27]"><ArrowLeft size={16} /> Wallet Vault</a>
      </header>

      <section className="mb-5 rounded-2xl border border-[#28443f] bg-[#0d191c] p-5">
        <div className="mb-4 flex items-start gap-3">
          <ShieldCheck className="mt-1 text-[#5dffc8]" size={23} aria-hidden="true" />
          <div>
            <h2 className="text-lg font-semibold">Monitor public on-chain balances</h2>
            <p className="mt-1 text-sm leading-6 text-[#b7d5cc]">Add TRON addresses to monitor balances without importing their keys or connecting another wallet application. Only public address and balance data are stored by this screen.</p>
          </div>
        </div>

        <div role="note" className="mb-5 rounded-xl border border-[#715a28] bg-[#2a2110] p-4 text-sm leading-6 text-[#ffe4a1]">
          <strong>Watch-only means read-only.</strong> A public address does not contain its private key, and cryptography does not provide a method to derive that key from the address. This screen cannot reveal or recover another wallet’s private key, sign transactions for it, or redirect its assets.
        </div>

        {error && <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-[#79353d] bg-[#2b1518] p-3 text-sm text-[#ffc1c6]"><X size={17} className="mt-0.5" />{error}</div>}
        {notice && <div role="status" className="mb-4 rounded-lg border border-[#236b58] bg-[#0d2a20] p-3 text-sm text-[#a3ffdf]">{notice}</div>}

        <form onSubmit={addWatchAddress} className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto]">
          <label className="flex flex-col gap-2 text-sm text-[#b7d5cc]">
            TRON address
            <input value={addressInput} onChange={event => setAddressInput(event.target.value)} placeholder="T..." autoComplete="off" spellCheck={false} className="rounded-lg border border-[#31534c] bg-[#091416] px-3 py-3 font-mono text-sm text-[#e6fff7]" />
          </label>
          <label className="flex flex-col gap-2 text-sm text-[#b7d5cc]">
            Label (optional)
            <input value={labelInput} onChange={event => setLabelInput(event.target.value)} maxLength={48} placeholder="Treasury, savings…" className="rounded-lg border border-[#31534c] bg-[#091416] px-3 py-3 text-sm text-[#e6fff7]" />
          </label>
          <button type="submit" className="mt-auto inline-flex items-center justify-center gap-2 rounded-lg border border-[#5dffc8] bg-[#5dffc8] px-4 py-3 font-semibold text-[#04110d] hover:bg-[#8dffda]"><Plus size={17} /> Add address</button>
        </form>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[#1d3432] pt-4">
          <label className="flex items-center gap-3 text-sm text-[#b7d5cc]">
            Network
            <select value={network} onChange={event => setNetwork(event.target.value as NetworkId)} className="rounded-lg border border-[#31534c] bg-[#091416] px-3 py-2 text-[#e6fff7]">
              <option value="mainnet">TRON Mainnet</option>
              <option value="nile">Nile Testnet</option>
              <option value="shasta">Shasta Testnet</option>
            </select>
          </label>
          <button type="button" disabled={refreshing || watchList.length === 0} onClick={() => setRefreshNonce(value => value + 1)} className="inline-flex items-center gap-2 rounded-lg border border-[#31534c] px-4 py-2 text-sm text-[#5dffc8] disabled:opacity-50"><RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />{refreshing ? 'Reading chain…' : 'Refresh balances'}</button>
        </div>
      </section>

      <section className="space-y-3">
        {watchList.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[#31534c] bg-[#0d191c] p-7 text-center">
            <Wallet size={30} className="mx-auto mb-3 text-[#71938a]" />
            <h2 className="font-semibold">No watch-only addresses yet</h2>
            <p className="mt-2 text-sm text-[#91b3aa]">Add an address above to read its public on-chain balances.</p>
          </div>
        ) : watchList.map(entry => {
          const snapshot = snapshots[snapshotKey(network, entry.address)]
          return (
            <article key={entry.address} className="rounded-2xl border border-[#28443f] bg-[#0d191c] p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <h2 className="break-words font-semibold">{entry.label || 'Watched TRON address'}</h2>
                  <p className="mt-1 break-all font-mono text-xs text-[#b7d5cc]">{entry.address}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" onClick={() => void copyAddress(entry.address)} className="inline-flex items-center gap-2 rounded-lg border border-[#31534c] px-3 py-2 text-xs text-[#5dffc8]"><Copy size={14} /> Copy address</button>
                    <a href={explorerUrl(network, entry.address)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-lg border border-[#31534c] px-3 py-2 text-xs text-[#5dffc8]"><ExternalLink size={14} /> Open explorer</a>
                    <button type="button" onClick={() => removeWatchAddress(entry.address)} className="inline-flex items-center gap-2 rounded-lg border border-[#79353d] px-3 py-2 text-xs text-[#ffc1c6]"><Trash2 size={14} /> Remove</button>
                  </div>
                </div>
                <span className="rounded-full border border-[#31534c] px-3 py-1 text-xs text-[#91b3aa]">Watch-only</span>
              </div>
              <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-[#1d3432] bg-[#091416] p-4">
                  <p className="text-xs uppercase tracking-wider text-[#91b3aa]">TRX balance</p>
                  <p className="mt-2 break-words text-xl font-semibold">{snapshot?.trxBalance ?? '—'} <span className="text-sm font-normal text-[#91b3aa]">TRX</span></p>
                </div>
                <div className="rounded-xl border border-[#1d3432] bg-[#091416] p-4">
                  <p className="text-xs uppercase tracking-wider text-[#91b3aa]">Official Tether USDT</p>
                  <p className="mt-2 break-words text-xl font-semibold">{network === 'mainnet' ? (snapshot?.usdtBalance ?? '—') : 'Mainnet only'} <span className="text-sm font-normal text-[#91b3aa]">{network === 'mainnet' ? 'USDT' : ''}</span></p>
                </div>
              </div>
              <p className="mt-3 text-xs leading-5 text-[#91b3aa]">
                {snapshot ? snapshot.note + ' Checked: ' + new Date(snapshot.checkedAt).toLocaleString() : 'Balance has not been read yet.'}
                {snapshot && snapshot.status === 'unavailable' ? ' Status: unavailable.' : snapshot && snapshot.status === 'partial' ? ' Status: partial.' : snapshot ? ' Status: verified read.' : ''}
              </p>
            </article>
          )
        })}
      </section>

      <section className="mt-6 rounded-2xl border border-[#28443f] bg-[#0d191c] p-5">
        <h2 className="font-semibold">Private-key recovery and spending authority</h2>
        <p className="mt-2 text-sm leading-6 text-[#b7d5cc]">To regain access to a wallet, its owner must use the original private key, seed phrase (if one was created), or an authorized encrypted backup. A watched address is not enough. This monitor intentionally has no private-key reveal, key-recovery, transaction-signing, or automatic payout controls. Treasury payouts must use a separately authorized treasury signer and genuine on-chain assets, with the payout reviewed and recorded under an explicit policy.</p>
      </section>
    </main>
  )
}
