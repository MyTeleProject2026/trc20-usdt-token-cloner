import { MAINNET_ACTIONS, readMainnetActionControls, writeMainnetActionControls } from './mainnet-action-controls.mjs'
import { useState } from 'react'

export default function OwnerSettings() {
  const [controls, setControls] = useState(() => readMainnetActionControls())
  function update(id, enabled) {
    setControls(current => writeMainnetActionControls({ ...current, [id]: enabled }))
  }
  return <section className="trax-panel" aria-labelledby="owner-settings-title">
    <div className="trax-section-heading">
      <div><span className="trax-kicker">TRON MAINNET · LOCAL ACTION PERMISSIONS</span><h2 id="owner-settings-title">Owner action controls</h2>
      <p>Individually allow or block sensitive application actions. These switches are local workspace controls, not blockchain permissions or resource grants.</p></div>
    </div>
    <div className="trax-settings-list">
      {MAINNET_ACTIONS.map(action => <label className="trax-settings-row" key={action.id}>
        <span><strong>{action.label}</strong><small>{action.description}</small></span>
        <input type="checkbox" role="switch" checked={controls[action.id]} onChange={event => update(action.id, event.target.checked)} aria-label={action.label}/>
      </label>)}
    </div>
    <div className="trax-state-banner">
      <b>Non-bypassable Mainnet safeguards</b>
      <span>These switches cannot override owner/network matching, live Energy and Bandwidth checks, zero-TRX-burn policy, fee limits, transaction integrity, TronLink approval, solidified receipts or contract verification. Turning signing or broadcasting off blocks the corresponding operation; turning it on only permits the normal checks to run.</span>
    </div>
    <p className="trax-settings-note">Resource acquisition remains conditional on an actual provider offer, owner eligibility and confirmed on-chain delegation. No free Energy, Bandwidth sponsorship or TRX balance is created by enabling a switch.</p>
  </section>
}
