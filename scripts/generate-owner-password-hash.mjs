#!/usr/bin/env node
import { randomBytes, scrypt as scryptCallback } from 'node:crypto'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const scrypt = promisify(scryptCallback)
const OWNER_HASH_BYTES = 64
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

/**
 * Produce the scrypt hash format read by server/routes/tron-wallet-auth.mjs.
 * A fresh salt is generated for every call. The plaintext is never written.
 */
export async function createOwnerPasswordHash(password, salt = randomBytes(16)) {
  if (typeof password !== 'string' || password.length < 16 || password.length > 1024) {
    throw new Error('Use an owner password between 16 and 1024 characters.')
  }
  if (!Buffer.isBuffer(salt) || salt.length < 16 || salt.length > 64) {
    throw new Error('The scrypt salt must be a Buffer between 16 and 64 bytes.')
  }
  const key = await scrypt(password, salt, OWNER_HASH_BYTES, SCRYPT_OPTIONS)
  return `scrypt$${salt.toString('base64url')}$${Buffer.from(key).toString('base64url')}`
}

function readHiddenPassword(prompt) {
  const input = process.stdin
  if (!input.isTTY || typeof input.setRawMode !== 'function' || !process.stdout.isTTY) {
    throw new Error('Run this command from a local interactive terminal. Do not pass the password as an argument or environment variable.')
  }

  return new Promise((resolve, reject) => {
    let value = ''
    let finished = false
    process.stdout.write(prompt)

    const cleanup = () => {
      if (finished) return
      finished = true
      input.removeListener('data', onData)
      try { input.setRawMode(false) } catch { /* best-effort terminal restoration */ }
      input.pause()
      process.stdout.write('\n')
    }

    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === '\u0003') {
          cleanup()
          reject(new Error('Cancelled.'))
          return
        }
        if (character === '\r' || character === '\n') {
          cleanup()
          resolve(value)
          return
        }
        if (character === '\u007f' || character === '\b') {
          value = Array.from(value).slice(0, -1).join('')
          continue
        }
        // Ignore control characters and terminal escape bytes rather than
        // accidentally incorporating them into the credential.
        if (character >= ' ' && character !== '\u007f' && character !== '\u001b') {
          value += character
        }
      }
    }

    input.setEncoding('utf8')
    input.setRawMode(true)
    input.resume()
    input.on('data', onData)
  })
}

async function main() {
  const first = await readHiddenPassword('New owner password (hidden; minimum 16 characters): ')
  const second = await readHiddenPassword('Confirm owner password (hidden): ')
  if (first !== second) throw new Error('Passwords do not match.')
  const encoded = await createOwnerPasswordHash(first)
  process.stdout.write('\nOWNER_PASSWORD_HASH=' + encoded + '\n')
  process.stdout.write('Copy only the hash value to the backend Render environment. Do not share or commit it.\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : 'Could not generate the owner password hash.') + '\n')
    process.exitCode = 1
  })
}
