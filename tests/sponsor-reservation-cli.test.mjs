import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const cliPath = path.join(projectRoot, 'scripts', 'reserve-sponsor-transfer.mjs')
const receiverAddress = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const tokenContract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const adminToken = 'test-admin-token-value-that-is-long-enough-123456'

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

function baseArgs() {
  return [
    '--network', 'nile',
    '--sponsor-reference', 'approved-sponsor-test',
    '--purpose', 'asset-grant',
    '--asset', 'USDT',
    '--token-contract', tokenContract,
    '--receiver', receiverAddress,
    '--amount-base-units', '1000000',
  ]
}

test('reservation CLI creates and persists one key before API submission, then reuses it idempotently', async (t) => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'sponsor-reservation-cli-'))
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }))
  const calls = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body })
    const duplicate = calls.length > 1
    res.writeHead(duplicate ? 200 : 201, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({
      success: true,
      status: 'pending-review',
      reservation: { ...body, duplicate },
      canSubmitSponsoredTransfer: false,
      submissionEnabled: false,
      providerSubmissionAttempted: false,
      transactionBroadcast: false,
      unpaidFallbackToUserFunds: false,
      message: 'Internal reservation only.',
    }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => new Promise((resolve) => server.close(resolve)))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const env = {
    ...process.env,
    SPONSOR_ADMIN_API_TOKEN: adminToken,
    SPONSOR_API_BASE_URL: 'http://127.0.0.1:' + address.port,
    SPONSOR_RESERVATION_STATE_DIR: stateDirectory,
  }

  const first = await runCli(baseArgs(), env)
  assert.equal(first.code, 0, first.stderr)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].url, '/api/tron/sponsorship/transfers/reserve')
  assert.equal(calls[0].authorization, 'Bearer ' + adminToken)
  assert.equal(calls[0].body.network, 'nile')
  assert.equal(calls[0].body.receiverAddress, receiverAddress)
  assert.match(first.stdout, /transactionBroadcast": false/)
  const key = first.stdout.match(/Reservation idempotency key: ([A-Za-z0-9._:-]+)/)?.[1]
  assert.ok(key && key.length >= 24 && key.length <= 160, 'the generated key must satisfy the signer route contract')

  const names = await readdir(stateDirectory)
  assert.equal(names.length, 1)
  const savedPath = path.join(stateDirectory, names[0])
  const saved = JSON.parse(await readFile(savedPath, 'utf8'))
  assert.equal(saved.idempotencyKey, key)
  assert.deepEqual(saved.request, calls[0].body)
  assert.equal(JSON.stringify(saved).includes(adminToken), false)

  const retry = await runCli([...baseArgs(), '--idempotency-key', key], env)
  assert.equal(retry.code, 0, retry.stderr)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].body.idempotencyKey, key)
  assert.deepEqual(calls[1].body, calls[0].body)
  assert.match(retry.stdout, /"duplicate": true/)

  const changedIntent = await runCli([...baseArgs(), '--amount-base-units', '2000000', '--idempotency-key', key], env)
  assert.equal(changedIntent.code, 2)
  assert.match(changedIntent.stderr, /different intent/)
  assert.equal(calls.length, 2, 'same key with a changed amount must be rejected locally before another API request')
})
