import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowUpRight, CheckCircle2, Coins, ExternalLink, RefreshCw, Rocket, ShieldCheck, Wallet } from 'lucide-react'
import {
  TRAX_TOKEN_ARTIFACT, addressesEqual, assertMainnetWallet, deployContractFromTronLink,
  callMainnetView, formatTokenUnits, getMainnetNativeBalance, loadSavedContracts, parseBatchCreditRows, parseTokenUnits, saveContractAddresses,
  sendAndVerifyContractCall, verifyTRAXTokenContract, getMainnetUSDTBalance,
} from './trax-mainnet.mjs'
import { calculatePortfolioValue, fetchTRXReferencePrice } from './trax-pricing.mjs'
import TRAXOwnershipControls from './TRAXOwnershipControls.jsx'
import TRAXCreditHistory from './TRAXCreditHistory.jsx'
import './trax-mainnet.css'

const EXPECTED_OWNER_ADDRESS = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const DEFAULT_RECIPIENT = ''
const DEFAULT_FEE_CAP = '150'

function makeReference() {
  const bytes = new Uint8Array(32)
  window.crypto.getRandomValues(bytes)
  return '0x' + Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
}

function TraxTokenMark() { return <img className="trax-token-mark" src="https://thesvg.org/icons/tron/default.svg" alt="TRӾ token icon" width="22" height="22" loading="lazy"/> }

function formatUsd(value) { return Number.isFinite(Number(value)) ? '$' + Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'Unavailable' }

function shorten(value) {
  return value && value.length > 18 ? value.slice(0, 10) + '…' + value.slice(-7) : value || '—'
}

