import test from 'node:test'
import assert from 'node:assert/strict'
import { databaseSslConfig } from '../server/database.mjs'

test('Render internal Postgres host does not force strict public certificate validation', () => {
  assert.equal(databaseSslConfig('postgresql://user:password@dpg-dbafj4tg1s2s73bu80m0-a/project', {
    DATABASE_SSL: 'true',
  }), undefined)
})

test('external Postgres URLs retain strict certificate validation when explicitly enabled', () => {
  assert.deepEqual(databaseSslConfig('postgresql://user:password@dpg-example.oregon-postgres.render.com/project?sslmode=require', {
    DATABASE_SSL: 'true',
  }), { rejectUnauthorized: true })
})

test('database SSL remains opt-in when DATABASE_SSL is not true', () => {
  assert.equal(databaseSslConfig('postgresql://user:password@db.example.com/project', {}), undefined)
})
