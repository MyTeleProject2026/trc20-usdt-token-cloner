import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Coins, ExternalLink, RefreshCw, Rocket, ShieldCheck, Wallet } from 'lucide-react'
import {
  TRAX_TOKEN_ARTIFACT, addressesEqual, assertMainnetWallet, deployContractFromTronLink,
  callMainnetView, formatTokenUnits, getMainnetNativeBalance, loadSavedContracts, parseBatchCreditRows, parseTokenUnits, saveContractAddresses,
  sendAndVerifyContractCall,
} from './trax-mainnet.mjs'

const EXPECTED_OWNER_ADDRESS = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const DEFAULT_RECIPIENT = ''
const DEFAULT_FEE_CAP = '60'

function makeReference() {
  const bytes = new Uint8Array(32)
  window.crypto.getRandomValues(bytes)
  return '0x' + Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
}

function shorten(value) {
  return value && value.length > 18 ? value.slice(0, 10) + '…' + value.slice(-7) : value || '—'
}

export default function TRXMainnetPanel({ wallet, onConnect }) {
  const initial = useMemo(() => loadSavedContracts(), [])
  const [tokenAddress, setTokenAddress] = useState(initial.tokenAddress)
  const [snapshot, setSnapshot] = useState(null)
  const [recipient, setRecipient] = useState(DEFAULT_RECIPIENT)
  const [amount, setAmount] = useState('100')
  const [batchInput, setBatchInput] = useState('')
  const [lookupAddress, setLookupAddress] = useState(DEFAULT_RECIPIENT)
  const [lookupBalance, setLookupBalance] = useState('')
  const [feeCap, setFeeCap] = useState(DEFAULT_FEE_CAP)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [lastTx, setLastTx] = useState('')
  const [step, setStep] = useState('')

  useEffect(() => {
    try { saveContractAddresses({ tokenAddress, vaultAddress: '' }) } catch {}
  }, [tokenAddress])

  const connectedAddress = wallet?.address || ''
  const walletReady = Boolean(wallet?.tronWeb && connectedAddress === EXPECTED_OWNER_ADDRESS)
  const feeCapSun = useMemo(() => {
    try {
      const units = BigInt(parseTokenUnits(feeCap))
      if (units > 500000000n) return 0
      return Number(units)
    } catch { return 0 }
  }, [feeCap])

  const run = useCallback(async (label, action) => {
    setBusy(true); setError(''); setNotice(''); setStep(label)
    try { return await action() }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return null
    } finally { setBusy(false); setStep('') }
  }, [])

  const getToken = useCallback(async () => {
    const tronWeb = assertMainnetWallet(wallet)
    if (!tronWeb.isAddress(tokenAddress)) throw new Error('Enter a valid deployed TRON Mainnet TRӾ contract address.')
    const token = await tronWeb.contract(TRAX_TOKEN_ARTIFACT.abi).at(tokenAddress)
    return { tronWeb, token }
  }, [wallet, tokenAddress])

  const assertOwner = useCallback(async (token, tronWeb) => {
    const owner = await callMainnetView(token.owner())
    if (!addressesEqual(tronWeb, owner, connectedAddress)) throw new Error('Connected TronLink wallet is not the on-chain TRӾ owner.')
    return owner
  }, [connectedAddress])

  const refresh = () => run('Reading TRON Mainnet token state', async () => {
    const { tronWeb, token } = await getToken()
    const [owner, name, symbol, decimals, totalSupply, paused, mintingEnabled, ownerBalance, ownerTrx] = await Promise.all([
      token.owner().call(), callMainnetView(token.name()), callMainnetView(token.symbol()), callMainnetView(token.decimals()),
      callMainnetView(token.totalSupply()), callMainnetView(token.paused()), callMainnetView(token.mintingEnabled()),
      callMainnetView(token.balanceOf(connectedAddress)), getMainnetNativeBalance(tronWeb, connectedAddress),
    ])
    const valid = name === 'TRӾ' && symbol === 'TRAX' && Number(decimals) === 6
    const ownerValid = addressesEqual(tronWeb, owner, connectedAddress)
    const next = {
      owner: String(owner), name, symbol, decimals: Number(decimals), totalSupply: String(totalSupply),
      paused: Boolean(paused), mintingEnabled: Boolean(mintingEnabled), ownerBalance: String(ownerBalance),
      ownerTrx: String(ownerTrx), valid, ownerValid,
    }
    setSnapshot(next)
    if (!valid) throw new Error('Token metadata mismatch. Expected TRӾ / TRAX / 6 decimals.')
    if (!ownerValid) throw new Error('Connected TronLink account is not the token owner.')
    setNotice('Mainnet contract reads succeeded. This is an owner-issued, unbacked token; no reserve or redemption is represented.')
    return next
  })

  const deployToken = () => run('Preparing TRӾ Mainnet deployment · TronLink approval required', async () => {
    if (!walletReady) throw new Error('Connect the configured owner TronLink wallet first.')
    if (!feeCapSun) throw new Error('Enter a valid deployment fee cap between 0.000001 and 500 TRX.')
    if (tokenAddress) throw new Error('A token contract address is already saved. Clear it only if you intend to deploy a new token.')
    const result = await deployContractFromTronLink(wallet, TRAX_TOKEN_ARTIFACT, 'Restricted1TRAX', feeCapSun)
    setTokenAddress(result.address)
    setLastTx(result.txID)
    setNotice('TRӾ contract deployment is confirmed and the deployed bytecode and owner were verified.')
  })

  const activate = () => run('Enabling owner issuance · two TronLink approvals', async () => {
    const { tronWeb, token } = await getToken()
    await assertOwner(token, tronWeb)
    const paused = await token.paused().call()
    const enabled = await token.mintingEnabled().call()
    if (!paused && enabled) { setNotice('Owner issuance is already enabled.'); return }
    if (paused) {
      const unpause = await sendAndVerifyContractCall(tronWeb, token.setPaused(false), feeCapSun, connectedAddress)
      setLastTx(unpause.txID)
    }
    if (!enabled) {
      const enable = await sendAndVerifyContractCall(tronWeb, token.setMintingEnabled(true), feeCapSun, connectedAddress)
      setLastTx(enable.txID)
    }
    setNotice('Transfers are unpaused and owner minting is enabled. New issuance does not require TRX deposits.')
    await refresh()
  })

  const issueCredit = () => run('Preparing owner credit to external TRON address', async () => {
    const { tronWeb, token } = await getToken()
    await assertOwner(token, tronWeb)
    if (!tronWeb.isAddress(recipient.trim())) throw new Error('Enter a valid TRON Mainnet recipient address.')
    if (!feeCapSun) throw new Error('Enter a valid transaction fee cap.')
    const units = parseTokenUnits(amount)
    const [paused, enabled] = await Promise.all([token.paused().call(), token.mintingEnabled().call()])
    if (paused || !enabled) throw new Error('Token is paused or owner issuance is disabled. Activate it first.')
    const reference = makeReference()
    const result = await sendAndVerifyContractCall(tronWeb, token.credit(recipient.trim(), units, reference), feeCapSun, connectedAddress)
    setLastTx(result.txID)
    setNotice(amount + ' TRӾ credited on-chain to ' + recipient.trim() + '. Reference: ' + reference)
    await refresh()
  })


  const batchCredit = () => run('Preparing batch credits to external TRON addresses', async () => {
    const { tronWeb, token } = await getToken()
    await assertOwner(token, tronWeb)
    if (!feeCapSun) throw new Error('Enter a valid transaction fee cap.')
    const { recipients, amounts } = parseBatchCreditRows(batchInput, (address) => tronWeb.isAddress(address), 50)
    const references = recipients.map(() => makeReference())
    const [paused, enabled] = await Promise.all([token.paused().call(), token.mintingEnabled().call()])
    if (paused || !enabled) throw new Error('Token is paused or owner issuance is disabled. Activate it first.')
    const result = await sendAndVerifyContractCall(tronWeb, token.batchCredit(recipients, amounts, references), feeCapSun, connectedAddress)
    setLastTx(result.txID)
    setNotice('Batch credit confirmed for ' + recipients.length + ' TRON addresses. Every row has a unique on-chain reference.')
    await refresh()
  })

  const readBalance = () => run('Reading external wallet token balance', async () => {
    const { tronWeb, token } = await getToken()
    if (!tronWeb.isAddress(lookupAddress.trim())) throw new Error('Enter a valid TRON Mainnet address.')
    const balance = await callMainnetView(token.balanceOf(lookupAddress.trim()))
    setLookupBalance(String(balance))
    return balance
  })

  const transfer = () => run('Preparing owner wallet TRӾ transfer', async () => {
    const { tronWeb, token } = await getToken()
    await assertOwner(token, tronWeb)
    if (!tronWeb.isAddress(recipient.trim())) throw new Error('Enter a valid TRON Mainnet recipient address.')
    const units = parseTokenUnits(amount)
    const balance = await token.balanceOf(connectedAddress).call()
    if (BigInt(String(balance)) < BigInt(units)) throw new Error('Owner wallet token balance is insufficient. Use owner credit to issue new tokens.')
    const result = await sendAndVerifyContractCall(tronWeb, token.transfer(recipient.trim(), units), feeCapSun, connectedAddress)
    setLastTx(result.txID)
    setNotice(amount + ' existing TRӾ transferred from the owner wallet to ' + recipient.trim() + '.')
    await refresh()
  })

  const pause = () => run('Emergency pause · TronLink approval required', async () => {
    const { tronWeb, token } = await getToken()
    await assertOwner(token, tronWeb)
    const result = await sendAndVerifyContractCall(tronWeb, token.setPaused(true), feeCapSun, connectedAddress)
    setLastTx(result.txID)
    setNotice('Token transfers and owner issuance are paused.')
    await refresh()
  })

  const disableMinting = () => run('Disabling owner issuance · TronLink approval required', async () => {
    const { tronWeb, token } = await getToken()
    await assertOwner(token, tronWeb)
    const result = await sendAndVerifyContractCall(tronWeb, token.setMintingEnabled(false), feeCapSun, connectedAddress)
    setLastTx(result.txID)
    setNotice('Owner minting is disabled. Existing token transfers remain available unless the token is paused.')
    await refresh()
  })

  return <section className="trax-workspace">
    <div className="section-heading"><div><span className="eyebrow">TRON TRANSFER · OWNER-ISSUED · MAINNET</span><h2>TRӾ token &amp; external wallet credit manager</h2><p>Deploy and administer the TRӾ TRC-20 contract from the configured owner wallet. Every write requires a separate TronLink approval.</p></div><div className="panel-icon"><Coins/></div></div>

    <div className="trax-notice" role="note"><AlertTriangle size={18}/><div><b>UNBACKED OWNER-ISSUED TOKEN — NOT NATIVE TRX</b><p>The owner can mint without depositing TRX. There is no reserve, collateral, guaranteed redemption, fixed 1:1 TRX value, or promised market price. Unlimited issuance can dilute holders and reduce market value. TRӾ is not TRON's native TRX asset.</p></div></div>

    {!walletReady ? <div className="trax-connect"><p>{connectedAddress ? 'Connected account does not match the configured owner wallet (' + EXPECTED_OWNER_ADDRESS + '). Switch accounts in TronLink and reconnect.' : 'Connect the configured owner TronLink wallet on TRON Mainnet to continue.'}</p><button type="button" className="primary-button" onClick={onConnect}><Wallet size={16}/> Connect owner TronLink</button></div> : <div className="trax-wallet-row"><span>Connected owner wallet</span><b>{shorten(connectedAddress)}</b><span className="trax-network"><CheckCircle2 size={14}/> TRON Mainnet</span></div>}

    {error && <div className="notice notice-error" role="alert"><AlertTriangle size={16}/>{error}</div>}
    {notice && <div className="notice notice-success" role="status"><CheckCircle2 size={16}/>{notice}</div>}
    {step && <div className="trax-progress"><RefreshCw size={15}/>{step}</div>}

    <div className="trax-addresses">
      <label>TRӾ Mainnet contract address<input value={tokenAddress} onChange={e => setTokenAddress(e.target.value.trim())} placeholder="Deploy TRӾ or paste a verified contract address"/></label>
      <div className="button-row"><button type="button" className="secondary-button" disabled={!walletReady || busy || Boolean(tokenAddress) || !feeCapSun} onClick={deployToken}><Rocket size={15}/> Deploy TRӾ token</button><button type="button" className="outline-button" disabled={!walletReady || busy || !tokenAddress} onClick={refresh}><RefreshCw size={15}/> Verify contract state</button></div>
      <label>Transaction fee cap (TRX)<input type="number" min="0.000001" max="500" step="1" value={feeCap} onChange={e => setFeeCap(e.target.value)}/></label>
      <p className="fine-print">Deployment is an irreversible Mainnet transaction. The deployer becomes the initial owner. This dashboard does not deploy automatically; you must click the deployment button and approve the TronLink prompt yourself.</p>
    </div>

    <div className="trax-actions">
      <h3>Live on-chain token status</h3>
      {snapshot ? <div className="trax-stats">
        <article><span>Total TRӾ supply</span><b>{formatTokenUnits(snapshot.totalSupply)} TRӾ</b></article>
        <article><span>Owner wallet balance</span><b>{formatTokenUnits(snapshot.ownerBalance)} TRӾ</b></article>
        <article><span>Owner issuance</span><b>{snapshot.mintingEnabled ? 'Enabled' : 'Disabled'}</b></article>
        <article><span>Transfers</span><b>{snapshot.paused ? 'Paused' : 'Active'}</b></article>
        <article><span>Owner TRX for fees</span><b>{formatTokenUnits(snapshot.ownerTrx)} TRX</b></article>
      </div> : <p>Refresh the deployed contract to read its current Mainnet state.</p>}
      {snapshot && <div className="trax-checks"><span className={snapshot.valid ? 'ok' : 'bad'}>{snapshot.valid ? '✓' : '!'} TRӾ / TRX / 6 decimals</span><span className={snapshot.ownerValid ? 'ok' : 'bad'}>{snapshot.ownerValid ? '✓' : '!'} Owner matches connected wallet</span><span className="bad">! No TRX backing or redemption</span></div>}
    </div>

    <div className="trax-actions">
      <h3>Owner authorization controls</h3>
      <div className="button-row"><button type="button" className="primary-button" disabled={!walletReady || busy || !tokenAddress || (snapshot?.mintingEnabled && !snapshot?.paused)} onClick={activate}><ShieldCheck size={15}/> Unpause &amp; enable owner minting</button><button type="button" className="outline-button" disabled={!walletReady || busy || !tokenAddress || !snapshot?.mintingEnabled} onClick={disableMinting}>Disable minting</button><button type="button" className="outline-button" disabled={!walletReady || busy || !tokenAddress || snapshot?.paused} onClick={pause}>Emergency pause</button></div>
      <p className="fine-print">Only the on-chain owner can enable or disable minting and pause transfers. Ownership transfer requires the new owner to accept it on-chain.</p>
    </div>

    <div className="trax-actions">
      <h3>External wallet credit manager</h3>
      <label>Recipient TRON Mainnet address<input value={recipient} onChange={e => setRecipient(e.target.value)} autoComplete="off" spellCheck="false"/></label>
      <label>Amount to issue (TRӾ)<input value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal"/></label>
      <div className="trax-balance-note">Raw token units: {(() => { try { return parseTokenUnits(amount) } catch { return '—' } })()}</div>
      <div className="button-row"><button type="button" className="primary-button" disabled={!walletReady || busy || !tokenAddress || !snapshot?.mintingEnabled || snapshot?.paused || !feeCapSun} onClick={issueCredit}><Coins size={15}/> Review &amp; issue credit</button><button type="button" className="outline-button" disabled={!walletReady || busy || !tokenAddress || !feeCapSun} onClick={transfer}>Transfer existing balance</button></div>
      <label>Batch credits (one TRON_ADDRESS,AMOUNT per line; maximum 50)<textarea value={batchInput} onChange={e => setBatchInput(e.target.value)} rows={5} placeholder={'TAddressOne,100\nTAddressTwo,250'}/></label>
      <button type="button" className="outline-button" disabled={!walletReady || busy || !tokenAddress || !snapshot?.mintingEnabled || snapshot?.paused || !feeCapSun || !batchInput.trim()} onClick={batchCredit}>Review &amp; batch-credit addresses</button>
      <p className="fine-print">Issue credit mints new TRӾ directly to the entered address and records an on-chain reference event. It does not require the recipient to have an existing TRӾ balance. This cannot force an exchange to recognize or credit its internal customer account; the exchange must explicitly support this exact TRON contract address and network.</p>
    </div>

    <div className="trax-actions">
      <h3>Check any external wallet balance</h3>
      <label>TRON address<input value={lookupAddress} onChange={e => setLookupAddress(e.target.value)} autoComplete="off" spellCheck="false"/></label>
      <button type="button" className="secondary-button" disabled={!walletReady || busy || !tokenAddress} onClick={readBalance}>Read on-chain TRӾ balance</button>
      {lookupBalance !== '' && <div className="trax-recipient-result"><b>{formatTokenUnits(lookupBalance)} TRӾ</b><span>{lookupAddress}</span></div>}
    </div>

    {lastTx && <div className="notice notice-success"><CheckCircle2 size={16}/><div><b>Solidified Mainnet transaction verified</b><p>{lastTx}</p><a href={'https://tronscan.org/#/transaction/' + lastTx} target="_blank" rel="noreferrer">Open transaction on TRONSCAN <ExternalLink size={12}/></a></div></div>}
    <div className="trax-footer-links"><a href="https://developers.tron.network/docs/trc20-protocol-interface" target="_blank" rel="noreferrer">TRON TRC-20 standard <ExternalLink size={12}/></a><a href="https://tronscan.org/#/token20" target="_blank" rel="noreferrer">TRONSCAN token directory <ExternalLink size={12}/></a></div>
  </section>
}