export default function TRXMainnetPanel({ wallet, onConnect, activePage = 'overview', onNavigate }) {
  const initial = useMemo(() => loadSavedContracts(), [])
  const [tokenAddress, setTokenAddress] = useState(initial.tokenAddress)
  const [snapshot, setSnapshot] = useState(null)
  const [recipient, setRecipient] = useState(DEFAULT_RECIPIENT)
  const [amount, setAmount] = useState('100')
  const [ownerIssueAmount, setOwnerIssueAmount] = useState('100')
  const [batchInput, setBatchInput] = useState('')
  const [lookupAddress, setLookupAddress] = useState(DEFAULT_RECIPIENT)
  const [lookupBalance, setLookupBalance] = useState('')
  const [lookupNativeBalance, setLookupNativeBalance] = useState('')
  const [lookupUsdtBalance, setLookupUsdtBalance] = useState('')
  const [lookupPortfolioValue, setLookupPortfolioValue] = useState(null)
  const [referencePrice, setReferencePrice] = useState(null)
  const [feeCap, setFeeCap] = useState(DEFAULT_FEE_CAP)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [lastTx, setLastTx] = useState('')
  const [step, setStep] = useState('')

  useEffect(() => {
    try { saveContractAddresses({ tokenAddress }) } catch {}
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
    const token = await verifyTRAXTokenContract(tronWeb, tokenAddress)
    return { tronWeb, token }
  }, [wallet, tokenAddress])

  const assertOwner = useCallback(async (token, tronWeb) => {
    const owner = await callMainnetView(token.owner())
    if (!addressesEqual(tronWeb, owner, connectedAddress)) throw new Error('Connected TronLink wallet is not the on-chain TRӾ owner.')
    return owner
  }, [connectedAddress])

  const refresh = () => run('Reading TRON Mainnet token state', async () => {
    const { tronWeb, token } = await getToken()
    const [owner, name, symbol, decimals, totalSupply, paused, mintingEnabled, ownerBalance, ownerTrx, ownerUsdt] = await Promise.all([
      callMainnetView(token.owner()), callMainnetView(token.name()), callMainnetView(token.symbol()), callMainnetView(token.decimals()),
      callMainnetView(token.totalSupply()), callMainnetView(token.paused()), callMainnetView(token.mintingEnabled()),
      callMainnetView(token.balanceOf(connectedAddress)), getMainnetNativeBalance(tronWeb, connectedAddress),
      getMainnetUSDTBalance(tronWeb, connectedAddress),
    ])
    const livePrice = await fetchTRXReferencePrice().catch(() => null)
    setReferencePrice(livePrice)
    const valid = name === 'TRӾ' && symbol === 'TRӾ' && Number(decimals) === 6
    const ownerValid = addressesEqual(tronWeb, owner, connectedAddress)
    const next = {
      owner: String(owner), name, symbol, decimals: Number(decimals), totalSupply: String(totalSupply),
      paused: Boolean(paused), mintingEnabled: Boolean(mintingEnabled), ownerBalance: String(ownerBalance),
      ownerTrx: String(ownerTrx), ownerUsdt: String(ownerUsdt), valid, ownerValid,
    }
    setSnapshot(next)
    if (!valid) throw new Error('Token metadata mismatch. Expected TRӾ / TRӾ / 6 decimals.')
    if (!ownerValid) throw new Error('Connected TronLink account is not the token owner.')
    setNotice('Mainnet contract reads succeeded. This is an owner-issued, unbacked token; no reserve or redemption is represented.')
    return next
  })

  const deployToken = () => run('Preparing TRӾ Mainnet deployment · TronLink approval required', async () => {
    if (!walletReady) throw new Error('Connect the configured owner TronLink wallet first.')
    if (!feeCapSun) throw new Error('Enter a valid deployment fee cap between 0.000001 and 500 TRX.')
    if (tokenAddress) throw new Error('A token contract address is already saved. Clear it only if you intend to deploy a new token.')
    const result = await deployContractFromTronLink(wallet, TRAX_TOKEN_ARTIFACT, 'Restricted1TRAX', feeCapSun, { expectedOwnerAddress: EXPECTED_OWNER_ADDRESS })
    setTokenAddress(result.address)
    setLastTx(result.txID)
    setNotice('TRӾ contract deployment is confirmed and the deployed bytecode and owner were verified.')
  })

  const clearSavedTokenAddress = () => {
    setTokenAddress('')
    setSnapshot(null)
    setLookupBalance('')
    setNotice('The saved contract address was cleared from this browser only. No blockchain contract or tokens were changed. You can now deploy a new TRӾ contract.')
    setError('')
  }

  const activate = () => run('Enabling owner issuance · two TronLink approvals', async () => {
    const { tronWeb, token } = await getToken()
    await assertOwner(token, tronWeb)
    const paused = await callMainnetView(token.paused())
    const enabled = await callMainnetView(token.mintingEnabled())
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

  const unpauseTransfers = () => run('Unpausing TRӾ transfers · TronLink approval required', async () => {
    const { tronWeb, token } = await getToken()
    await assertOwner(token, tronWeb)
    if (!await callMainnetView(token.paused())) { setNotice('Transfers are already active.'); return }
    const result = await sendAndVerifyContractCall(tronWeb, token.setPaused(false), feeCapSun, connectedAddress)
    setLastTx(result.txID)
    setNotice('TRӾ transfers are active again.')
    await refresh()
  })

  const enableMinting = () => run('Enabling owner issuance · TronLink approval required', async () => {
    const { tronWeb, token } = await getToken()
    await assertOwner(token, tronWeb)
    if (await callMainnetView(token.mintingEnabled())) { setNotice('Owner issuance is already enabled.'); return }
    const result = await sendAndVerifyContractCall(tronWeb, token.setMintingEnabled(true), feeCapSun, connectedAddress)
    setLastTx(result.txID)
    setNotice('Owner TRӾ issuance has been enabled.')
    await refresh()
  })

  const issueOwnerSupply = () => run('Issuing new TRӾ to the connected owner wallet', async () => {
    const { tronWeb, token } = await getToken()
    await assertOwner(token, tronWeb)
    if (!feeCapSun) throw new Error('Enter a valid transaction fee limit.')
    const units = parseTokenUnits(ownerIssueAmount)
    const [paused, enabled] = await Promise.all([callMainnetView(token.paused()), callMainnetView(token.mintingEnabled())])
    if (paused || !enabled) throw new Error('Token is paused or owner issuance is disabled. Enable minting first.')
    const reference = makeReference()
    const result = await sendAndVerifyContractCall(tronWeb, token.credit(connectedAddress, units, reference), feeCapSun, connectedAddress)
    setLastTx(result.txID)
    setNotice(ownerIssueAmount + ' TRӾ issued to the connected owner wallet. Reference: ' + reference)
    await refresh()
  })

  const issueCredit = () => run('Preparing owner credit to external TRON address', async () => {
    const { tronWeb, token } = await getToken()
    await assertOwner(token, tronWeb)
    if (!tronWeb.isAddress(recipient.trim())) throw new Error('Enter a valid TRON Mainnet recipient address.')
    if (!feeCapSun) throw new Error('Enter a valid transaction fee cap.')
    const units = parseTokenUnits(amount)
    const [paused, enabled] = await Promise.all([callMainnetView(token.paused()), callMainnetView(token.mintingEnabled())])
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
    const [paused, enabled] = await Promise.all([callMainnetView(token.paused()), callMainnetView(token.mintingEnabled())])
    if (paused || !enabled) throw new Error('Token is paused or owner issuance is disabled. Activate it first.')
    const result = await sendAndVerifyContractCall(tronWeb, token.batchCredit(recipients, amounts, references), feeCapSun, connectedAddress)
    setLastTx(result.txID)
    setNotice('Batch credit confirmed for ' + recipients.length + ' TRON addresses. Every row has a unique on-chain reference.')
    await refresh()
  })

  const readBalance = () => run('Reading external wallet token balance', async () => {
    const { tronWeb, token } = await getToken()
    if (!tronWeb.isAddress(lookupAddress.trim())) throw new Error('Enter a valid TRON Mainnet address.')
    const [balance, nativeBalance, usdtBalance, livePrice] = await Promise.all([
      callMainnetView(token.balanceOf(lookupAddress.trim())), getMainnetNativeBalance(tronWeb, lookupAddress.trim()),
      getMainnetUSDTBalance(tronWeb, lookupAddress.trim()), fetchTRXReferencePrice().catch(() => null),
    ])
    setLookupBalance(String(balance)); setLookupNativeBalance(String(nativeBalance)); setLookupUsdtBalance(String(usdtBalance))
    setLookupPortfolioValue(livePrice ? calculatePortfolioValue({ trx: formatTokenUnits(nativeBalance), trax: formatTokenUnits(balance), usdt: formatTokenUnits(usdtBalance), prices: livePrice }) : null)
    return balance
  })

  const transfer = () => run('Preparing owner wallet TRӾ transfer', async () => {
    const { tronWeb, token } = await getToken()
    await assertOwner(token, tronWeb)
    if (!tronWeb.isAddress(recipient.trim())) throw new Error('Enter a valid TRON Mainnet recipient address.')
    const units = parseTokenUnits(amount)
    const balance = await callMainnetView(token.balanceOf(connectedAddress))
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

  const show = (...pages) => pages.includes(activePage)

  return <section className="trax-workspace">
    <div className="section-heading">
      <div><span className="eyebrow">TRON TRANSFER · OWNER-ISSUED · MAINNET</span><h2>TRӾ token control center</h2><p>Manage the existing TRӾ TRC-20 contract. Every write is validated and separately approved in TronLink.</p></div>
      <div className="panel-icon" aria-label="TRӾ token"><TraxTokenMark/><small>TRӾ / TRӾ</small></div>
    </div>

    <div className="trax-notice" role="note"><AlertTriangle size={18}/><div><b>OWNER-ISSUED TOKEN · NOT NATIVE TRX</b><p>TRӾ is a custom TRC-20 token without reserves, collateral, guaranteed redemption or a promised market price. Owner issuance can dilute holders. Native TRX and TRӾ are different assets.</p></div></div>

    {!walletReady ? <div className="trax-connect"><p>{connectedAddress ? 'Connected account does not match the configured contract owner (' + EXPECTED_OWNER_ADDRESS + '). Switch accounts in TronLink and reconnect.' : 'Connect the configured owner TronLink wallet on TRON Mainnet to administer the contract.'}</p><button type="button" className="primary-button" onClick={onConnect}><Wallet size={16}/> Connect owner TronLink</button></div> : <div className="trax-wallet-row"><span>Connected owner / transaction fee payer</span><b>{shorten(connectedAddress)}</b><span className="trax-network"><CheckCircle2 size={14}/> TRON Mainnet</span><small>This wallet is the transaction owner. Network fees are never redirected to a different account.</small></div>}

    {error && <div className="notice notice-error" role="alert"><AlertTriangle size={16}/>{error}</div>}
    {notice && <div className="notice notice-success" role="status"><CheckCircle2 size={16}/>{notice}</div>}
    {step && <div className="trax-progress" role="status"><RefreshCw size={15} className="trax-spin"/>{step}</div>}

    <div className="trax-addresses">
      <label>TRӾ Mainnet contract address<input aria-describedby="trax-contract-address-note" value={tokenAddress} onChange={e => setTokenAddress(e.target.value.trim())} placeholder="Enter an existing verified address or deploy a new contract"/></label>
      <p id="trax-contract-address-note" className="fine-print">The contract address identifies the custom token on TRON Mainnet. Verify its on-chain bytecode and metadata before accepting deposits.</p>
      <label>Maximum transaction fee limit (TRX)<input type="number" min="0.000001" max="500" step="1" value={feeCap} onChange={e => setFeeCap(e.target.value)}/></label>
      <p className="fine-print">The fee limit is a network ceiling, not a prepaid fee. Energy and Bandwidth are used first; any shortfall can still burn TRX. Zero-TRX-burn protection remains active, and the application will block signing when its resource preflight detects a shortfall.</p>
      {show('deploy') && <div className="trax-deploy-actions">
        <div className="trax-step-card"><b>Deployment checklist</b><span>1. Confirm the connected owner address.</span><span>2. Review the compiled contract and resource estimate.</span><span>3. Approve the unsigned deployment in TronLink.</span><span>4. Wait for a solidified receipt and bytecode verification.</span></div>
        <div className="button-row"><button type="button" className="primary-button" disabled={!walletReady || busy || Boolean(tokenAddress) || !feeCapSun} onClick={deployToken}><Rocket size={15}/> Deploy TRӾ automatically</button><button type="button" className="outline-button" disabled={!walletReady || busy || !tokenAddress} onClick={refresh}><RefreshCw size={15}/> Verify contract state</button>{Boolean(tokenAddress) && <button type="button" className="outline-button" disabled={busy} onClick={() => { if (window.confirm('Clear only this browser’s saved contract address? This does not delete the on-chain contract.')) clearSavedTokenAddress() }}>Clear saved address</button>}</div>
      </div>}
      {show('overview') && <div className="trax-deploy-actions"><button type="button" className="secondary-button" disabled={!walletReady || busy || !tokenAddress} onClick={refresh}><RefreshCw size={15}/> Refresh Mainnet state</button></div>}
    </div>

    {show('overview') && <>
      <div className="trax-actions trax-portfolio" aria-label="Combined wallet portfolio valuation">
        <h3>Owner wallet portfolio</h3>
        <p className="fine-print">Separate quantities and clearly labelled reference valuations for native TRX, TRӾ and official USDT.</p>
        <div className="trax-stats">
          <article><span>Native TRX</span><b>{snapshot ? formatTokenUnits(snapshot.ownerTrx) : 'Refresh contract state'} TRX</b><small>{referencePrice && snapshot ? formatUsd(Number(formatTokenUnits(snapshot.ownerTrx)) * referencePrice.trxUsd) : 'Live quote unavailable'}</small></article>
          <article><span><TraxTokenMark/> TRӾ reference value</span><b>{snapshot ? formatTokenUnits(snapshot.ownerBalance) : 'Refresh contract state'} TRӾ</b><small>{referencePrice && snapshot ? formatUsd(Number(formatTokenUnits(snapshot.ownerBalance)) * referencePrice.traxReferenceUsd) : 'Live quote unavailable'}</small></article>
          <article><span>Official USDT · TRC20</span><b>{snapshot ? formatTokenUnits(snapshot.ownerUsdt) : 'Refresh contract state'} USDT</b><small>{referencePrice && snapshot ? formatUsd(Number(formatTokenUnits(snapshot.ownerUsdt)) * referencePrice.usdtUsd) : 'Live quote unavailable'}</small></article>
        </div>
        <div className="trax-balance-note"><b>Estimated combined portfolio value: </b>{snapshot && referencePrice ? formatUsd(calculatePortfolioValue({ trx: formatTokenUnits(snapshot.ownerTrx), trax: formatTokenUnits(snapshot.ownerBalance), usdt: formatTokenUnits(snapshot.ownerUsdt), prices: referencePrice })?.totalUsd) : 'Unavailable — refresh when live prices are available'}</div>
        <p className="fine-print">{referencePrice ? 'TRX/USD: ' + formatUsd(referencePrice.trxUsd) + ' · TRӾ owner-defined reference: ' + formatUsd(referencePrice.traxReferenceUsd) + ' · USDT/USD: ' + formatUsd(referencePrice.usdtUsd) + ' · ' + referencePrice.source + ' · ' + new Date(referencePrice.updatedAt).toLocaleString() : 'Live prices unavailable or stale.'} A reference value is not a verified TRӾ exchange market price.</p>
      </div>
      <div className="trax-actions">
        <div className="trax-section-title"><h3>Live on-chain contract status</h3><button className="outline-button" disabled={!walletReady || busy || !tokenAddress} onClick={refresh}><RefreshCw size={14}/> Refresh</button></div>
        {snapshot ? <div className="trax-stats">
          <article><span>Total TRӾ supply</span><b>{formatTokenUnits(snapshot.totalSupply)} TRӾ</b></article>
          <article><span>Owner wallet balance</span><b>{formatTokenUnits(snapshot.ownerBalance)} TRӾ</b></article>
          <article><span>Owner issuance</span><b>{snapshot.mintingEnabled ? 'Enabled' : 'Disabled'}</b></article>
          <article><span>Transfers</span><b>{snapshot.paused ? 'Paused' : 'Active'}</b></article>
        </div> : <p className="fine-print">Refresh the contract to read its current solidified Mainnet state.</p>}
        {snapshot && <div className="trax-checks"><span className={snapshot.valid ? 'ok' : 'bad'}>{snapshot.valid ? '✓' : '!'} {snapshot.name} / {snapshot.symbol} / {snapshot.decimals} decimals</span><span className={snapshot.ownerValid ? 'ok' : 'bad'}>{snapshot.ownerValid ? '✓' : '!'} On-chain owner matches wallet</span><span className="bad">! No backing or redemption</span></div>}
      </div>
    </>}

    {show('issuance') && <div className="trax-actions">
      <h3>Owner issuance overview</h3>
      <div className="trax-stats"><article><span>Total supply</span><b>{snapshot ? formatTokenUnits(snapshot.totalSupply) + ' TRӾ' : 'Not loaded'}</b></article><article><span>Owner authorization</span><b>{snapshot ? snapshot.mintingEnabled ? 'Enabled' : 'Disabled' : 'Not loaded'}</b></article><article><span>Transfer status</span><b>{snapshot ? snapshot.paused ? 'Paused' : 'Active' : 'Not loaded'}</b></article></div>
      <p className="fine-print">Owner issuance can create new TRӾ up to the uint256 supply limit. The limit is finite, and issuing additional supply can dilute holders. Every mint requires Energy and Bandwidth; minting does not require TRX collateral or a reserve deposit.</p>
      <label>Amount to issue to owner wallet (TRӾ)<input value={ownerIssueAmount} onChange={e => setOwnerIssueAmount(e.target.value)} inputMode="decimal"/></label>
      <div className="trax-balance-note">Raw token units (6 decimals): {(() => { try { return parseTokenUnits(ownerIssueAmount) } catch { return '—' } })()}</div>
      <div className="button-row"><button type="button" className="primary-button" disabled={!walletReady || busy || !tokenAddress || !snapshot?.mintingEnabled || snapshot?.paused || !feeCapSun} onClick={issueOwnerSupply}><Coins size={14}/> Issue to my owner wallet</button><button type="button" className="outline-button" disabled={!walletReady || busy || !tokenAddress} onClick={refresh}><RefreshCw size={14}/> Refresh issuance state</button></div>
    </div>}

    {show('credits') && <div className="trax-actions">
      <h3>External wallet credit</h3>
      <p className="fine-print">Mint new TRӾ directly to a valid TRON Mainnet address. Recipient ownership signatures are not needed to receive tokens, but your owner wallet must approve and broadcast the mint transaction.</p>
      <label>Recipient TRON Mainnet address<input value={recipient} onChange={e => setRecipient(e.target.value)} autoComplete="off" spellCheck="false" placeholder="T…"/></label>
      <label>Amount to issue (TRӾ)<input value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" placeholder="100"/></label>
      <div className="trax-balance-note">Raw token units (6 decimals): {(() => { try { return parseTokenUnits(amount) } catch { return '—' } })()}</div>
      <button type="button" className="primary-button" disabled={!walletReady || busy || !tokenAddress || !snapshot?.mintingEnabled || snapshot?.paused || !feeCapSun} onClick={issueCredit}><Coins size={15}/> Review &amp; issue credit</button>
      <p className="fine-print">This credits the recipient's on-chain TRӾ balance. It does not force an exchange to recognize or credit its internal customer account.</p>
    </div>}

    {show('batch') && <div className="trax-actions">
      <h3>Batch wallet credits</h3>
      <p className="fine-print">Issue multiple recipient credits in one contract call. Maximum 50 addresses per batch. Review every address and amount before opening TronLink.</p>
      <label>Recipient list (one TRON_ADDRESS,AMOUNT per line)<textarea value={batchInput} onChange={e => setBatchInput(e.target.value)} rows={7} placeholder={'TAddressOne,100\nTAddressTwo,250'}/></label>
      <div className="trax-balance-note">Maximum 50 rows · Amounts use six token decimals.</div>
      <button type="button" className="primary-button" disabled={!walletReady || busy || !tokenAddress || !snapshot?.mintingEnabled || snapshot?.paused || !feeCapSun || !batchInput.trim()} onClick={batchCredit}>Review &amp; batch-credit addresses</button>
    </div>}

    {show('pause') && <div className="trax-actions">
      <h3>Emergency transfer controls</h3>
      <div className={snapshot?.paused ? 'trax-state-banner warning' : 'trax-state-banner success'}><b>{snapshot ? snapshot.paused ? 'Transfers currently paused' : 'Transfers currently active' : 'Contract state not loaded'}</b><span>{snapshot ? snapshot.paused ? 'Token transfers and owner issuance are blocked until the owner unpauses.' : 'Transfers are available subject to normal TRC-20 balances and allowances.' : 'Refresh contract state before making an emergency change.'}</span></div>
      <div className="button-row"><button type="button" className="primary-button" disabled={!walletReady || busy || !tokenAddress || !snapshot || snapshot.paused || !feeCapSun} onClick={pause}>Emergency pause transfers</button><button type="button" className="outline-button" disabled={!walletReady || busy || !tokenAddress || !snapshot?.paused || !feeCapSun} onClick={unpauseTransfers}>Unpause transfers</button></div>
      <p className="fine-print">Only the current on-chain owner can change pause state. Both actions require a separate TronLink signature and network resources.</p>
    </div>}

    {show('minting') && <div className="trax-actions">
      <h3>Owner minting authorization</h3>
      <div className={snapshot?.mintingEnabled ? 'trax-state-banner success' : 'trax-state-banner warning'}><b>{snapshot ? snapshot.mintingEnabled ? 'Owner issuance enabled' : 'Owner issuance disabled' : 'Contract state not loaded'}</b><span>{snapshot ? snapshot.mintingEnabled ? 'The authorized owner can issue new TRӾ.' : 'New owner credits are blocked until minting is enabled.' : 'Refresh contract state before changing authorization.'}</span></div>
      <div className="button-row"><button type="button" className="primary-button" disabled={!walletReady || busy || !tokenAddress || !snapshot || snapshot.mintingEnabled || !feeCapSun} onClick={enableMinting}>Enable owner minting</button><button type="button" className="outline-button" disabled={!walletReady || busy || !tokenAddress || !snapshot?.mintingEnabled || !feeCapSun} onClick={disableMinting}>Disable owner minting</button></div>
      <p className="fine-print">Disabling minting prevents new issuance but does not destroy existing tokens. Only the on-chain owner can change this setting.</p>
    </div>}

    {show('transfers') && <div className="trax-actions">
      <h3>Transfer existing TRӾ</h3>
      <p className="fine-print">This sends existing TRӾ from the connected owner wallet; it does not mint new supply. The connected owner must hold enough TRӾ, and the transaction needs network resources.</p>
      <label>Recipient TRON Mainnet address<input value={recipient} onChange={e => setRecipient(e.target.value)} autoComplete="off" spellCheck="false" placeholder="T…"/></label>
      <label>Amount to transfer (TRӾ)<input value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal"/></label>
      <button type="button" className="primary-button" disabled={!walletReady || busy || !tokenAddress || !feeCapSun} onClick={transfer}><ArrowUpRight size={15}/> Review &amp; transfer existing balance</button>
    </div>}

    {show('ownership') && <TRAXOwnershipControls wallet={wallet} connectedAddress={connectedAddress} tokenAddress={tokenAddress} feeCapSun={feeCapSun} getToken={getToken} assertOwner={assertOwner} run={run} refresh={refresh} setLastTx={setLastTx} setNotice={setNotice}/>}

    {show('history') && <TRAXCreditHistory wallet={wallet} tokenAddress={tokenAddress} run={run} busy={busy}/>}

    {show('balance') && <div className="trax-actions">
      <h3>External wallet balance lookup</h3>
      <p className="fine-print">Read the contract's actual TRӾ balance for any TRON Mainnet address. This is a read-only contract query; it does not credit or transfer tokens.</p>
      <label>TRON Mainnet address<input value={lookupAddress} onChange={e => setLookupAddress(e.target.value)} autoComplete="off" spellCheck="false" placeholder="T…"/></label>
      <button type="button" className="secondary-button" disabled={!walletReady || busy || !tokenAddress} onClick={readBalance}><RefreshCw size={14}/> Read on-chain TRӾ balance</button>
      {lookupBalance !== '' && <div className="trax-recipient-result"><b>{formatTokenUnits(lookupBalance)} TRӾ</b><span>{lookupAddress}</span><p>Native TRX: {formatTokenUnits(lookupNativeBalance)} · Official USDT: {formatTokenUnits(lookupUsdtBalance)}</p><b>Combined estimated portfolio value: {lookupPortfolioValue ? formatUsd(lookupPortfolioValue.totalUsd) : 'Unavailable — live quote missing or stale'}</b><small>TRӾ valuation is an owner-defined reference only, not a verified market trading price.</small></div>}
    </div>}

    {lastTx && <div className="notice notice-success trax-last-tx"><CheckCircle2 size={16}/><div><b>Solidified Mainnet transaction verified</b><p>{lastTx}</p><a href={'https://tronscan.org/#/transaction/' + lastTx} target="_blank" rel="noreferrer">Open transaction on TRONSCAN <ExternalLink size={12}/></a></div></div>}
    <div className="trax-footer-links"><a href="https://developers.tron.network/docs/trc20-protocol-interface" target="_blank" rel="noreferrer">TRON TRC-20 standard <ExternalLink size={12}/></a><a href="https://tronscan.org/#/token20" target="_blank" rel="noreferrer">TRONSCAN token directory <ExternalLink size={12}/></a></div>
  </section>
}
