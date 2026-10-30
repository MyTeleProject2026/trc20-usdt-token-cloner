import { useState, type FormEvent } from 'react'
import { createTestnetPreview } from './testnet-sandbox.mjs'
import './testnet-sandbox.css'

type Preview = ReturnType<typeof createTestnetPreview>

export default function TestnetSandbox() {
  const [network, setNetwork] = useState<'nile' | 'shasta'>('nile')
  const [asset, setAsset] = useState<'TRX' | 'TRC20'>('TRX')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [tokenContract, setTokenContract] = useState('')
  const [symbol, setSymbol] = useState('DEMO')
  const [decimals, setDecimals] = useState('6')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState('')

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setPreview(null)
    try {
      setPreview(createTestnetPreview({
        network, asset, from, to, amount, tokenContract, symbol, decimals: Number(decimals),
      }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to create the local preview.')
    }
  }

  function reset() {
    setPreview(null)
    setError('')
    setFrom('')
    setTo('')
    setAmount('')
    setTokenContract('')
  }

  return (
    <main className="testnet-sandbox">
      <header className="testnet-sandbox__topbar">
        <a className="testnet-sandbox__brand" href="#/wallet">TRON Token Studio</a>
        <span className="testnet-sandbox__topbar-tag">DEVELOPMENT WORKSPACE</span>
        <a className="testnet-sandbox__back" href="#/wallet">Back to wallet</a>
      </header>

      <section className="testnet-sandbox__intro">
        <p className="testnet-sandbox__eyebrow">ISOLATED TESTNET TOOL</p>
        <h1>Testnet transaction preview</h1>
        <p>Validate a transfer form and inspect the exact values locally. This page does not connect to a wallet or blockchain node.</p>
      </section>

      <section className="testnet-sandbox__notice" role="note">
        <strong>Preview only — no funds move</strong>
        <p>No private key or seed phrase is requested. No wallet connection, RPC request, signature, transaction ID, or broadcast is created. The preview is not a transaction and cannot credit a wallet or exchange account.</p>
      </section>

      <div className="testnet-sandbox__layout">
        <form className="testnet-sandbox__card" onSubmit={submit}>
          <div className="testnet-sandbox__card-head">
            <div>
              <span className="testnet-sandbox__step">01 / INPUT</span>
              <h2>Transfer details</h2>
            </div>
            <span className="testnet-sandbox__pill">Local validation</span>
          </div>

          <label>
            <span>Test network</span>
            <select value={network} onChange={event => { setNetwork(event.target.value as 'nile' | 'shasta'); setPreview(null) }}>
              <option value="nile">TRON Nile testnet</option>
              <option value="shasta">TRON Shasta testnet</option>
            </select>
          </label>

          <label>
            <span>Asset type</span>
            <select value={asset} onChange={event => { setAsset(event.target.value as 'TRX' | 'TRC20'); setPreview(null) }}>
              <option value="TRX">TRX testnet asset</option>
              <option value="TRC20">TRC-20 test token</option>
            </select>
          </label>

          <label>
            <span>Sender address</span>
            <input value={from} onChange={event => { setFrom(event.target.value); setPreview(null) }} placeholder="T..." autoComplete="off" spellCheck={false} />
          </label>

          <label>
            <span>Recipient address</span>
            <input value={to} onChange={event => { setTo(event.target.value); setPreview(null) }} placeholder="T..." autoComplete="off" spellCheck={false} />
          </label>

          {asset === 'TRC20' && (
            <>
              <label>
                <span>Test token contract</span>
                <input value={tokenContract} onChange={event => { setTokenContract(event.target.value); setPreview(null) }} placeholder="Testnet contract address" autoComplete="off" spellCheck={false} />
              </label>
              <div className="testnet-sandbox__field-row">
                <label>
                  <span>Display symbol</span>
                  <input value={symbol} onChange={event => { setSymbol(event.target.value); setPreview(null) }} maxLength={12} />
                </label>
                <label>
                  <span>Decimals</span>
                  <select value={decimals} onChange={event => { setDecimals(event.target.value); setPreview(null) }}>
                    {Array.from({ length: 19 }, (_, index) => <option key={index} value={String(index)}>{index}</option>)}
                  </select>
                </label>
              </div>
            </>
          )}

          <label>
            <span>Amount</span>
            <input value={amount} onChange={event => { setAmount(event.target.value); setPreview(null) }} placeholder="e.g. 12.5" inputMode="decimal" autoComplete="off" />
          </label>

          {error && <p className="testnet-sandbox__error" role="alert">{error}</p>}

          <div className="testnet-sandbox__actions">
            <button type="submit">Create local preview</button>
            <button className="testnet-sandbox__reset" type="button" onClick={reset}>Reset</button>
          </div>
          <p className="testnet-sandbox__footnote">Address checks in this isolated form validate the TRON Base58 character/length pattern only. They do not verify an address checksum, account existence, token deployment, or balance.</p>
        </form>

        <section className="testnet-sandbox__card testnet-sandbox__result" aria-live="polite">
          <div className="testnet-sandbox__card-head">
            <div>
              <span className="testnet-sandbox__step">02 / REVIEW</span>
              <h2>Preview result</h2>
            </div>
            <span className="testnet-sandbox__pill testnet-sandbox__pill--muted">No broadcast</span>
          </div>
          {!preview ? (
            <div className="testnet-sandbox__empty">
              <div className="testnet-sandbox__empty-mark">T</div>
              <strong>No preview created</strong>
              <p>Enter testnet transfer details and select “Create local preview”. No network call will be made.</p>
            </div>
          ) : (
            <>
              <div className="testnet-sandbox__status">
                <span>LOCAL REVIEW STATE</span>
                <strong>Preview only</strong>
              </div>
              <div className="testnet-sandbox__amount">
                <strong>{preview.amount} {preview.symbol}</strong>
                <span>{preview.network.toUpperCase()} · {preview.asset}</span>
              </div>
              <dl className="testnet-sandbox__details">
                <div><dt>From</dt><dd>{preview.from}</dd></div>
                <div><dt>To</dt><dd>{preview.to}</dd></div>
                {preview.tokenContract && <div><dt>Token contract</dt><dd>{preview.tokenContract}</dd></div>}
                <div><dt>Base units</dt><dd>{preview.amountBaseUnits}</dd></div>
                <div><dt>Generated locally</dt><dd>{new Date(preview.createdAt).toLocaleString()}</dd></div>
                <div><dt>Transaction ID</dt><dd>None — not a transaction</dd></div>
              </dl>
              <div className="testnet-sandbox__checks">
                <p><span>✓</span> Input format accepted</p>
                <p><span>✓</span> Decimal precision checked</p>
                <p><span>✓</span> Mainnet network is excluded</p>
                <p><span>✓</span> Signing and broadcast not available</p>
              </div>
            </>
          )}
        </section>
      </div>

      <footer className="testnet-sandbox__footer">TRON Token Studio · Testnet sandbox · Browser-memory-only preview</footer>
    </main>
  )
}
