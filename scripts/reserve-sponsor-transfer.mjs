#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_API_BASE = 'https://trc20-usdt-token-cloner-api.onrender.com'

function usage() {
  console.log([
    'Create a testnet-only sponsor budget reservation; this command never signs or broadcasts.',
    '',
    'Required arguments:',
    '  --network nile|shasta',
    '  --sponsor-reference <approved sponsorReference>',
    '  --purpose network-fee|asset-grant',
    '  --asset TRX|USDT|VTRC',
    '  --receiver <TRON address>',
    '  --amount-base-units <positive integer string>',
    '  --token-contract <allowlisted TRON token contract>  (required for USDT/VTRC)',
    '',
    'Optional:',
    '  --idempotency-key <24-160 character key>  (generated if omitted)',
    '  --help',
    '',
    'Required environment:',
    '  SPONSOR_ADMIN_API_TOKEN  (server-side admin token, set locally; never paste into the browser)',
    '  SPONSOR_API_BASE_URL     (optional; defaults to the production backend)',
    '',
    'After a timeout, rerun with the SAME --idempotency-key. Never generate a new key to retry an uncertain request.',
  ].join('\n'))
}

function parseArgs(argv) {
  const result = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (key === '--help' || key === '-h') {
      result.help = true
      continue
    }
    if (!key.startsWith('--') || i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
      throw new Error('Invalid argument near ' + key + '. Use --help for usage.')
    }
    const name = key.slice(2)
    if (!['network', 'sponsor-reference', 'purpose', 'asset', 'token-contract', 'receiver', 'amount-base-units', 'idempotency-key'].includes(name)) {
      throw new Error('Unknown argument: ' + key)
    }
    if (Object.hasOwn(result, name)) throw new Error('Duplicate argument: ' + key)
    result[name] = argv[++i]
  }
  return result
}

function validateBaseUrl(value) {
  const url = new URL(value)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('SPONSOR_API_BASE_URL must be an origin only, without credentials, path, query, or fragment.')
  }
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('SPONSOR_API_BASE_URL must use HTTPS (HTTP is allowed only for local loopback testing).')
  }
  if (!local && url.hostname !== 'trc20-usdt-token-cloner-api.onrender.com') {
    throw new Error('Refusing to send the sponsor administrator token to an unapproved host.')
  }
  return url.origin
}

function validateAddress(value, fieldName) {
  if (typeof value !== 'string' || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value)) {
    throw new Error(fieldName + ' must be a TRON main-format address. The backend also validates checksum and allowlists.')
  }
}

