export const MAINNET_ACTION_CONTROLS_KEY = 'tron-transfer:mainnet-action-controls:v1'

export const MAINNET_ACTIONS = Object.freeze([
  { id: 'deploymentExecution', label: 'Deployment execution', description: 'Allow the deployment workflow to prepare and request a TronLink approval.' },
  { id: 'resourceClaims', label: 'Resource claims', description: 'Allow an explicit TEnergy promotional eligibility and claim attempt.' },
  { id: 'walletSigning', label: 'Wallet signing requests', description: 'Allow the app to request signatures through the connected TronLink wallet.' },
  { id: 'transactionBroadcast', label: 'Transaction broadcasting', description: 'Allow validated signed transactions to be submitted to TRON Mainnet.' },
])

export const MAINNET_ACTION_DEFAULTS = Object.freeze(Object.fromEntries(MAINNET_ACTIONS.map(({ id }) => [id, true])))

export function readMainnetActionControls(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(MAINNET_ACTION_CONTROLS_KEY) || '{}')
    return Object.fromEntries(MAINNET_ACTIONS.map(({ id }) => [id,
      typeof parsed?.[id] === 'boolean' ? parsed[id] : MAINNET_ACTION_DEFAULTS[id],
    ]))
  } catch {
    return { ...MAINNET_ACTION_DEFAULTS }
  }
}

export function writeMainnetActionControls(value, storage = globalThis.localStorage) {
  const safe = Object.fromEntries(MAINNET_ACTIONS.map(({ id }) => [id, value?.[id] === true]))
  try { storage?.setItem(MAINNET_ACTION_CONTROLS_KEY, JSON.stringify(safe)) } catch {}
  return safe
}

export function assertMainnetActionEnabled(action, storage = globalThis.localStorage) {
  if (!Object.hasOwn(MAINNET_ACTION_DEFAULTS, action)) throw new Error('Unknown Mainnet action control: ' + String(action))
  if (!readMainnetActionControls(storage)[action]) {
    throw new Error('This Mainnet action is disabled in Owner Settings (' + action + '). Enable it before continuing. Security preflight and TronLink approval remain mandatory.')
  }
  return true
}
