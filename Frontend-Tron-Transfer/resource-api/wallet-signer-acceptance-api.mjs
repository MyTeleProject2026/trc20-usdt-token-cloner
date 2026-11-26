import { randomBytes, randomUUID } from 'node:crypto'
import { createMainnetTronWeb } from './mainnet-rpc-provider.mjs'
import { createManagedWalletIdentityReport } from './managed-wallet-identities.mjs'

const MAINNET_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const SIGNATURE = /^(?:0x)?[0-9a-f]{130}$/i
const CHALLENGE_TTL_MS = 120_000
const MAX_CHALLENGES = 5_000

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 8 * 1024) throw Object.assign(new Error('REQUEST_TOO_LARGE'), { status: 413 })
    chunks.push(chunk)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value
  } catch {
    throw Object.assign(new Error('INVALID_JSON'), { status: 400 })
  }
}

function addressesEqual(tronWeb, left, right) {
  try {
    return Boolean(tronWeb?.isAddress?.(left) && tronWeb?.isAddress?.(right)
      && tronWeb.address.toHex(left).toLowerCase() === tronWeb.address.toHex(right).toLowerCase())
  } catch {
    return false
  }
}

export function createWalletSignerAcceptanceApi({
  env = process.env,
  send,
  authenticateOwnerSession,
  authenticateSponsorSession,
  fetchImpl = globalThis.fetch,
  tronWebFactory = () => createMainnetTronWeb({ env, fetchImpl }),
  recordAcceptance = async () => false,
  identityReport,
  now = () => Date.now(),
  ttlMs = CHALLENGE_TTL_MS,
  maxChallenges = MAX_CHALLENGES,
} = {}) {
  if (typeof send !== 'function'
    || typeof authenticateOwnerSession !== 'function'
    || typeof authenticateSponsorSession !== 'function') {
    throw new TypeError('Wallet signer acceptance requires response and role-scoped session adapters.')
  }
  const challenges = new Map()
  const identity = () => identityReport || createManagedWalletIdentityReport({ env })

  function purgeChallenges() {
    const current = now()
    for (const [id, challenge] of challenges) {
      if (challenge.expiresAt <= current) challenges.delete(id)
    }
    while (challenges.size >= maxChallenges) {
      const oldest = challenges.keys().next().value
      if (!oldest) break
      challenges.delete(oldest)
    }
  }

  async function handle(req, res, url, origin) {
    const match = url.pathname.match(/^\/api\/wallet-auth\/(owner|sponsor)\/signing-challenge(\/verify)?$/)
    if (!match) return false

    const role = match[1]
    const verifying = match[2] === '/verify'
    if (req.method !== (verifying ? 'POST' : 'GET')) {
      send(res, 405, { success: false, error: 'METHOD_NOT_ALLOWED' }, origin)
      return true
    }

    const authenticate = role === 'owner' ? authenticateOwnerSession : authenticateSponsorSession
    const session = await authenticate(req, { requireCsrf: verifying }).catch(() => null)
    if (!session?.address || session.sessionId == null) {
      send(res, 401, { success: false, error: 'WALLET_SESSION_REQUIRED' }, origin)
      return true
    }

    const configured = identity()
    const expectedAddress = configured?.[role]?.address
    if (!MAINNET_ADDRESS.test(String(expectedAddress || ''))
      || session.address !== expectedAddress
      || configured?.network !== 'TRON Mainnet'
      || configured?.identitiesDistinct !== true) {
      send(res, 403, { success: false, error: 'WALLET_IDENTITY_MISMATCH' }, origin)
      return true
    }

    if (!verifying) {
      purgeChallenges()
      for (const [id, challenge] of challenges) {
        if (challenge.role === role && String(challenge.sessionId) === String(session.sessionId)) {
          challenges.delete(id)
        }
      }
      const challengeId = randomUUID()
      const expiresAt = now() + ttlMs
      const nonce = randomBytes(32).toString('hex')
      const message = [
        'TRON TRANSFER LOCAL SIGNER ACCEPTANCE',
        'Role: ' + role.toUpperCase(),
        'Network: TRON Mainnet',
        'Address: ' + session.address,
        'Session: ' + String(session.sessionId),
        'Issued at: ' + new Date(now()).toISOString(),
        'Nonce: ' + nonce,
        'Purpose: prove local key control only; no transaction or broadcast',
      ].join('\n')
      challenges.set(challengeId, {
        role, address: session.address, sessionId: session.sessionId,
        message, expiresAt,
      })
      return send(res, 200, {
        success: true, role, challengeId, message,
        expiresAt: new Date(expiresAt).toISOString(),
        expiresInSeconds: Math.ceil(ttlMs / 1000),
      }, origin)
    }

    let input
    try { input = await readBody(req) } catch (error) {
      send(res, error.status || 400, { success: false, error: error.message || 'INVALID_JSON' }, origin)
      return true
    }
    const challengeId = String(input.challengeId || '')
    const challenge = challenges.get(challengeId)
    if (challenge) challenges.delete(challengeId)
    if (!challenge) {
      send(res, 409, { success: false, error: 'SIGNER_CHALLENGE_NOT_FOUND_OR_ALREADY_USED' }, origin)
      return true
    }
    if (challenge.expiresAt <= now()) {
      send(res, 410, { success: false, error: 'SIGNER_CHALLENGE_EXPIRED' }, origin)
      return true
    }
    if (challenge.role !== role || challenge.address !== session.address
      || String(challenge.sessionId) !== String(session.sessionId)) {
      send(res, 403, { success: false, error: 'SIGNER_CHALLENGE_SESSION_MISMATCH' }, origin)
      return true
    }
    const signature = String(input.signature || '')
    if (!SIGNATURE.test(signature)) {
      send(res, 400, { success: false, error: 'SIGNER_SIGNATURE_INVALID_FORMAT' }, origin)
      return true
    }

    try {
      const tronWeb = tronWebFactory()
      const recoveredAddress = await tronWeb.trx.verifyMessageV2(challenge.message, signature)
      if (!addressesEqual(tronWeb, recoveredAddress, challenge.address)) {
        send(res, 401, { success: false, error: 'LOCAL_SIGNER_ADDRESS_MISMATCH' }, origin)
        return true
      }
      const verifiedAt = new Date(now()).toISOString()
      let auditRecorded = false
      try {
        auditRecorded = await recordAcceptance({
          role,
          address: challenge.address,
          sessionId: challenge.sessionId,
          verifiedAt,
        }) === true
      } catch {
        auditRecorded = false
      }
      return send(res, 200, {
        success: true,
        verified: true,
        auditRecorded,
        role,
        address: challenge.address,
        verifiedAt: new Date(now()).toISOString(),
        transactionCreated: false,
        broadcast: false,
        signatureStored: false,
        privateKeyReceived: false,
      }, origin)
    } catch {
      send(res, 401, { success: false, error: 'LOCAL_SIGNER_SIGNATURE_VERIFICATION_FAILED' }, origin)
      return true
    }
  }

  return Object.freeze({ handle, pendingChallengeCount: () => challenges.size })
}
