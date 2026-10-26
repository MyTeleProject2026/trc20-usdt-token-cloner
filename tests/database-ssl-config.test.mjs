import test from 'node:test'
import assert from 'node:assert/strict'
import { databaseSslConfig, normalizeDatabaseConnectionString, isRenderInternalDatabaseUrl } from '../server/database.mjs'

test('Render internal Postgres host does not force strict public certificate validation', () => {
  assert.equal(databaseSslConfig('postgresql://user:password@dpg-dbafj4tg1s2s73bu80m0-a/project', {
    DATABASE_SSL: 'true',
  }), undefined)
})

test('Render internal URL strips sslmode copied from an external connection string', () => {
  const url = normalizeDatabaseConnectionString('postgresql://user:password@dpg-dbafj4tg1s2s73bu80m0-a/project?sslmode=require&application_name=tron-studio')
  assert.equal(isRenderInternalDatabaseUrl(url), true)
  assert.equal(new URL(url).searchParams.has('sslmode'), false)
  assert.equal(new URL(url).searchParams.get('application_name'), 'tron-studio')
})

test('external Postgres URLs retain strict certificate validation when explicitly enabled', () => {
  assert.deepEqual(databaseSslConfig('postgresql://user:password@dpg-example.oregon-postgres.render.com/project?sslmode=require', {
    DATABASE_SSL: 'true',
  }), { rejectUnauthorized: true })
})

test('database SSL remains opt-in when DATABASE_SSL is not true', () => {
  assert.equal(databaseSslConfig('postgresql://user:password@db.example.com/project', {}), undefined)
})
