import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashThirdPartyFundingAgreement } from '../scripts/hash-third-party-funding-agreement.mjs'

test('agreement hashing returns the SHA-256 of the exact local file bytes without returning its contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'funding-agreement-hash-'))
  try {
    const file = join(directory, 'executed-agreement.pdf')
    const bytes = Buffer.from('%PDF-1.7\nconfidential test document\n', 'utf8')
    await writeFile(file, bytes)
    const result = await hashThirdPartyFundingAgreement(file)
    assert.equal(result.algorithm, 'sha256')
    assert.equal(result.agreementDocumentSha256, createHash('sha256').update(bytes).digest('hex'))
    assert.equal(result.bytes, bytes.length)
    assert.equal(Object.hasOwn(result, 'content'), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('agreement hashing rejects empty files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'funding-agreement-empty-'))
  try {
    const file = join(directory, 'empty.pdf')
    await writeFile(file, '')
    await assert.rejects(() => hashThirdPartyFundingAgreement(file), /must not be empty/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('agreement hashing rejects non-file paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'funding-agreement-directory-'))
  try {
    await assert.rejects(() => hashThirdPartyFundingAgreement(directory), /regular file/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('agreement hashing rejects symbolic links instead of hashing an indirect path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'funding-agreement-symlink-'))
  try {
    const target = join(directory, 'executed-agreement.pdf')
    const link = join(directory, 'agreement-link.pdf')
    await writeFile(target, 'executed agreement')
    await symlink(target, link)
    await assert.rejects(() => hashThirdPartyFundingAgreement(link), /non-symlink file/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
