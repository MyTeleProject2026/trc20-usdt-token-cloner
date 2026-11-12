/**
 * Read-only assessment of TRON account permissions.
 *
 * This does not change account permissions or sign transactions. It determines
 * whether any single configured key can authorize native-value movement or
 * permission changes under the solidified account permission state.
 */
import { TronWeb } from 'tronweb'

const ONLY_NON_VALUE_MOVING_CONTRACT_TYPES = new Set([4, 8])
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
  const totalWeight = normalizedKeys.reduce((sum, key) => sum + key.weight, 0)
  if (!Number.isSafeInteger(totalWeight) || totalWeight < threshold) return null
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
      singleSignerCanMoveFunds: null,
      reason: 'permission-data-missing-or-invalid',
      note: 'The solidified account response did not contain a complete owner and active permission set.',
    })
  }

  const ownerSingleKeyCanAuthorize = anySingleKeyMeetsThreshold(owner.keys, owner.threshold)
  const activePermissions = []
  let activeSingleKeyCanMoveFunds = false
  let activePermissionDataValid = true

  for (const [index, input] of activeInput.entries()) {
    const permissionId = safeInteger(input?.id)
    const permission = validPermission(input, 'active')
    if (permissionId === null || permissionId < 2 || permissionId > 9 || !permission) {
      activePermissionDataValid = false
      break
    }
    // Fail closed for every enabled operation except the two explicitly
    // non-value-moving operations currently recognized here. This includes
    // unknown/future contract IDs, which must not silently pass as safe.
    const enabledRiskyTypes = Array.from({ length: 256 }, (_, type) => type)
      .filter((type) => operationAllowed(permission.operations, type)
        && !ONLY_NON_VALUE_MOVING_CONTRACT_TYPES.has(type))
    const singleKeyCanAuthorize = enabledRiskyTypes.length > 0
      && anySingleKeyMeetsThreshold(permission.keys, permission.threshold)
    if (singleKeyCanAuthorize) activeSingleKeyCanMoveFunds = true
    activePermissions.push({
      id: permissionId,
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
      singleSignerCanMoveFunds: null,
      reason: 'active-permission-data-invalid',
      note: 'At least one active permission could not be decoded; no restriction conclusion is safe.',
    })
  }

  const singleSignerCanMoveFunds = ownerSingleKeyCanAuthorize || activeSingleKeyCanMoveFunds
  return Object.freeze({
    available: true,
    verifiedAgainstSolidifiedState: true,
    multiSignatureConfigured: owner.threshold > 1 || activePermissions.some((permission) => permission.threshold > 1),
    ownerThreshold: owner.threshold,
    ownerSignerCount: owner.keys.length,
    ownerSingleSignerCanAuthorize: ownerSingleKeyCanAuthorize,
    activePermissions,
    enabledValueOrUnknownOperations: activePermissions.flatMap((permission) => permission.enabledValueMovingOrPermissionTypes),
    nonValueMovingOperationsTreatedAsSafe: [...ONLY_NON_VALUE_MOVING_CONTRACT_TYPES],
    singleSignerCanMoveFunds,
    restrictedAgainstSingleKey: !singleSignerCanMoveFunds,
    reason: singleSignerCanMoveFunds ? 'at-least-one-permission-allows-a-single-key' : 'all-value-moving-and-permission-control-operations-require-multiple-keys',
    note: 'Every enabled contract type is treated as value/control-capable except VoteWitnessContract (4) and WitnessUpdateContract (8). Unknown/future operation IDs are flagged. This evaluates permission thresholds, not human key control or Bitpie UI support.',
  })
}
