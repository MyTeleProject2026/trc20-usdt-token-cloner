const UINT256_MAX = (1n << 256n) - 1n
const POSITIVE_INTEGER = /^[1-9][0-9]{0,77}$/

/**
 * Validate canonical positive base units without Number coercion.
 * Callers may use this for ERC-20 uint256 values and other TRON contract args.
 */
export function isPositiveUint256(value) {
  if (typeof value !== 'string' || !POSITIVE_INTEGER.test(value)) return false
  return BigInt(value) <= UINT256_MAX
}

export { UINT256_MAX }
