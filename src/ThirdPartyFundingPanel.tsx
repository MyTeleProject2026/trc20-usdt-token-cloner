import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, FileCheck2, RefreshCw, ShieldCheck, XCircle } from 'lucide-react'

type FundingDeposit = {
  transactionHash: string
  asset: 'USDT' | 'TRX'
  senderAddress: string
  recipientAddress: string
  amountBaseUnits: string
  blockNumber: number
  chainVerifiedAt: string
  fireblocksVerifiedAt?: string | null
  fireblocksSnapshotId?: string | null
  fireblocksVaultAccountId?: string | null
}

type FundingAuthorization = {
  authorizationId: string
  sponsorAddress: string
  vaultAddress: string
  agreementReference: string
  issuedAt: string
  expiresAt: string
  status: string
  createdAt: string
  deposits?: FundingDeposit[]
}

type Props = {
  apiBase: string
  sessionToken: string
  inventoryVerified: boolean
  inventoryCheckedAt?: string | null
}

function prettyUnits(value: string, decimals: number) {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return value
  const digits = value.padStart(decimals + 1, '0')
  const whole = digits.slice(0, -decimals)
  const fraction = digits.slice(-decimals).replace(/0+$/, '')
  return fraction ? whole + '.' + fraction : whole
}

export default function ThirdPartyFundingPanel({
  apiBase,
  sessionToken,
  inventoryVerified,
  inventoryCheckedAt,
}: Props) {
  const [authorizations, setAuthorizations] = useState<FundingAuthorization[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [manifestText, setManifestText] = useState('')
  const [agreementAcknowledged, setAgreementAcknowledged] = useState(false)
  const [asset, setAsset] = useState<'USDT' | 'TRX'>('USDT')
  const [transactionHash, setTransactionHash] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const request = useCallback(async (path: string, method = 'GET', body?: unknown) => {
    if (!sessionToken || !/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) {
      throw new Error('Sign the owner treasury check first. A current Mainnet owner session is required.')
    }
    const response = await fetch(apiBase + '/api/treasury/third-party-funding' + path, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer ' + sessionToken,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
    })
    const payload = await response.json().catch(() => null)
    if (response.status === 202 && payload?.status === 'awaiting-solidification') return payload
    if (!response.ok || payload?.success !== true) {
      throw new Error(typeof payload?.error === 'string'
        ? payload.error.replaceAll('-', ' ')
        : 'Third-party funding API request failed.')
    }
    return payload
  }, [apiBase, sessionToken])

  const loadAuthorizations = useCallback(async () => {
    setBusy('load')
    setError('')
    try {
      const payload = await request('/authorizations')
      const list = Array.isArray(payload.authorizations) ? payload.authorizations as FundingAuthorization[] : []
      const nextId = list.some(item => item.authorizationId === selectedId)
        ? selectedId : list[0]?.authorizationId || ''
      let enriched = list
      if (nextId) {
        try {
          const detail = await request('/authorizations/' + encodeURIComponent(nextId))
          enriched = list.map(item => item.authorizationId === nextId
            ? { ...item, ...(detail.authorization || {}), deposits: Array.isArray(detail.deposits) ? detail.deposits : [] }
            : item)
        } catch {
          enriched = list
        }
      }
      setAuthorizations(enriched)
      setSelectedId(nextId)
      setNotice(list.length ? 'Authorization records loaded from the backend ledger.' : 'No third-party funding authorization has been registered.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load funding authorizations.')
    } finally {
      setBusy('')
    }
  }, [request])

  useEffect(() => {
    if (!sessionToken) {
      setAuthorizations([])
      setSelectedId('')
      setNotice('')
      return
    }
    void loadAuthorizations()
  }, [sessionToken, loadAuthorizations])

  const selected = authorizations.find(item => item.authorizationId === selectedId) || null

  async function registerAuthorization() {
    setBusy('register')
    setError('')
    setNotice('')
    try {
      let manifest: unknown
      try {
        manifest = JSON.parse(manifestText)
      } catch {
        throw new Error('The signed authorization manifest must be valid JSON.')
      }
      const payload = await request('/authorizations', 'POST', {
        manifest,
        agreementReviewAcknowledged: agreementAcknowledged,
      })
      setSelectedId(String(payload.authorizationId || ''))
      setManifestText('')
      setAgreementAcknowledged(false)
      setNotice('Signed incoming-deposit consent recorded. It does not authorize a withdrawal or prove that funds were deposited.')
      await loadAuthorizations()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not register the funding authorization.')
    } finally {
      setBusy('')
    }
  }

  async function recordChainDeposit() {
    if (!selectedId) return
    if (!/^[0-9a-f]{64}$/i.test(transactionHash.trim())) {
      setError('Enter the 64-character transaction ID returned by the TRON network.')
      return
    }
    setBusy('chain')
    setError('')
    setNotice('')
    try {
      const payload = await request('/authorizations/' + encodeURIComponent(selectedId) + '/deposits', 'POST', {
        asset,
        transactionHash: transactionHash.trim().toLowerCase(),
      })
      setNotice(payload.status === 'awaiting-solidification'
        ? 'The transaction is not solidified yet. No deposit was recorded.'
        : 'Solidified chain evidence recorded. Run the manual Fireblocks read-only inventory workflow again, then reconcile the new snapshot below.')
      if (payload.success === true) setTransactionHash('')
      await loadAuthorizations()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Chain deposit verification failed.')
    } finally {
      setBusy('')
    }
  }

  async function reconcileFireblocks() {
    if (!selectedId) return
    const recordedHash = transactionHash.trim()
      || selected?.deposits?.find(item => item.asset === asset && !item.fireblocksVerifiedAt)?.transactionHash
      || selected?.deposits?.find(item => item.asset === asset)?.transactionHash
      || ''
    if (!/^[0-9a-f]{64}$/i.test(recordedHash)) {
      setError('Select a chain-confirmed deposit or enter its recorded 64-character transaction ID.')
      return
    }
    setBusy('fireblocks')
    setError('')
    setNotice('')
    try {
      const payload = await request('/authorizations/' + encodeURIComponent(selectedId) + '/deposits/fireblocks-reconcile', 'POST', {
        asset,
        transactionHash: recordedHash.toLowerCase(),
      })
      setNotice('Deposit reconciled against verified Fireblocks and TRON inventory. This is not payout authorization.')
      setTransactionHash('')
      await loadAuthorizations()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Fireblocks inventory reconciliation failed.')
    } finally {
      setBusy('')
    }
  }

  async function revokeAuthorization() {
    if (!selectedId || !selected || selected.status === 'revoked') return
    const confirmed = window.confirm('Revoke this funding consent? No further deposit evidence will be accepted for this authorization.')
    if (!confirmed) return
    setBusy('revoke')
    setError('')
    setNotice('')
    try {
      await request('/authorizations/' + encodeURIComponent(selectedId) + '/revoke', 'POST', {})
      setNotice('Funding authorization revoked and recorded in the audit ledger.')
      await loadAuthorizations()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Authorization revocation failed.')
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="wallet-vault-transfer-section" aria-labelledby="third-party-funding-heading">
      <div className="wallet-vault-panel-head">
        <span className="wallet-vault-step"><ShieldCheck size={16} /></span>
        <div>
          <h3 id="third-party-funding-heading">Third-party funding authorization</h3>
          <p>Register scoped source-wallet consent and reconcile genuine incoming deposits to this Fireblocks vault.</p>
        </div>
      </div>

      <div className="wallet-vault-transfer-warning" role="note">
        <strong><AlertTriangle size={15} /> External authorization is still required</strong>
        <p>A public address or watch-only balance is not permission to use funds. Only the source wallet's legitimate owner can sign the exact manifest. The organization must also have a separate written funding agreement and authority review.</p>
        <p>This panel never asks for private keys, recovery phrases, wallet passwords, or Fireblocks credentials. It does not create a transaction from the source wallet and never enables withdrawals.</p>
      </div>

      {!sessionToken && <p className="wallet-vault-risk-note" role="status">Sign the owner treasury check above to open the owner-only authorization ledger.</p>}
      {sessionToken && <>
        <div className="wallet-vault-review-grid">
          <div>
            <small>Current Fireblocks inventory</small>
            <strong>{inventoryVerified ? 'Verified read-only snapshot' : 'No verified snapshot available'}</strong>
          </div>
          <div>
            <small>Inventory checked</small>
            <strong>{inventoryCheckedAt ? new Date(inventoryCheckedAt).toLocaleString() : 'Not verified'}</strong>
          </div>
          <div>
            <small>Funding consent status</small>
            <strong>{authorizations.length ? authorizations.length + ' registered record(s)' : 'No source authorized'}</strong>
          </div>
          <div>
            <small>Payout execution</small>
            <strong>Disabled in this build</strong>
          </div>
        </div>

        <div className="wallet-vault-form">
          <h4>Register a source owner's signed consent</h4>
          <p className="wallet-vault-caption">Paste the complete signed JSON manifest produced using the CLI instructions. Register only after the actual source owner has signed the exact message and the written organization agreement has been reviewed.</p>
          <label htmlFor="third-party-funding-manifest">Signed authorization manifest (JSON)</label>
          <textarea
            id="third-party-funding-manifest"
            rows={8}
            spellCheck={false}
            autoComplete="off"
            value={manifestText}
            onChange={event => setManifestText(event.target.value)}
            placeholder='{"format":"tron-token-studio/third-party-funding-authorization/v1", ...}'
          />
          <label className="wallet-vault-check-row" htmlFor="third-party-funding-agreement">
            <input
              id="third-party-funding-agreement"
              type="checkbox"
              checked={agreementAcknowledged}
              onChange={event => setAgreementAcknowledged(event.target.checked)}
            />
            I have independently reviewed the separate written agreement and confirmed the source organization's authority.
          </label>
          <button
            type="button"
            className="wallet-vault-primary"
            disabled={busy !== '' || !manifestText.trim() || !agreementAcknowledged || !inventoryVerified}
            onClick={() => void registerAuthorization()}
          >
            <FileCheck2 size={16} /> {busy === 'register' ? 'Verifying and registering…' : 'Verify signed consent & register'}
          </button>
          {!inventoryVerified && <p className="wallet-vault-risk-note">Registration is blocked until the backend has a recent verified Fireblocks inventory snapshot for the configured vault.</p>}
        </div>

        <div className="wallet-vault-form">
          <div className="wallet-vault-section-title">
            <div><h4>Registered authorizations</h4><p>Only records saved in the backend ledger appear here.</p></div>
            <button type="button" className="wallet-vault-secondary" disabled={busy !== ''} onClick={() => void loadAuthorizations()}>
              <RefreshCw size={15} /> {busy === 'load' ? 'Loading…' : 'Refresh'}
            </button>
          </div>
          {authorizations.length === 0
            ? <p className="wallet-vault-caption">No authorization is registered. The previously identified watch-only address remains unauthorized.</p>
            : <div className="wallet-vault-token-list">
              {authorizations.map(item => (
                <button
                  type="button"
                  key={item.authorizationId}
                  className={'wallet-vault-wallet-choice' + (selectedId === item.authorizationId ? ' is-selected' : '')}
                  onClick={() => { setSelectedId(item.authorizationId); setTransactionHash('') }}
                >
                  <span className="wallet-vault-wallet-details">
                    <strong>{item.authorizationId}</strong>
                    <small>{item.sponsorAddress} · {item.agreementReference}</small>
                  </span>
                  <span className="wallet-vault-choice-status">{item.status}</span>
                </button>
              ))}
            </div>}
        </div>

        {selected && <div className="wallet-vault-form">
          <h4>Selected authorization</h4>
          <div className="wallet-vault-review-grid">
            <div className="wallet-vault-review-wide"><small>Authorized source address</small><strong>{selected.sponsorAddress}</strong></div>
            <div className="wallet-vault-review-wide"><small>Fireblocks vault recipient</small><strong>{selected.vaultAddress}</strong></div>
            <div><small>Agreement reference</small><strong>{selected.agreementReference}</strong></div>
            <div><small>Status</small><strong>{selected.status}</strong></div>
            <div><small>Expires</small><strong>{new Date(selected.expiresAt).toLocaleString()}</strong></div>
          </div>
          <h4>Recorded deposit evidence</h4>
          {!selected.deposits?.length
            ? <p className="wallet-vault-caption">No solidified deposit evidence has been recorded for this authorization.</p>
            : <div className="wallet-vault-token-list">
              {selected.deposits.map(item => (
                <div className="wallet-vault-token-row" key={item.asset + item.transactionHash}>
                  <div className="wallet-vault-token-info">
                    <strong>{item.asset} · {prettyUnits(item.amountBaseUnits, 6)}</strong>
                    <small>{item.transactionHash}</small>
                    <small>{item.fireblocksVerifiedAt ? 'Fireblocks inventory verified · snapshot ' + item.fireblocksSnapshotId : 'Chain confirmed; awaiting Fireblocks inventory reconciliation'}</small>
                    <button type="button" className="wallet-vault-secondary" disabled={busy !== '' || Boolean(item.fireblocksVerifiedAt)} onClick={() => { setAsset(item.asset); setTransactionHash(item.transactionHash) }}>
                      {item.fireblocksVerifiedAt ? 'Inventory already reconciled' : 'Select this deposit for reconciliation'}
                    </button>
                  </div>
                  {item.fireblocksVerifiedAt ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
                </div>
              ))}
            </div>}

          <h4>Reconcile an incoming deposit</h4>
          <p className="wallet-vault-caption">After the authorized source owner manually transfers funds, submit the transaction ID for independent SolidityNode verification. This route does not sign or broadcast anything.</p>
          <label htmlFor="third-party-funding-asset">Asset</label>
          <select id="third-party-funding-asset" value={asset} onChange={event => setAsset(event.target.value as 'USDT' | 'TRX')}>
            <option value="USDT">Official TRON USDT</option>
            <option value="TRX">Native TRX</option>
          </select>
          <label htmlFor="third-party-funding-txid">Confirmed TRON transaction ID</label>
          <input
            id="third-party-funding-txid"
            autoComplete="off"
            spellCheck={false}
            value={transactionHash}
            onChange={event => setTransactionHash(event.target.value.trim())}
            placeholder="64-character transaction ID"
          />
          <div className="wallet-vault-wallet-actions">
            <button type="button" className="wallet-vault-primary" disabled={busy !== '' || !transactionHash.trim() || selected.status === 'revoked'} onClick={() => void recordChainDeposit()}>
              {busy === 'chain' ? 'Checking solidified chain evidence…' : 'Verify incoming chain deposit'}
            </button>
            <button type="button" className="wallet-vault-secondary" disabled={busy !== '' || !transactionHash.trim() || !inventoryVerified || selected.status === 'revoked'} onClick={() => void reconcileFireblocks()}>
              {busy === 'fireblocks' ? 'Checking Fireblocks inventory…' : 'Reconcile latest Fireblocks inventory'}
            </button>
          </div>
          <p className="wallet-vault-caption">The Fireblocks reconciliation step must use a fresh inventory workflow run performed after the deposit. It verifies available provider and chain balances; it does not certify exchange credit or authorize payouts.</p>
          <button type="button" className="wallet-vault-secondary" disabled={busy !== '' || selected.status === 'revoked'} onClick={() => void revokeAuthorization()}>
            {busy === 'revoke' ? 'Revoking…' : 'Revoke this funding authorization'}
          </button>
        </div>}
      </>}

      {error && <p className="wallet-vault-risk-note" role="alert"><XCircle size={15} /> {error}</p>}
      {notice && <p className="wallet-vault-caption" role="status">{notice}</p>}
    </section>
  )
}