function compareRequest(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

async function atomicWrite(filePath, contents) {
  const tempPath = filePath + '.tmp-' + process.pid
  await writeFile(tempPath, contents, { encoding: 'utf8', mode: 0o600 })
  await rename(tempPath, filePath)
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error('Error: ' + error.message)
    process.exitCode = 2
    return
  }
  if (args.help) {
    usage()
    return
  }

  const adminToken = process.env.SPONSOR_ADMIN_API_TOKEN
  if (typeof adminToken !== 'string' || adminToken.length < 32) {
    console.error('Error: SPONSOR_ADMIN_API_TOKEN is missing or shorter than 32 characters. Set it in your local shell; do not commit it or place it in a VITE_* variable.')
    process.exitCode = 2
    return
  }

  const required = ['network', 'sponsor-reference', 'purpose', 'asset', 'receiver', 'amount-base-units']
  const missing = required.filter((key) => !args[key])
  if (missing.length) {
    console.error('Error: missing required arguments: ' + missing.map((key) => '--' + key).join(', '))
    usage()
    process.exitCode = 2
    return
  }

  const network = args.network
  const purpose = args.purpose
  const asset = args.asset
  const sponsorReference = args['sponsor-reference']
  const receiverAddress = args.receiver
  const amountBaseUnits = args['amount-base-units']
  const tokenContract = args['token-contract'] || null
  const idempotencyKey = args['idempotency-key'] || ('trc20-sponsor-' + randomUUID())

  if (!['nile', 'shasta'].includes(network)) throw new Error('Only Nile or Shasta testnet reservations are supported.')
  if (!['network-fee', 'asset-grant'].includes(purpose)) throw new Error('--purpose must be network-fee or asset-grant.')
  if (!['TRX', 'USDT', 'VTRC'].includes(asset)) throw new Error('--asset must be TRX, USDT, or VTRC.')
  if (purpose === 'network-fee' && asset !== 'TRX') throw new Error('A network-fee reservation must use asset TRX.')
  if (typeof sponsorReference !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(sponsorReference)) throw new Error('--sponsor-reference must be a reference already approved for the configured sponsor budget.')
  if (!/^[A-Za-z0-9._:-]{24,160}$/.test(idempotencyKey)) throw new Error('--idempotency-key must be 24-160 characters and use letters, numbers, dot, underscore, colon, or hyphen.')
  if (!/^[1-9][0-9]{0,77}$/.test(amountBaseUnits) || BigInt(amountBaseUnits) >= (1n << 256n)) throw new Error('--amount-base-units must be a positive integer base-unit string within uint256.')
  validateAddress(receiverAddress, '--receiver')
  if (asset === 'TRX' && tokenContract) throw new Error('--token-contract must be omitted for native TRX.')
  if (asset !== 'TRX') validateAddress(tokenContract, '--token-contract')

  const body = {
    idempotencyKey,
    network,
    sponsorReference,
    purpose,
    asset,
    tokenContract: asset === 'TRX' ? null : tokenContract,
    receiverAddress,
    amountBaseUnits,
  }

  let apiBase
  try {
    apiBase = validateBaseUrl(process.env.SPONSOR_API_BASE_URL || DEFAULT_API_BASE)
  } catch (error) {
    console.error('Error: ' + error.message)
    process.exitCode = 2
    return
  }

  const stateDirectory = process.env.SPONSOR_RESERVATION_STATE_DIR
    ? path.resolve(process.env.SPONSOR_RESERVATION_STATE_DIR)
    : path.join(os.homedir(), '.trc20-token-studio', 'reservations')
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 })
  const keyDigest = createHash('sha256').update(idempotencyKey, 'utf8').digest('hex').slice(0, 32)
  const statePath = path.join(stateDirectory, 'reservation-' + keyDigest + '.json')
  let state
  try {
    state = JSON.parse(await readFile(statePath, 'utf8'))
    if (state.idempotencyKey !== idempotencyKey || !compareRequest(state.request, body)) {
      console.error('Error: this idempotency key already has a local state record for a different intent. Use a new key only for a genuinely new, separately approved transfer.')
      process.exitCode = 2
      return
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      if (error instanceof SyntaxError) {
        console.error('Error: the local reservation state file is unreadable; preserve it and investigate before retrying.')
        process.exitCode = 2
        return
      }
      if (process.exitCode) return
      throw error
    }
    state = {
      version: 1,
      idempotencyKey,
      createdAt: new Date().toISOString(),
      request: body,
    }
    await atomicWrite(statePath, JSON.stringify(state, null, 2) + '\n')
  }

  console.log('Reservation idempotency key: ' + idempotencyKey)
  console.log('Local recovery record: ' + statePath)
  console.log('Submitting only an internal budget reservation; this command cannot sign or broadcast.')
  try {
    const response = await fetch(apiBase + '/api/tron/sponsorship/transfers/reserve', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + adminToken,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
      redirect: 'error',
    })
    const payload = await response.json().catch(() => ({}))
    state.lastAttemptAt = new Date().toISOString()
    state.lastHttpStatus = response.status
    state.lastApiStatus = typeof payload.status === 'string' ? payload.status : null
    state.lastApiError = typeof payload.error === 'string' ? payload.error : null
    state.reservationRecorded = response.ok && payload.success === true
    state.duplicate = payload.reservation?.duplicate === true
    await atomicWrite(statePath, JSON.stringify(state, null, 2) + '\n')

    if (!response.ok || payload.success !== true) {
      console.error('Reservation request did not succeed (HTTP ' + response.status + ').')
      if (state.lastApiError) console.error('API error: ' + state.lastApiError)
      if (typeof payload.message === 'string') console.error(payload.message)
      console.error('Keep the same idempotency key and local recovery record while investigating. No transfer is claimed.')
      process.exitCode = 1
      return
    }

    console.log(JSON.stringify({
      success: true,
      status: payload.status,
      reservation: payload.reservation,
      duplicate: state.duplicate,
      canSubmitSponsoredTransfer: payload.canSubmitSponsoredTransfer === true,
      submissionEnabled: payload.submissionEnabled === true,
      transactionBroadcast: payload.transactionBroadcast === true,
      stateFile: statePath,
      message: payload.message,
    }, null, 2))
    console.log('Important: successful reservation is not a signed transaction, broadcast, settled transfer, receiver credit, or exchange deposit.')
  } catch (error) {
    state.lastAttemptAt = new Date().toISOString()
    state.lastNetworkError = error instanceof Error ? error.name : 'request-failed'
    await atomicWrite(statePath, JSON.stringify(state, null, 2) + '\n')
    console.error('The API outcome is unknown because the request did not return a response. Do not create a new reservation key.')
    console.error('Retry the same full intent with --idempotency-key ' + idempotencyKey)
    console.error('The key and request are saved locally at: ' + statePath)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('Reservation helper failed: ' + (error instanceof Error ? error.message : 'unknown error'))
  process.exitCode = 1
})
