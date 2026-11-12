/**
 * Read-only assessment of TRON account permissions.
 *
 * This does not change account permissions or sign transactions. It determines
 * whether any single configured key can authorize native-value movement or
 * permission changes under the solidified account permission state.
 */
import { TronWeb } from 'tronweb'

const VALUE_OR_PERMISSION_CONTROL_CONTRACT_TYPES = Object.freeze([1, 2, 11, 12, 13, 14, 30, 31, 46, 54, 55, 56, 57, 58, 59])
const HEX_32_BYTES = /^[0-9a-f]{64}$/i

function safeInteger(value) {
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

function validPermission(permission, kind) {
  if (!permission || typeof permission !== 'object') return null
  const threshold = safeInteger(permission.threshold)
  const keys = Array.isArray(permission.keys) ? permission.keys : []
  if (threshold === null || threshold < 1 || keys.length === 0) return null
  const normalizedKeys = keys.map((key) => {
    const address = String(key?.address || '')
    if (!TronWeb.isAddress(address)) return { address: '', normalizedAddress: '', weight: null }
    return {
      address,
      normalizedAddress: TronWeb.address.toHex(address).toLowerCase(),
      weight: safeInteger(key?.weight),
    }
  })
  if (normalizedKeys.some((key) => !key.normalizedAddress || key.weight === null || key.weight < 1)) return null
  if (new Set(normalizedKeys.map((key) => key.normalizedAddress)).size !== normalizedKeys.length) return null
  let operations = null
  if (kind === 'active') {
    const raw = String(permission.operations || '').replace(/^0x/i, '').toLowerCase()
    if (!HEX_32_BYTES.test(raw)) return null
    operations = raw
  }
  return { threshold, keys: normalizedKeys, operations }
}

function anySingleKeyMeetsThreshold(keys, threshold) {
  return keys.some((key) => key.weight >= threshold)
}

function operationAllowed(bitmap, contractType) {
  const byteOffset = Math.floor(contractType / 8) * 2
  const bitOffset = contractType % 8
  const byte = Number.parseInt(bitmap.slice(byteOffset, byteOffset + 2), 16)
  return Number.isInteger(byte) && (byte & (1 << bitOffset)) !== 0
}

export function assessTronAccountPermissions(account) {
  const owner = validPermission(account?.owner_permission, 'owner')
  const activeInput = Array.isArray(account?.active_permission) ? account.active_permission : null
  if (!owner || !activeInput || activeInput.length === 0) {
    return Object.freeze({
      available: false,
      verifiedAgainstSolidifiedState: true,
      restrictedAgainstSingleKey: false,
      singleSignerCanMoveNativeTrx: null,
      reason: 'permission-data-missing-or-invalid',
      note: 'The solidified account response did not contain a complete owner and active permission set.',
    })
  }

  const ownerSingleKeyCanAuthorize = anySingleKeyMeetsThreshold(owner.keys, owner.threshold)
  const activePermissions = []
  let activeSingleKeyCanMoveFunds = false
  let activePermissionDataValid = true

  for (const [index, input] of activeInput.entries()) {
    const permission = validPermission(input, 'active')
    if (!permission) {
      activePermissionDataValid = false
      break
    }
    const enabledRiskyTypes = VALUE_OR_PERMISSION_CONTROL_CONTRACT_TYPES.filter((type) => operationAllowed(permission.operations, type))
    const singleKeyCanAuthorize = enabledRiskyTypes.length > 0
      && anySingleKeyMeetsThreshold(permission.keys, permission.threshold)
    if (singleKeyCanAuthorize) activeSingleKeyCanMoveFunds = true
    activePermissions.push({
      id: safeInteger(input.id) ?? (index + 2),
      name: String(input.permission_name || 'active-' + index),
      threshold: permission.threshold,
      signerCount: permission.keys.length,
      enabledValueMovingOrPermissionTypes: enabledRiskyTypes,
      singleSignerCanAuthorize: singleKeyCanAuthorize,
    })
  }

  if (!activePermissionDataValid) {
    return Object.freeze({
      available: false,
      verifiedAgainstSolidifiedState: true,
      restrictedAgainstSingleKey: false,
      singleSignerCanMoveNativeTrx: null,
      reason: 'active-permission-data-invalid',
      note: 'At least one active permission could not be decoded; no restriction conclusion is safe.',
    })
  }

  const singleSignerCanMoveNativeTrx = ownerSingleKeyCanAuthorize || activeSingleKeyCanMoveFunds
  return Object.freeze({
    available: true,
    verifiedAgainstSolidifiedState: true,
    multiSignatureConfigured: owner.threshold > 1 || activePermissions.some((permission) => permission.threshold > 1),
    ownerThreshold: owner.threshold,
    ownerSignerCount: owner.keys.length,
    ownerSingleSignerCanAuthorize: ownerSingleKeyCanAuthorize,
    activePermissions,
    riskyContractTypesChecked: VALUE_OR_PERMISSION_CONTROL_CONTRACT_TYPES,
    singleSignerCanMoveNativeTrx,
    restrictedAgainstSingleKey: !singleSignerCanMoveNativeTrx,
    reason: singleSignerCanMoveNativeTrx ? 'at-least-one-permission-allows-a-single-key' : 'all-value-moving-and-permission-control-operations-require-multiple-keys',
    note: 'This evaluates on-chain permission thresholds, not who controls each private key. It does not prove Bitpie UI support or provider custody.',
  })
}
