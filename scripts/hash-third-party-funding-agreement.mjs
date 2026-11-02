import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export const MAX_AGREEMENT_FILE_BYTES = 50 * 1024 * 1024

export async function hashThirdPartyFundingAgreement(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new TypeError('Provide the local path to the final executed agreement file')
  }

  const linkInfo = await lstat(filePath)
  if (linkInfo.isSymbolicLink() || !linkInfo.isFile()) {
    throw new TypeError('Agreement input must be a regular, non-symlink file')
  }
  const handle = await open(filePath, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.dev !== linkInfo.dev || info.ino !== linkInfo.ino) {
      throw new TypeError('Agreement file changed while it was being opened')
    }
    if (info.size < 1) throw new TypeError('Agreement file must not be empty')
    if (info.size > MAX_AGREEMENT_FILE_BYTES) {
      throw new TypeError('Agreement file exceeds the 50 MiB hashing limit')
    }

    const hash = createHash('sha256')
    const stream = handle.createReadStream({ autoClose: false })
    let bytes = 0
    for await (const chunk of stream) {
      bytes += chunk.length
      if (bytes > MAX_AGREEMENT_FILE_BYTES) {
        stream.destroy()
        throw new TypeError('Agreement file exceeds the 50 MiB hashing limit')
      }
      hash.update(chunk)
    }
    return { algorithm: 'sha256', agreementDocumentSha256: hash.digest('hex'), bytes }
  } finally {
    await handle.close().catch(() => {})
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === invokedPath) {
  hashThirdPartyFundingAgreement(process.argv[2]).then((result) => {
    process.stdout.write(JSON.stringify({
      success: true,
      ...result,
      documentUploaded: false,
      note: 'Only a SHA-256 fingerprint was produced. The file contents were not uploaded or transmitted.',
    }, null, 2) + '\n')
  }).catch((error) => {
    process.stderr.write((error?.message || 'Could not hash agreement file') + '\n')
    process.exitCode = 1
  })
}
