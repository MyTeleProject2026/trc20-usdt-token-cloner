const ROLES = new Set(['owner', 'sponsor'])

export async function runLocalSignerAcceptance({ authClient, tronWeb, address, role } = {}) {
  if (!ROLES.has(role)) throw new TypeError('LOCAL_SIGNER_ROLE_INVALID')
  if (!authClient || typeof authClient.apiRequest !== 'function') throw new Error('WALLET_SESSION_REQUIRED')
  if (!tronWeb?.isAddress?.(address) || !tronWeb?.defaultAddress?.base58
    || !tronWeb.isAddress(tronWeb.defaultAddress.base58)
    || tronWeb.address.toHex(tronWeb.defaultAddress.base58).toLowerCase() !== tronWeb.address.toHex(address).toLowerCase()) {
    throw new Error('LOCAL_SIGNER_ADDRESS_MISMATCH')
  }
  if (typeof tronWeb.trx?.signMessageV2 !== 'function') throw new Error('LOCAL_MESSAGE_SIGNING_UNAVAILABLE')
  const root = '/api/wallet-auth/' + role + '/signing-challenge'
  const challenge = await authClient.apiRequest(root)
  if (challenge?.success !== true || typeof challenge.challengeId !== 'string'
    || typeof challenge.message !== 'string' || !challenge.message.includes('TRON Mainnet')) {
    throw new Error('LOCAL_SIGNER_CHALLENGE_INVALID')
  }
  const signature = await tronWeb.trx.signMessageV2(challenge.message)
  if (typeof signature !== 'string' || !/^(?:0x)?[0-9a-f]{130}$/i.test(signature)) {
    throw new Error('LOCAL_SIGNER_SIGNATURE_INVALID')
  }
  const result = await authClient.apiRequest(root + '/verify', {
    method: 'POST',
    csrf: true,
    body: { challengeId: challenge.challengeId, signature },
  })
  if (result?.success !== true || result?.verified !== true || result?.role !== role
    || result?.address !== address || result?.transactionCreated !== false
    || result?.broadcast !== false || result?.signatureStored !== false
    || result?.privateKeyReceived !== false) {
    throw new Error('LOCAL_SIGNER_ACCEPTANCE_FAILED')
  }
  return Object.freeze({
    role,
    address,
    verified: true,
    verifiedAt: String(result.verifiedAt || new Date().toISOString()),
    transactionCreated: false,
    broadcast: false,
  })
}
