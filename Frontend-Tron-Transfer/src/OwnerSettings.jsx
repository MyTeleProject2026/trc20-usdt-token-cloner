import { LockKeyhole, ShieldCheck, SlidersHorizontal, Wallet, Zap, Radio, Rocket, Coins, ArrowLeftRight, PauseCircle, Users, History, Search } from 'lucide-react'

export const DEFAULT_OWNER_FEATURES = Object.freeze({ home: true, portfolio: true, deploy: true, issuance: true, credits: true, batch: true, pause: true, minting: true, transfers: true, ownership: true, history: true, balance: true })
const STORAGE_KEY = 'tron-transfer-owner-features-v1'
const FEATURES = [
  { id: 'home', label: 'AETHERIA monitoring', detail: 'Runtime mesh, API health and Mainnet resource telemetry', icon: Radio },
  { id: 'portfolio', label: 'Owner portfolio', detail: 'TRX, TRӾ and official USDT balances and reference values', icon: Wallet },
  { id: 'deploy', label: 'Contract deployment & verification', detail: 'TRӾ Mainnet deployment, preflight and bytecode verification', icon: Rocket },
  { id: 'issuance', label: 'Owner issuance', detail: 'Issue TRӾ to the configured owner wallet', icon: Coins },
  { id: 'credits', label: 'External credits', detail: 'Issue TRӾ to one external Mainnet address', icon: Users },
  { id: 'batch', label: 'Batch credits', detail: 'Issue credits to up to 50 recipient addresses', icon: SlidersHorizontal },
  { id: 'transfers', label: 'Token transfers', detail: 'Transfer existing TRӾ held by the owner wallet', icon: ArrowLeftRight },
  { id: 'pause', label: 'Emergency pause', detail: 'Pause or resume token transfers on-chain', icon: PauseCircle },
  { id: 'minting', label: 'Minting authorization', detail: 'Enable or disable owner issuance on-chain', icon: ShieldCheck },
  { id: 'ownership', label: 'Ownership transfer', detail: 'Two-step owner handoff', icon: LockKeyhole },
  { id: 'history', label: 'Credit history', detail: 'Read confirmed OwnerCredit events', icon: History },
  { id: 'balance', label: 'External balance lookup', detail: 'Read TRӾ balances for external Mainnet addresses', icon: Search },
]

export function loadOwnerFeatures() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}')
    return Object.fromEntries(Object.keys(DEFAULT_OWNER_FEATURES).map(id => [id, saved[id] === false ? false : true]))
  } catch { return { ...DEFAULT_OWNER_FEATURES } }
}

export default function OwnerSettings({ features = DEFAULT_OWNER_FEATURES, onChange }) {
  const setFeature = (id, enabled) => onChange(previous => ({ ...previous, [id]: enabled }))
  const enabledCount = FEATURES.filter(item => features[item.id] !== false).length
  return <section className="owner-settings">
    <header className="owner-settings-hero">
      <span className="owner-settings-kicker"><SlidersHorizontal size={14}/> TRON TRANSFER · OWNER CONTROL</span>
      <h2>Owner Settings</h2>
      <p>Enable or disable workspace features individually. Disabled features are hidden from navigation and cannot be opened in this browser. These switches do not change smart-contract state or grant network resources.</p>
      <div className="owner-settings-summary"><b>{enabledCount} / {FEATURES.length} features enabled</b><span>Preferences are saved locally in this browser.</span></div>
    </header>
    <div className="owner-settings-grid">
      {FEATURES.map(item => { const Icon = item.icon; const enabled = features[item.id] !== false; return <article className="owner-setting-row" key={item.id}>
        <span className="owner-setting-icon"><Icon size={18}/></span>
        <span className="owner-setting-copy"><b>{item.label}</b><small>{item.detail}</small><em>{enabled ? 'Enabled in workspace' : 'Disabled in workspace'}</em></span>
        <label className="owner-switch" aria-label={item.label + (enabled ? ' enabled' : ' disabled')}>
          <input type="checkbox" checked={enabled} onChange={event => setFeature(item.id, event.target.checked)}/><span className="owner-switch-track"/>
        </label>
      </article> })}
    </div>
    <section className="owner-settings-locked">
      <div><LockKeyhole size={18}/><b>Security controls — always enforced</b></div>
      <ul>
        <li>TRON Mainnet only; configured owner wallet remains the transaction owner and fee payer.</li>
        <li>TronLink must separately approve every message signature or contract transaction.</li>
        <li>Zero-TRX-burn preflight remains mandatory. No switch can permit a TRX fee fallback.</li>
        <li>Energy and Bandwidth are counted only after live Mainnet resource reads; provider offers are not assumed.</li>
        <li>Signing, broadcast and solidified-receipt verification remain separate required stages.</li>
        <li>On-chain pause, minting authorization and ownership state can only be changed by valid owner transactions.</li>
      </ul>
      <p><Zap size={14}/> Energy / Bandwidth provider selection and paid TRX funding cannot be changed by a local UI preference. They require a verified provider integration or an owner-approved wallet transaction.</p>
    </section>
  </section>
}