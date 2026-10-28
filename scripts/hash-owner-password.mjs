import { randomBytes, scryptSync } from 'node:crypto'
import process from 'node:process'

function readHidden(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('Run this command in an interactive terminal so the password is not echoed.')
  }
  process.stderr.write(prompt)
  const input = process.stdin
  return new Promise((resolve, reject) => {
    let value = ''
    const previousRawMode = input.isRaw
    const finish = (error) => {
      input.off('data', onData)
      try { input.setRawMode(previousRawMode === true) } catch {}
      input.pause()
      process.stderr.write('\n')
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === '\u0003') return finish(new Error('Password entry cancelled.'))
        if (character === '\r' || character === '\n') return finish()
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1)
        else if (character >= ' ' && character <= '~' && value.length < 1024) value += character
      }
    }
    input.setRawMode(true)
    input.resume()
    input.on('data', onData)
  })
}

try {
  const password = await readHidden('Enter the owner login password (12–1024 characters; input hidden): ')
  if (password.length < 12) throw new Error('Choose a password with at least 12 characters.')
  const salt = randomBytes(16)
  const derived = scryptSync(password, salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  })
  process.stdout.write('OWNER_LOGIN_PASSWORD_HASH=' + salt.toString('hex') + ':' + derived.toString('hex') + '\n')
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : 'Could not create password hash.') + '\n')
  process.exitCode = 1
}
