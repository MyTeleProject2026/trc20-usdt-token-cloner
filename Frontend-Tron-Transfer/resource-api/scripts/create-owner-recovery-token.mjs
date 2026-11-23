import { createHash, randomBytes } from 'node:crypto'
import pg from 'pg'

const connectionString = String(process.env.DATABASE_URL || '').trim()
if (!connectionString) {
  process.stderr.write('DATABASE_URL must be set to the direct Neon/Postgres connection string.\\n')
  process.exit(1)
}
const token = randomBytes(32).toString('base64url')
const tokenHash = createHash('sha256').update(token).digest('hex')
const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000, max: 1 })
try {
  await pool.query(`
    INSERT INTO public.tron_transfer_wallet_recovery_tokens (token_hash,expires_at)
    VALUES ($1,now()+interval '30 minutes')
  `, [tokenHash])
  process.stdout.write('One-time Owner recovery token (expires in 30 minutes; store offline):\\n' + token + '\\n')
} catch (error) {
  process.stderr.write('Could not create Owner recovery token: ' + String(error?.code || 'DATABASE_ERROR') + '\\n')
  process.exitCode = 1
} finally {
  client.release()
  await pool.end()
}
