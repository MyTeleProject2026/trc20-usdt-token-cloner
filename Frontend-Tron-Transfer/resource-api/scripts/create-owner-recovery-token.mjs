import { createHash, randomBytes } from 'node:crypto'
import pg from 'pg'

const connectionString = String(process.env.DATABASE_URL || '').trim()
if (!connectionString) {
  process.stderr.write('DATABASE_URL must be set to the direct Neon/Postgres connection string.\n')
  process.exit(1)
}
let databaseHost = ''
try { databaseHost = new URL(connectionString).hostname } catch { throw new Error('DATABASE_URL is invalid.') }
if (databaseHost.includes('-pooler.')) throw new Error('Use the direct Neon/Postgres endpoint, not a transaction pooler.')
const walletRole = String(process.env.WALLET_ROLE || 'owner').trim().toLowerCase()
if (!['owner', 'sponsor'].includes(walletRole)) throw new Error('WALLET_ROLE must be owner or sponsor.')
const token = randomBytes(32).toString('base64url')
const tokenHash = createHash('sha256').update(token).digest('hex')
const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000, max: 1 })
const client = await pool.connect()
try {
  await client.query('BEGIN')
  await client.query('UPDATE public.tron_transfer_wallet_recovery_tokens SET consumed_at=now() WHERE wallet_role=$1 AND consumed_at IS NULL', [walletRole])
  await client.query("INSERT INTO public.tron_transfer_wallet_recovery_tokens (wallet_role,token_hash,expires_at) VALUES ($1,$2,now()+interval '30 minutes')", [walletRole, tokenHash])
  await client.query('COMMIT')
  process.stdout.write('One-time ' + walletRole + ' recovery token (expires in 30 minutes; store offline):\n' + token + '\n')
} catch (error) {
  await client.query('ROLLBACK').catch(() => {})
  process.stderr.write('Could not create wallet recovery token: ' + String(error?.code || 'DATABASE_ERROR') + '\n')
  process.exitCode = 1
} finally {
  client.release()
  await pool.end()
}
