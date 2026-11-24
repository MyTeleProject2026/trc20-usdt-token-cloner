import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('Render Blueprint preserves Neon and does not provision a Render database or wallet secrets', async () => {
  const blueprint = await readFile(new URL('../../../render.yaml', import.meta.url), 'utf8')
  assert.match(blueprint, /- key: DATABASE_URL\n\s+sync: false/)
  assert.match(blueprint, /- key: TATUM_API_KEY\n\s+sync: false/)
  assert.match(blueprint, /- key: TRONGRID_API_KEY\n\s+sync: false/)
  assert.doesNotMatch(blueprint, /^databases:/m)
  assert.doesNotMatch(blueprint, /fromDatabase:/)
  assert.doesNotMatch(blueprint, /PRIVATE_KEY|MNEMONIC|SEED_PHRASE/i)
})
