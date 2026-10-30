import pg from 'pg'
import { createHash } from 'node:crypto'
import { normalizeDatabaseConnectionString, databaseSslConfig, initializeDatabase, isApprovedSponsorAgreementScope, isSponsorTokenContractAllowed } from './database.mjs'
import { reconcileSponsorBudgets } from './sponsor-reconciliation.mjs'
import { isValidTronAddress } from './tron-address.mjs'

const { Pool } = pg
const NETWORKS = new Set(['mainnet', 'nile', 'shasta'])
const ROLES = new Set(['asset-principal', 'network-fee'])
const ORGANIZATION_STATUSES = new Set(['pending_review', 'under_review', 'verified', 'approved', 'suspended', 'revoked'])
const VERIFICATION_METHODS = new Set(['wallet-signature', 'custodial-provider-attestation', 'multisig-attestation', 'manual-independent-review'])
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,159}$/
const SPONSOR_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,99}$/

export function isValidSponsorRegistryReference(value) {
  return typeof value === 'string' && REFERENCE_PATTERN.test(value.trim())
}

export function isValidSponsorAccountInput(input = {}) {
  return typeof input.sponsorReference === 'string'
    && SPONSOR_REFERENCE_PATTERN.test(input.sponsorReference.trim())
    && NETWORKS.has(input.network)
    && ROLES.has(input.role)
    && typeof input.address === 'string'
    && isValidTronAddress(input.address.trim())
}

function validId(value) {
  return typeof value === 'string' && /^[1-9][0-9]{0,17}$/.test(value)
}

function toOrganization(row) {
  return {
    id: String(row.id),
    sponsorReference: row.sponsor_reference,
    legalName: row.legal_name,
    displayName: row.display_name || null,
    jurisdictionCountryCode: row.jurisdiction_country_code || null,
    status: row.status,
    agreementReference: row.agreement_reference || null,
    reviewReference: row.review_reference || null,
    verificationMethod: row.verification_method || null,
    evidenceReference: row.evidence_reference || null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : null,
    payoutEligible: false,
  }
}

function toAccount(row) {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    sponsorReference: row.sponsor_reference,
    network: row.network,
    role: row.role,
    address: row.wallet_address,
    status: row.status,
    verificationMethod: row.verification_method || null,
    verificationReference: row.verification_reference || null,
    reviewReference: row.review_reference || null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    payoutEligible: false,
  }
}

/** Registry metadata only: no provider secrets, private keys, or signing actions. */
export function createSponsorOrganizationStore({ env = process.env, databasePool = null } = {}) {
  let pool = databasePool
  let schemaPromise

  function getPool() {
    if (pool) return pool
    if (typeof env.DATABASE_URL !== 'string' || !env.DATABASE_URL.trim()) return null
    const connectionString = normalizeDatabaseConnectionString(env.DATABASE_URL)
    pool = new Pool({
      connectionString,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      max: 3,
      ssl: databaseSslConfig(connectionString, env),
    })
    pool.on('error', (error) => console.error('Sponsor registry database error:', error?.code || 'unknown'))
    return pool
  }

  async function ensureSchema(db) {
    if (!schemaPromise) {
      schemaPromise = (async () => {
        // The budget table belongs to the application migration. Initialize it before
        // adding the registry's restrictive foreign key to that table.
        if (!databasePool) {
          const initialized = await initializeDatabase()
          if (initialized.configured !== true || initialized.ready !== true) {
            throw new Error('Sponsor registry database dependencies are unavailable')
          }
        }
        await db.query('CREATE SCHEMA IF NOT EXISTS trc20_token_clone')
        await db.query(`
          CREATE TABLE IF NOT EXISTS trc20_token_clone.sponsor_organizations (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            sponsor_reference TEXT NOT NULL UNIQUE,
            legal_name TEXT NOT NULL CHECK (length(btrim(legal_name)) BETWEEN 2 AND 160),
            display_name TEXT,
            jurisdiction_country_code CHAR(2),
            status TEXT NOT NULL DEFAULT 'pending_review'
              CHECK (status IN ('pending_review','under_review','verified','approved','suspended','revoked')),
            agreement_reference TEXT,
            review_reference TEXT,
            verification_method TEXT,
            evidence_reference TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            approved_at TIMESTAMPTZ,
            CHECK (jurisdiction_country_code IS NULL OR jurisdiction_country_code ~ '^[A-Z]{2}$')
          )
        `)
        await db.query(`
          CREATE TABLE IF NOT EXISTS trc20_token_clone.sponsor_organization_accounts (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            organization_id BIGINT NOT NULL REFERENCES trc20_token_clone.sponsor_organizations(id) ON DELETE RESTRICT,
            sponsor_reference TEXT NOT NULL UNIQUE,
            network TEXT NOT NULL CHECK (network IN ('mainnet','nile','shasta')),
            role TEXT NOT NULL CHECK (role IN ('asset-principal','network-fee')),
            wallet_address TEXT NOT NULL CHECK (wallet_address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$'),
            status TEXT NOT NULL DEFAULT 'pending_verification'
              CHECK (status IN ('pending_verification','verified','suspended','revoked')),
            verification_method TEXT,
            verification_reference TEXT,
            review_reference TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (network, wallet_address)
          )
        `)
        await db.query(`
          CREATE INDEX IF NOT EXISTS sponsor_organization_accounts_owner_idx
          ON trc20_token_clone.sponsor_organization_accounts (organization_id, network, role, status)
        `)
        await db.query(`
          CREATE TABLE IF NOT EXISTS trc20_token_clone.sponsor_organization_audit_events (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            organization_id BIGINT NOT NULL REFERENCES trc20_token_clone.sponsor_organizations(id) ON DELETE RESTRICT,
            account_id BIGINT REFERENCES trc20_token_clone.sponsor_organization_accounts(id) ON DELETE RESTRICT,
            event_type TEXT NOT NULL,
            actor TEXT NOT NULL DEFAULT 'sponsor-admin-api-token',
            details JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `)
        await db.query(`
          CREATE INDEX IF NOT EXISTS sponsor_organization_audit_events_owner_idx
          ON trc20_token_clone.sponsor_organization_audit_events (organization_id, created_at DESC)
        `)
        // A link binds one exact approved registry account to one existing sponsor budget.
        // The budget row remains the accounting authority; the link adds organization ownership.
        await db.query(`
          CREATE TABLE IF NOT EXISTS trc20_token_clone.sponsor_organization_budget_links (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            organization_id BIGINT NOT NULL REFERENCES trc20_token_clone.sponsor_organizations(id) ON DELETE RESTRICT,
            account_id BIGINT NOT NULL REFERENCES trc20_token_clone.sponsor_organization_accounts(id) ON DELETE RESTRICT,
            budget_id BIGINT NOT NULL UNIQUE REFERENCES trc20_token_clone.sponsor_budgets(id) ON DELETE RESTRICT,
            status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked')),
            review_reference TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (organization_id, account_id, budget_id)
          )
        `)
        await db.query(`
          CREATE INDEX IF NOT EXISTS sponsor_organization_budget_links_owner_idx
          ON trc20_token_clone.sponsor_organization_budget_links (organization_id, status, created_at DESC)
        `)
        await db.query(\`
          CREATE TABLE IF NOT EXISTS trc20_token_clone.sponsor_organization_payout_intents (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            idempotency_key TEXT NOT NULL UNIQUE,
            intent_digest CHAR(64) NOT NULL,
            network TEXT NOT NULL CHECK (network IN ('mainnet','nile','shasta')),
            asset TEXT NOT NULL CHECK (asset IN ('TRX','USDT')),
            token_contract TEXT,
            receiver_address TEXT NOT NULL,
            amount_base_units NUMERIC(78,0) NOT NULL CHECK (amount_base_units > 0),
            fee_cap_sun NUMERIC(78,0) NOT NULL CHECK (fee_cap_sun > 0),
            principal_link_id BIGINT NOT NULL REFERENCES trc20_token_clone.sponsor_organization_budget_links(id) ON DELETE RESTRICT,
            fee_link_id BIGINT NOT NULL REFERENCES trc20_token_clone.sponsor_organization_budget_links(id) ON DELETE RESTRICT,
            principal_budget_id BIGINT NOT NULL REFERENCES trc20_token_clone.sponsor_budgets(id) ON DELETE RESTRICT,
            fee_budget_id BIGINT NOT NULL REFERENCES trc20_token_clone.sponsor_budgets(id) ON DELETE RESTRICT,
            principal_organization_id BIGINT NOT NULL REFERENCES trc20_token_clone.sponsor_organizations(id) ON DELETE RESTRICT,
            fee_organization_id BIGINT NOT NULL REFERENCES trc20_token_clone.sponsor_organizations(id) ON DELETE RESTRICT,
            principal_account_id BIGINT NOT NULL REFERENCES trc20_token_clone.sponsor_organization_accounts(id) ON DELETE RESTRICT,
            fee_account_id BIGINT NOT NULL REFERENCES trc20_token_clone.sponsor_organization_accounts(id) ON DELETE RESTRICT,
            principal_sponsor_address TEXT NOT NULL,
            fee_sponsor_address TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending_authorization'
              CHECK (status IN ('pending_authorization','cancelled','expired')),
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CHECK (principal_link_id <> fee_link_id),
            CHECK (principal_budget_id <> fee_budget_id),
            CHECK (principal_organization_id <> fee_organization_id),
            CHECK (principal_sponsor_address <> fee_sponsor_address),
            CHECK ((asset = 'TRX' AND token_contract IS NULL)
              OR (asset = 'USDT' AND token_contract IS NOT NULL AND length(btrim(token_contract)) > 0))
          )
        \`)
        await db.query(\`
          CREATE TABLE IF NOT EXISTS trc20_token_clone.sponsor_organization_payout_reservations (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            intent_id BIGINT NOT NULL REFERENCES trc20_token_clone.sponsor_organization_payout_intents(id) ON DELETE RESTRICT,
            budget_id BIGINT NOT NULL REFERENCES trc20_token_clone.sponsor_budgets(id) ON DELETE RESTRICT,
            role TEXT NOT NULL CHECK (role IN ('asset-principal','network-fee')),
            amount_base_units NUMERIC(78,0) NOT NULL CHECK (amount_base_units > 0),
            status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','released')),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (intent_id, role),
            UNIQUE (intent_id, budget_id)
          )
        \`)
        await db.query(\`
          CREATE INDEX IF NOT EXISTS sponsor_org_payout_intents_expiry_idx
          ON trc20_token_clone.sponsor_organization_payout_intents (status, expires_at)
        \`)
      })().catch((error) => { schemaPromise = null; throw error })
    }
    await schemaPromise
  }

  async function writeAudit(client, organizationId, accountId, eventType, details) {
    await client.query(`
      INSERT INTO trc20_token_clone.sponsor_organization_audit_events
        (organization_id, account_id, event_type, details)
      VALUES ($1, $2, $3, $4::jsonb)
    `, [organizationId, accountId || null, eventType, JSON.stringify(details || {})])
  }

  async function listOrganizations({ status = null, limit = 50 } = {}) {
    if (status !== null && !ORGANIZATION_STATUSES.has(status)) return { success: false, reason: 'invalid-status', organizations: [] }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return { success: false, reason: 'invalid-limit', organizations: [] }
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured', organizations: [] }
    try {
      await ensureSchema(db)
      const result = await db.query(`
        SELECT * FROM trc20_token_clone.sponsor_organizations
        WHERE ($1::text IS NULL OR status = $1)
        ORDER BY created_at DESC, id DESC LIMIT $2
      `, [status, limit])
      const ids = result.rows.map((row) => String(row.id))
      let accountRows = []
      if (ids.length) {
        const accounts = await db.query(`
          SELECT * FROM trc20_token_clone.sponsor_organization_accounts
          WHERE organization_id = ANY($1::bigint[])
          ORDER BY organization_id, network, role, id
        `, [ids])
        accountRows = accounts.rows
      }
      const byOrganization = new Map()
      for (const row of accountRows) {
        const key = String(row.organization_id)
        if (!byOrganization.has(key)) byOrganization.set(key, [])
        byOrganization.get(key).push(toAccount(row))
      }
      return {
        success: true,
        organizations: result.rows.map((row) => ({
          ...toOrganization(row),
          accounts: byOrganization.get(String(row.id)) || [],
        })),
      }
    } catch (error) {
      console.error('Sponsor organization list failed:', error?.code || 'unknown')
      return { success: false, reason: 'database-unavailable', organizations: [] }
    }
  }

  async function createOrganization(input) {
    const sponsorReference = input?.sponsorReference?.trim()
    const legalName = input?.legalName?.trim()
    const displayName = typeof input?.displayName === 'string' ? input.displayName.trim() : ''
    const countryCode = typeof input?.jurisdictionCountryCode === 'string'
      ? input.jurisdictionCountryCode.trim().toUpperCase()
      : null
    if (!sponsorReference || !SPONSOR_REFERENCE_PATTERN.test(sponsorReference)
      || typeof legalName !== 'string' || legalName.length < 2 || legalName.length > 160
      || displayName.length > 120
      || (countryCode !== null && !/^[A-Z]{2}$/.test(countryCode))) {
      return { success: false, reason: 'invalid-organization' }
    }
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured' }
    try {
      await ensureSchema(db)
      const client = await db.connect()
      try {
        await client.query('BEGIN')
        const result = await client.query(`
          INSERT INTO trc20_token_clone.sponsor_organizations
            (sponsor_reference, legal_name, display_name, jurisdiction_country_code)
          VALUES ($1,$2,$3,$4) RETURNING *
        `, [sponsorReference, legalName, displayName || null, countryCode])
        await writeAudit(client, result.rows[0].id, null, 'organization-registered', {
          sponsorReference, status: 'pending_review',
        })
        await client.query('COMMIT')
        return { success: true, organization: toOrganization(result.rows[0]) }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        if (error?.code === '23505') return { success: false, reason: 'sponsor-reference-already-exists' }
        throw error
      } finally {
        client.release()
      }
    } catch (error) {
      console.error('Sponsor organization registration failed:', error?.code || 'unknown')
      return { success: false, reason: 'database-unavailable' }
    }
  }

  async function createAccount(organizationId, input) {
    if (!validId(organizationId) || !isValidSponsorAccountInput(input)) return { success: false, reason: 'invalid-sponsor-account' }
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured' }
    try {
      await ensureSchema(db)
      const client = await db.connect()
      try {
        await client.query('BEGIN')
        const organization = await client.query(`
          SELECT status FROM trc20_token_clone.sponsor_organizations WHERE id = $1 FOR UPDATE
        `, [organizationId])
        if (!organization.rows[0]) {
          await client.query('ROLLBACK')
          return { success: false, reason: 'organization-not-found' }
        }
        if (['suspended', 'revoked'].includes(organization.rows[0].status)) {
          await client.query('ROLLBACK')
          return { success: false, reason: 'organization-not-active' }
        }
        const result = await client.query(`
          INSERT INTO trc20_token_clone.sponsor_organization_accounts
            (organization_id, sponsor_reference, network, role, wallet_address)
          VALUES ($1,$2,$3,$4,$5) RETURNING *
        `, [organizationId, input.sponsorReference.trim(), input.network, input.role, input.address.trim()])
        await writeAudit(client, organizationId, result.rows[0].id, 'sponsor-account-registered', {
          sponsorReference: input.sponsorReference.trim(), network: input.network,
          role: input.role, status: 'pending_verification',
        })
        await client.query('COMMIT')
        return { success: true, account: toAccount(result.rows[0]) }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        if (error?.code === '23505') return { success: false, reason: 'sponsor-account-reference-or-address-already-registered' }
        throw error
      } finally {
        client.release()
      }
    } catch (error) {
      console.error('Sponsor account registration failed:', error?.code || 'unknown')
      return { success: false, reason: 'database-unavailable' }
    }
  }

  async function reviewOrganization(organizationId, input) {
    if (!validId(organizationId)) return { success: false, reason: 'invalid-organization-id' }
    const decision = input?.decision
    const reviewReference = input?.reviewReference?.trim()
    if (!['under_review', 'verified', 'approved', 'suspended', 'revoked'].includes(decision)
      || !isValidSponsorRegistryReference(reviewReference)) return { success: false, reason: 'invalid-organization-review' }
    if (decision === 'verified' && (!isValidSponsorRegistryReference(input?.evidenceReference)
      || !VERIFICATION_METHODS.has(input?.verificationMethod))) {
      return { success: false, reason: 'organization-verification-evidence-required' }
    }
    if (decision === 'approved' && !isValidSponsorRegistryReference(input?.agreementReference)) {
      return { success: false, reason: 'signed-agreement-reference-required' }
    }
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured' }
    try {
      await ensureSchema(db)
      const client = await db.connect()
      try {
        await client.query('BEGIN')
        const selected = await client.query(`
          SELECT * FROM trc20_token_clone.sponsor_organizations WHERE id = $1 FOR UPDATE
        `, [organizationId])
        const current = selected.rows[0]
        if (!current) {
          await client.query('ROLLBACK')
          return { success: false, reason: 'organization-not-found' }
        }
        const transitions = {
          pending_review: ['under_review', 'suspended', 'revoked'],
          under_review: ['verified', 'suspended', 'revoked'],
          verified: ['approved', 'suspended', 'revoked'],
          approved: ['suspended', 'revoked'],
          suspended: ['revoked'],
          revoked: [],
        }
        if (!transitions[current.status]?.includes(decision)) {
          await client.query('ROLLBACK')
          return { success: false, reason: 'invalid-organization-status-transition' }
        }
        const updated = await client.query(`
          UPDATE trc20_token_clone.sponsor_organizations
          SET status = $2, review_reference = $3,
              evidence_reference = CASE WHEN $2 = 'verified' THEN $4 ELSE evidence_reference END,
              verification_method = CASE WHEN $2 = 'verified' THEN $5 ELSE verification_method END,
              agreement_reference = CASE WHEN $2 = 'approved' THEN $6 ELSE agreement_reference END,
              approved_at = CASE WHEN $2 = 'approved' THEN now() ELSE approved_at END,
              updated_at = now()
          WHERE id = $1 RETURNING *
        `, [
          organizationId, decision, reviewReference,
          input.evidenceReference || null, input.verificationMethod || null,
          input.agreementReference || null,
        ])
        if (decision === 'suspended' || decision === 'revoked') {
          await client.query(`
            UPDATE trc20_token_clone.sponsor_organization_budget_links
            SET status = $2, updated_at = now()
            WHERE organization_id = $1 AND status <> 'revoked'
          `, [organizationId, decision])
        }
        await writeAudit(client, organizationId, null, 'organization-status-changed', {
          from: current.status, to: decision, reviewReference,
          evidenceReference: input.evidenceReference || null,
          verificationMethod: input.verificationMethod || null,
          agreementReference: input.agreementReference || null,
        })
        await client.query('COMMIT')
        return { success: true, organization: toOrganization(updated.rows[0]) }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      } finally {
        client.release()
      }
    } catch (error) {
      console.error('Sponsor organization review failed:', error?.code || 'unknown')
      return { success: false, reason: 'database-unavailable' }
    }
  }

  async function reviewAccount(organizationId, accountId, input) {
    if (!validId(organizationId) || !validId(accountId)) return { success: false, reason: 'invalid-sponsor-account-id' }
    const decision = input?.decision
    const reviewReference = input?.reviewReference?.trim()
    if (!['verified', 'suspended', 'revoked'].includes(decision)
      || !isValidSponsorRegistryReference(reviewReference)) return { success: false, reason: 'invalid-sponsor-account-review' }
    if (decision === 'verified' && (!isValidSponsorRegistryReference(input?.evidenceReference)
      || !VERIFICATION_METHODS.has(input?.verificationMethod))) {
      return { success: false, reason: 'sponsor-account-verification-evidence-required' }
    }
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured' }
    try {
      await ensureSchema(db)
      const client = await db.connect()
      try {
        await client.query('BEGIN')
        const organization = await client.query(`
          SELECT status FROM trc20_token_clone.sponsor_organizations WHERE id = $1 FOR UPDATE
        `, [organizationId])
        if (!organization.rows[0]) {
          await client.query('ROLLBACK')
          return { success: false, reason: 'organization-not-found' }
        }
        if (!['verified', 'approved'].includes(organization.rows[0].status)) {
          await client.query('ROLLBACK')
          return { success: false, reason: 'organization-verification-required' }
        }
        const selected = await client.query(`
          SELECT * FROM trc20_token_clone.sponsor_organization_accounts
          WHERE id = $1 AND organization_id = $2 FOR UPDATE
        `, [accountId, organizationId])
        const current = selected.rows[0]
        if (!current) {
          await client.query('ROLLBACK')
          return { success: false, reason: 'sponsor-account-not-found' }
        }
        const transitions = {
          pending_verification: ['verified', 'suspended', 'revoked'],
          verified: ['suspended', 'revoked'],
          suspended: ['revoked'],
          revoked: [],
        }
        if (!transitions[current.status]?.includes(decision)) {
          await client.query('ROLLBACK')
          return { success: false, reason: 'invalid-sponsor-account-status-transition' }
        }
        const updated = await client.query(`
          UPDATE trc20_token_clone.sponsor_organization_accounts
          SET status = $3, review_reference = $4,
              verification_reference = CASE WHEN $3 = 'verified' THEN $5 ELSE verification_reference END,
              verification_method = CASE WHEN $3 = 'verified' THEN $6 ELSE verification_method END,
              updated_at = now()
          WHERE id = $1 AND organization_id = $2 RETURNING *
        `, [
          accountId, organizationId, decision, reviewReference,
          input.evidenceReference || null, input.verificationMethod || null,
        ])
        if (decision === 'suspended' || decision === 'revoked') {
          await client.query(`
            UPDATE trc20_token_clone.sponsor_organization_budget_links
            SET status = $3, updated_at = now()
            WHERE organization_id = $1 AND account_id = $2 AND status <> 'revoked'
          `, [organizationId, accountId, decision])
        }
        await writeAudit(client, organizationId, accountId, 'sponsor-account-status-changed', {
          from: current.status, to: decision, reviewReference,
          evidenceReference: input.evidenceReference || null,
          verificationMethod: input.verificationMethod || null,
        })
        await client.query('COMMIT')
        return { success: true, account: toAccount(updated.rows[0]) }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      } finally {
        client.release()
      }
    } catch (error) {
      console.error('Sponsor account review failed:', error?.code || 'unknown')
      return { success: false, reason: 'database-unavailable' }
    }
  }

  async function linkBudget(organizationId, accountId, budgetId, reviewReference) {
    if (!validId(organizationId) || !validId(accountId) || !validId(budgetId)
      || !isValidSponsorRegistryReference(reviewReference)) {
      return { success: false, reason: 'invalid-budget-link' }
    }
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured' }
    try {
      await ensureSchema(db)
      const client = await db.connect()
      try {
        await client.query('BEGIN')
        const organizationResult = await client.query(`
          SELECT * FROM trc20_token_clone.sponsor_organizations
          WHERE id = $1 FOR UPDATE
        `, [organizationId])
        const organization = organizationResult.rows[0]
        if (!organization) {
          await client.query('ROLLBACK')
          return { success: false, reason: 'organization-not-found' }
        }
        if (organization.status !== 'approved'
          || typeof organization.agreement_reference !== 'string'
          || !organization.agreement_reference) {
          await client.query('ROLLBACK')
          return { success: false, reason: 'approved-organization-agreement-required' }
        }

        const accountResult = await client.query(`
          SELECT * FROM trc20_token_clone.sponsor_organization_accounts
          WHERE id = $1 AND organization_id = $2 FOR UPDATE
        `, [accountId, organizationId])
        const account = accountResult.rows[0]
        if (!account) {
          await client.query('ROLLBACK')
          return { success: false, reason: 'sponsor-account-not-found' }
        }
        if (account.status !== 'verified') {
          await client.query('ROLLBACK')
          return { success: false, reason: 'verified-sponsor-account-required' }
        }

        const budgetResult = await client.query(`
          SELECT id::text AS id, sponsor_reference, sponsor_address, network, purpose, asset,
                 token_contract, budget_base_units::text AS budget_base_units,
                 reserved_base_units::text AS reserved_base_units,
                 spent_base_units::text AS spent_base_units, status,
                 approval_reference, review_reference, approved_at
          FROM trc20_token_clone.sponsor_budgets
          WHERE id = $1 FOR UPDATE
        `, [budgetId])
        const budget = budgetResult.rows[0]
        if (!budget) {
          await client.query('ROLLBACK')
          return { success: false, reason: 'budget-not-found' }
        }
        const expectedRole = budget.purpose === 'network-fee' ? 'network-fee' : 'asset-principal'
        if (budget.status !== 'active'
          || budget.network !== account.network
          || budget.sponsor_reference !== account.sponsor_reference
          || budget.sponsor_address !== account.wallet_address
          || expectedRole !== account.role) {
          await client.query('ROLLBACK')
          return { success: false, reason: 'budget-account-scope-mismatch' }
        }
        if (budget.approval_reference !== organization.agreement_reference
          || typeof budget.approval_reference !== 'string'
          || !budget.approval_reference
          || typeof budget.review_reference !== 'string'
          || !budget.review_reference
          || budget.approved_at == null
          || !isApprovedSponsorAgreementScope({ consentReference: budget.approval_reference, budget })) {
          await client.query('ROLLBACK')
          return { success: false, reason: 'budget-agreement-scope-not-approved' }
        }

        const existing = await client.query(`
          SELECT id::text AS id, organization_id::text AS organization_id,
                 account_id::text AS account_id, budget_id::text AS budget_id,
                 status, review_reference, created_at, updated_at
          FROM trc20_token_clone.sponsor_organization_budget_links
          WHERE budget_id = $1 FOR UPDATE
        `, [budgetId])
        if (existing.rows[0]) {
          const row = existing.rows[0]
          const same = row.organization_id === String(organizationId)
            && row.account_id === String(accountId) && row.status === 'active'
          await client.query('COMMIT')
          return same
            ? { success: true, duplicate: true, link: toBudgetLink(row) }
            : { success: false, reason: 'budget-already-linked-to-another-account' }
        }

        const inserted = await client.query(`
          INSERT INTO trc20_token_clone.sponsor_organization_budget_links
            (organization_id, account_id, budget_id, status, review_reference)
          VALUES ($1,$2,$3,'active',$4)
          RETURNING id::text AS id, organization_id::text AS organization_id,
                    account_id::text AS account_id, budget_id::text AS budget_id,
                    status, review_reference, created_at, updated_at
        `, [organizationId, accountId, budgetId, reviewReference])
        await writeAudit(client, organizationId, accountId, 'sponsor-budget-linked-to-organization', {
          budgetId: String(budgetId),
          sponsorReference: budget.sponsor_reference,
          network: budget.network,
          purpose: budget.purpose,
          asset: budget.asset,
          tokenContract: budget.token_contract || null,
          sponsorAddress: budget.sponsor_address,
          reviewReference,
        })
        await client.query('COMMIT')
        return { success: true, duplicate: false, link: toBudgetLink(inserted.rows[0]) }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        if (error?.code === '23505') return { success: false, reason: 'budget-already-linked-to-another-account' }
        throw error
      } finally {
        client.release()
      }
    } catch (error) {
      console.error('Sponsor budget link failed:', error?.code || 'unknown')
      return { success: false, reason: 'database-unavailable' }
    }
  }

  async function listBudgetLinks({ organizationId = null, network = null, limit = 100 } = {}) {
    if (organizationId !== null && !validId(String(organizationId))) return { success: false, reason: 'invalid-organization-id', links: [] }
    if (network !== null && !NETWORKS.has(network)) return { success: false, reason: 'invalid-network', links: [] }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return { success: false, reason: 'invalid-limit', links: [] }
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured', links: [] }
    try {
      await ensureSchema(db)
      const result = await db.query(`
        SELECT l.id::text AS id, l.organization_id::text AS organization_id,
               l.account_id::text AS account_id, l.budget_id::text AS budget_id,
               l.status AS link_status, l.review_reference AS link_review_reference,
               l.created_at AS link_created_at, l.updated_at AS link_updated_at,
               o.sponsor_reference AS organization_reference, o.legal_name,
               o.status AS organization_status, o.agreement_reference,
               a.sponsor_reference AS account_reference, a.network AS account_network, a.role,
               a.wallet_address, a.status AS account_status,
               b.sponsor_reference, b.sponsor_address, b.network AS budget_network,
               b.purpose, b.asset, b.token_contract,
               b.budget_base_units::text AS budget_base_units,
               b.reserved_base_units::text AS reserved_base_units,
               b.spent_base_units::text AS spent_base_units,
               b.status AS budget_status, b.approval_reference, b.review_reference AS budget_review_reference,
               b.approved_at
          FROM trc20_token_clone.sponsor_organization_budget_links l
          JOIN trc20_token_clone.sponsor_organizations o ON o.id = l.organization_id
          JOIN trc20_token_clone.sponsor_organization_accounts a ON a.id = l.account_id
          JOIN trc20_token_clone.sponsor_budgets b ON b.id = l.budget_id
         WHERE ($1::bigint IS NULL OR l.organization_id = $1::bigint)
           AND ($2::text IS NULL OR b.network = $2)
         ORDER BY l.created_at DESC, l.id DESC
         LIMIT $3
      `, [organizationId === null ? null : String(organizationId), network, limit])
      return {
        success: true,
        links: result.rows.map((row) => {
          const budget = {
            sponsor_reference: row.sponsor_reference,
            sponsor_address: row.sponsor_address,
            network: row.budget_network,
            purpose: row.purpose,
            asset: row.asset,
            token_contract: row.token_contract,
            status: row.budget_status,
            approval_reference: row.approval_reference,
            review_reference: row.budget_review_reference,
            approved_at: row.approved_at,
          }
          const scopeVerified = isApprovedSponsorAgreementScope({
            consentReference: row.approval_reference,
            budget,
          })
          const available = BigInt(row.budget_base_units) - BigInt(row.reserved_base_units) - BigInt(row.spent_base_units)
          const expectedRole = row.purpose === 'network-fee' ? 'network-fee'
            : row.purpose === 'asset-grant' ? 'asset-principal' : null
          const active = row.link_status === 'active'
            && row.organization_status === 'approved'
            && row.account_status === 'verified'
            && row.budget_status === 'active'
            && row.budget_network === row.account_network
            && row.sponsor_reference === row.account_reference
            && row.sponsor_address === row.wallet_address
            && row.role === expectedRole
            && row.agreement_reference === row.approval_reference
            && row.approved_at != null && scopeVerified
            && available >= 0n
          return {
            id: row.id,
            organizationId: row.organization_id,
            organizationReference: row.organization_reference,
            organizationName: row.legal_name,
            organizationStatus: row.organization_status,
            accountId: row.account_id,
            accountReference: row.account_reference,
            network: row.budget_network,
            role: row.role,
            sponsorAddress: row.wallet_address,
            accountStatus: row.account_status,
            budgetId: row.budget_id,
            sponsorReference: row.sponsor_reference,
            purpose: row.purpose,
            asset: row.asset,
            tokenContract: row.token_contract,
            budgetBaseUnits: row.budget_base_units,
            reservedBaseUnits: row.reserved_base_units,
            spentBaseUnits: row.spent_base_units,
            availableLedgerBaseUnits: available.toString(),
            budgetStatus: row.budget_status,
            agreementReference: row.approval_reference,
            linkStatus: row.link_status,
            reviewReference: row.link_review_reference,
            createdAt: new Date(row.link_created_at).toISOString(),
            updatedAt: new Date(row.link_updated_at).toISOString(),
            agreementScopeVerified: scopeVerified,
            linkCurrentlyActive: active,
            canSubmitSponsoredTransfer: false,
            submissionEnabled: false,
          }
        }),
      }
    } catch (error) {
      console.error('Sponsor budget links listing failed:', error?.code || 'unknown')
      return { success: false, reason: 'database-unavailable', links: [] }
    }
  }

  async function listBudgetsForWallet({ network, sponsorAddress, limit = 100 } = {}) {
    if (!NETWORKS.has(network) || !isValidTronAddress(sponsorAddress)) {
      return { success: false, reason: 'invalid-wallet-budget-query', budgets: [] }
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return { success: false, reason: 'invalid-limit', budgets: [] }
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured', budgets: [] }
    try {
      await ensureSchema(db)
      const result = await db.query(`
        SELECT id::text AS id, sponsor_reference, sponsor_address, network, purpose, asset,
               token_contract, budget_base_units::text AS budget_base_units,
               reserved_base_units::text AS reserved_base_units,
               spent_base_units::text AS spent_base_units, status,
               approval_reference, review_reference, approved_at
          FROM trc20_token_clone.sponsor_budgets
         WHERE network = $1 AND sponsor_address = $2
         ORDER BY id
         LIMIT $3
      `, [network, sponsorAddress, limit + 1])
      if (result.rows.length > limit) return { success: false, reason: 'wallet-budget-ledger-truncated', budgets: [] }
      return {
        success: true,
        budgets: result.rows.map((row) => ({
          ...row,
          approvalScopeVerified: row.status === 'active'
            && row.approved_at != null
            && isApprovedSponsorAgreementScope({ consentReference: row.approval_reference, budget: row }),
        })),
      }
    } catch (error) {
      console.error('Sponsor wallet budget listing failed:', error?.code || 'unknown')
      return { success: false, reason: 'database-unavailable', budgets: [] }
    }
  }

  async function revokeBudgetLink(linkId, reviewReference) {
    if (!validId(String(linkId)) || !isValidSponsorRegistryReference(reviewReference)) {
      return { success: false, reason: 'invalid-budget-link-review' }
    }
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured' }
    try {
      await ensureSchema(db)
      const client = await db.connect()
      try {
        await client.query('BEGIN')
        const selected = await client.query(`
          SELECT id::text AS id, organization_id::text AS organization_id,
                 account_id::text AS account_id, budget_id::text AS budget_id,
                 status, review_reference, created_at, updated_at
            FROM trc20_token_clone.sponsor_organization_budget_links
           WHERE id = $1 FOR UPDATE
        `, [linkId])
        const row = selected.rows[0]
        if (!row) {
          await client.query('ROLLBACK')
          return { success: false, reason: 'budget-link-not-found' }
        }
        if (row.status === 'revoked') {
          await client.query('COMMIT')
          return { success: true, duplicate: true, link: toBudgetLink(row) }
        }
        const updated = await client.query(`
          UPDATE trc20_token_clone.sponsor_organization_budget_links
             SET status = 'revoked', review_reference = $2, updated_at = now()
           WHERE id = $1
           RETURNING id::text AS id, organization_id::text AS organization_id,
                     account_id::text AS account_id, budget_id::text AS budget_id,
                     status, review_reference, created_at, updated_at
        `, [linkId, reviewReference])
        await writeAudit(client, row.organization_id, row.account_id, 'sponsor-budget-link-revoked', {
          budgetId: row.budget_id, reviewReference,
        })
        await client.query('COMMIT')
        return { success: true, duplicate: false, link: toBudgetLink(updated.rows[0]) }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      } finally {
        client.release()
      }
    } catch (error) {
      console.error('Sponsor budget link revocation failed:', error?.code || 'unknown')
      return { success: false, reason: 'database-unavailable' }
    }
  }

  async function releaseExpiredPayoutIntents(client, limit = 100) {
    const selected = await client.query(
      "SELECT id::text AS id, principal_organization_id::text AS principal_organization_id, " +
      "principal_account_id::text AS principal_account_id, fee_organization_id::text AS fee_organization_id, " +
      "fee_account_id::text AS fee_account_id FROM trc20_token_clone.sponsor_organization_payout_intents " +
      "WHERE status = 'pending_authorization' AND expires_at <= now() " +
      "ORDER BY expires_at, id LIMIT $1 FOR UPDATE SKIP LOCKED",
      [limit],
    )
    let releasedCount = 0
    for (const intent of selected.rows) {
      const reservations = await client.query(
        "SELECT id::text AS id, budget_id::text AS budget_id, amount_base_units::text AS amount_base_units " +
        "FROM trc20_token_clone.sponsor_organization_payout_reservations " +
        "WHERE intent_id = $1 AND status = 'active' ORDER BY budget_id FOR UPDATE",
        [intent.id],
      )
      for (const reservation of reservations.rows) {
        const updated = await client.query(
          "UPDATE trc20_token_clone.sponsor_budgets " +
          "SET reserved_base_units = reserved_base_units - $1::numeric, updated_at = now() " +
          "WHERE id = $2::bigint AND reserved_base_units >= $1::numeric",
          [reservation.amount_base_units, reservation.budget_id],
        )
        if (updated.rowCount !== 1) throw new Error('Payout reservation ledger underflow')
      }
      await client.query(
        "UPDATE trc20_token_clone.sponsor_organization_payout_reservations " +
        "SET status = 'released', updated_at = now() WHERE intent_id = $1 AND status = 'active'",
        [intent.id],
      )
      await client.query(
        "UPDATE trc20_token_clone.sponsor_organization_payout_intents " +
        "SET status = 'expired', updated_at = now() WHERE id = $1",
        [intent.id],
      )
      await writeAudit(client, intent.principal_organization_id, intent.principal_account_id,
        'sponsor-payout-intent-expired', { intentId: intent.id, reservationReleased: true })
      await writeAudit(client, intent.fee_organization_id, intent.fee_account_id,
        'sponsor-payout-intent-expired', { intentId: intent.id, reservationReleased: true })
      releasedCount += 1
    }
    return releasedCount
  }

  async function expirePayoutIntents({ limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return { success: false, reason: 'invalid-limit', expiredCount: 0 }
    }
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured', expiredCount: 0 }
    try {
      await ensureSchema(db)
      const client = await db.connect()
      try {
        await client.query('BEGIN')
        const expiredCount = await releaseExpiredPayoutIntents(client, limit)
        await client.query('COMMIT')
        return { success: true, expiredCount }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      } finally {
        client.release()
      }
    } catch (error) {
      console.error('Sponsor payout-intent expiry failed:', error?.code || 'unknown')
      return { success: false, reason: 'database-unavailable', expiredCount: 0 }
    }
  }

  async function reservePayoutIntent(input) {
    const {
      idempotencyKey, network, asset, tokenContract = null, receiverAddress,
      amountBaseUnits, feeCapSun, principalLinkId, feeLinkId, fundingSnapshots,
    } = input || {}
    const uint = (value) => typeof value === 'string' && /^[1-9][0-9]{0,77}$/.test(value)
    const validLinkId = (value) => typeof value === 'string' && /^[1-9][0-9]{0,17}$/.test(value)
    const configuredContracts = String(env['SPONSOR_USDT_' + String(network || '').toUpperCase() + '_CONTRACTS'] || '')
      .split(',').map((item) => item.trim()).filter(Boolean)
    if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{24,160}$/.test(idempotencyKey)
      || !NETWORKS.has(network) || !['TRX', 'USDT'].includes(asset)
      || (asset === 'TRX' ? tokenContract !== null : !isSponsorTokenContractAllowed(network, asset, tokenContract, configuredContracts))
      || !isValidTronAddress(receiverAddress) || !uint(amountBaseUnits) || !uint(feeCapSun)
      || !validLinkId(principalLinkId) || !validLinkId(feeLinkId) || principalLinkId === feeLinkId) {
      return { success: false, reason: 'invalid-payout-intent' }
    }
    const normalizedContract = asset === 'USDT' ? tokenContract.trim() : null
    const canonicalIntent = {
      network, asset, tokenContract: normalizedContract, receiverAddress,
      amountBaseUnits, feeCapSun, principalLinkId, feeLinkId,
    }
    const intentDigest = createHash('sha256').update(JSON.stringify(canonicalIntent)).digest('hex')
    const digestMatches = (row) => row.intent_digest === intentDigest
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured' }
    const feeSnapshot = fundingSnapshots?.networkFeeSponsor
    const principalSnapshot = fundingSnapshots?.assetPrincipalSponsor
    const freshSnapshot = (snapshot, address) => {
      const ageMs = Date.now() - Date.parse(snapshot?.checkedAt || '')
      return snapshot?.status === 'solidified-sponsor-balances-read'
        && snapshot.onChainBalanceRead === true
        && snapshot.network === network
        && snapshot.sponsorAddress === address
        && snapshot.source === 'Tatum TRON SolidityNode account and constant-contract queries'
        && snapshot.cache?.status === 'fresh'
        && Number.isFinite(ageMs) && ageMs >= -5000 && ageMs <= 15000
    }

    try {
      await ensureSchema(db)
      const client = await db.connect()
      try {
        await client.query('BEGIN')
        await releaseExpiredPayoutIntents(client, 100)
        const prior = await client.query(
          "SELECT id::text AS id, intent_digest, status, expires_at " +
          "FROM trc20_token_clone.sponsor_organization_payout_intents WHERE idempotency_key = $1 FOR UPDATE",
          [idempotencyKey],
        )
        if (prior.rows.length) {
          const row = prior.rows[0]
          await client.query('COMMIT')
          return digestMatches(row)
            ? { success: true, duplicate: true, intentId: row.id, intentDigest, status: row.status,
                expiresAt: row.expires_at, canSubmitSponsoredTransfer: false, submissionEnabled: false }
            : { success: false, reason: 'idempotency-key-conflict' }
        }

        const initialLinks = await client.query(
          "SELECT id::text AS id, organization_id::text AS organization_id, " +
          "account_id::text AS account_id, budget_id::text AS budget_id " +
          "FROM trc20_token_clone.sponsor_organization_budget_links WHERE id = ANY($1::bigint[])",
          [[principalLinkId, feeLinkId]],
        )
        if (initialLinks.rows.length !== 2) {
          await client.query('ROLLBACK')
          return { success: false, reason: 'sponsor-budget-link-not-found' }
        }
        const organizationIds = [...new Set(initialLinks.rows.map((row) => row.organization_id))].sort((a,b) => BigInt(a) < BigInt(b) ? -1 : 1)
        const accountIds = [...new Set(initialLinks.rows.map((row) => row.account_id))].sort((a,b) => BigInt(a) < BigInt(b) ? -1 : 1)
        const linkIds = [principalLinkId, feeLinkId].sort((a,b) => BigInt(a) < BigInt(b) ? -1 : 1)

        await client.query(
          "SELECT id FROM trc20_token_clone.sponsor_organizations WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE",
          [organizationIds],
        )
        await client.query(
          "SELECT id FROM trc20_token_clone.sponsor_organization_accounts WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE",
          [accountIds],
        )
        await client.query(
          "SELECT id FROM trc20_token_clone.sponsor_organization_budget_links WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE",
          [linkIds],
        )
        const walletLockRows = await client.query(
          "SELECT DISTINCT a.network, a.wallet_address, b.asset, b.token_contract " +
          "FROM trc20_token_clone.sponsor_organization_budget_links l " +
          "JOIN trc20_token_clone.sponsor_organization_accounts a ON a.id = l.account_id " +
          "JOIN trc20_token_clone.sponsor_budgets b ON b.id = l.budget_id " +
          "WHERE l.id = ANY($1::bigint[])",
          [linkIds],
        )
        const lockKeys = walletLockRows.rows.map((row) =>
          'sponsor-budget-activation:' + row.network + ':' + row.wallet_address + ':' + row.asset + ':' + (row.token_contract || '')
        ).sort()
        for (const lockKey of lockKeys) {
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey])
        }

        const budgetsByAddress = new Map()
        const addresses = [...new Set(walletLockRows.rows.map((row) => row.wallet_address))].sort()
        for (const address of addresses) {
          const walletBudgets = await client.query(
            "SELECT id::text AS id, sponsor_reference, sponsor_address, network, purpose, asset, token_contract, " +
            "budget_base_units::text AS budget_base_units, reserved_base_units::text AS reserved_base_units, " +
            "spent_base_units::text AS spent_base_units, status, approval_reference, review_reference, approved_at " +
            "FROM trc20_token_clone.sponsor_budgets WHERE network = $1 AND sponsor_address = $2 ORDER BY id FOR UPDATE",
            [network, address],
          )
          if (walletBudgets.rows.length > 100) {
            await client.query('ROLLBACK')
            return { success: false, reason: 'wallet-budget-ledger-truncated' }
          }
          budgetsByAddress.set(address, walletBudgets.rows)
        }

        const joined = await client.query(
          "SELECT l.id::text AS link_id, l.status AS link_status, " +
          "o.id::text AS organization_id, o.sponsor_reference AS organization_reference, o.status AS organization_status, o.agreement_reference, " +
          "a.id::text AS account_id, a.sponsor_reference AS account_reference, a.network AS account_network, a.role, " +
          "a.wallet_address, a.status AS account_status, " +
          "b.id::text AS budget_id, b.sponsor_reference, b.sponsor_address, b.network AS budget_network, " +
          "b.purpose, b.asset, b.token_contract, b.budget_base_units::text AS budget_base_units, " +
          "b.reserved_base_units::text AS reserved_base_units, b.spent_base_units::text AS spent_base_units, " +
          "b.status AS budget_status, b.approval_reference, b.review_reference AS budget_review_reference, b.approved_at " +
          "FROM trc20_token_clone.sponsor_organization_budget_links l " +
          "JOIN trc20_token_clone.sponsor_organizations o ON o.id = l.organization_id " +
          "JOIN trc20_token_clone.sponsor_organization_accounts a ON a.id = l.account_id " +
          "JOIN trc20_token_clone.sponsor_budgets b ON b.id = l.budget_id " +
          "WHERE l.id = ANY($1::bigint[]) ORDER BY b.id",
          [linkIds],
        )
        const principal = joined.rows.find((row) => row.link_id === principalLinkId)
        const fee = joined.rows.find((row) => row.link_id === feeLinkId)
        if (!principal || !fee) {
          await client.query('ROLLBACK')
          return { success: false, reason: 'sponsor-budget-link-not-found' }
        }
        const roleMatches = principal.role === 'asset-principal' && principal.purpose === 'asset-grant'
          && fee.role === 'network-fee' && fee.purpose === 'network-fee'
        const scopesApproved = [principal, fee].every((row) =>
          row.link_status === 'active' && row.organization_status === 'approved'
          && row.account_status === 'verified' && row.budget_status === 'active'
          && row.organization_id !== (row === principal ? fee.organization_id : principal.organization_id)
          && row.account_reference === row.sponsor_reference
          && row.wallet_address === row.sponsor_address
          && row.account_network === network && row.budget_network === network
          && row.agreement_reference === row.approval_reference
          && row.approved_at != null && row.budget_review_reference
          && isApprovedSponsorAgreementScope({
            consentReference: row.approval_reference,
            budget: {
              sponsor_reference: row.sponsor_reference, sponsor_address: row.sponsor_address,
              network: row.budget_network, purpose: row.purpose, asset: row.asset,
              token_contract: row.token_contract, status: row.budget_status,
              approval_reference: row.approval_reference, review_reference: row.budget_review_reference,
              approved_at: row.approved_at,
            },
          })
        )
        if (!scopesApproved || !roleMatches || principal.budget_id === fee.budget_id
          || principal.wallet_address === fee.wallet_address
          || principal.asset !== asset || (principal.token_contract || null) !== normalizedContract
          || fee.asset !== 'TRX' || fee.token_contract != null) {
          await client.query('ROLLBACK')
          return { success: false, reason: 'sponsor-payout-scope-mismatch' }
        }
        if (!freshSnapshot(feeSnapshot, fee.wallet_address)
          || !freshSnapshot(principalSnapshot, principal.wallet_address)) {
          await client.query('ROLLBACK')
          return { success: false, reason: 'fresh-role-specific-funding-snapshots-required' }
        }
        if (network === 'mainnet' && env.SPONSOR_MAINNET_BUDGET_ACTIVATION_ENABLED !== 'true') {
          await client.query('ROLLBACK')
          return { success: false, reason: 'mainnet-budget-activation-disabled' }
        }

        const reconciliationFor = (snapshot, walletRows, requiredAsset, requiredContract) => {
          const budgets = walletRows.map((item) => ({
            ...item,
            approvalScopeVerified: item.status === 'active' && item.approved_at != null
              && isApprovedSponsorAgreementScope({ consentReference: item.approval_reference, budget: item }),
          }))
          const reconciliation = reconcileSponsorBudgets({ network, fundingSnapshot: snapshot, budgets })
          const group = reconciliation.groups?.find((item) =>
            item.asset === requiredAsset && (item.tokenContract || null) === requiredContract
          )
          return group?.status === 'covered' && group.unapprovedActiveBudgetCount === 0
            ? { success: true, group }
            : { success: false, reconciliation }
        }
        const feeCheck = reconciliationFor(feeSnapshot, budgetsByAddress.get(fee.wallet_address), 'TRX', null)
        const principalCheck = reconciliationFor(principalSnapshot, budgetsByAddress.get(principal.wallet_address), asset, normalizedContract)
        if (!feeCheck.success || !principalCheck.success) {
          await client.query('ROLLBACK')
          return { success: false, reason: 'role-specific-onchain-balance-does-not-cover-current-commitments' }
        }

        const principalAvailable = BigInt(principal.budget_base_units) - BigInt(principal.reserved_base_units) - BigInt(principal.spent_base_units)
        const feeAvailable = BigInt(fee.budget_base_units) - BigInt(fee.reserved_base_units) - BigInt(fee.spent_base_units)
        if (BigInt(amountBaseUnits) > principalAvailable || BigInt(feeCapSun) > feeAvailable) {
          await client.query('ROLLBACK')
          return { success: false, reason: 'insufficient-dual-sponsor-budget-capacity' }
        }
        const inserted = await client.query(
          "INSERT INTO trc20_token_clone.sponsor_organization_payout_intents " +
          "(idempotency_key, intent_digest, network, asset, token_contract, receiver_address, amount_base_units, fee_cap_sun, " +
          "principal_link_id, fee_link_id, principal_budget_id, fee_budget_id, principal_organization_id, fee_organization_id, " +
          "principal_account_id, fee_account_id, principal_sponsor_address, fee_sponsor_address, expires_at) " +
          "VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,$8::numeric,$9::bigint,$10::bigint,$11::bigint,$12::bigint," +
          "$13::bigint,$14::bigint,$15::bigint,$16::bigint,$17,$18,now() + interval '10 minutes') " +
          "RETURNING id::text AS id, status, expires_at",
          [idempotencyKey, intentDigest, network, asset, normalizedContract, receiverAddress,
            amountBaseUnits, feeCapSun, principal.link_id, fee.link_id, principal.budget_id, fee.budget_id,
            principal.organization_id, fee.organization_id, principal.account_id, fee.account_id,
            principal.wallet_address, fee.wallet_address],
        )
        const intent = inserted.rows[0]
        await client.query(
          "UPDATE trc20_token_clone.sponsor_budgets SET reserved_base_units = reserved_base_units + $1::numeric, updated_at = now() WHERE id = $2::bigint",
          [amountBaseUnits, principal.budget_id],
        )
        await client.query(
          "UPDATE trc20_token_clone.sponsor_budgets SET reserved_base_units = reserved_base_units + $1::numeric, updated_at = now() WHERE id = $2::bigint",
          [feeCapSun, fee.budget_id],
        )
        await client.query(
          "INSERT INTO trc20_token_clone.sponsor_organization_payout_reservations (intent_id,budget_id,role,amount_base_units) " +
          "VALUES ($1::bigint,$2::bigint,'asset-principal',$3::numeric),($1::bigint,$4::bigint,'network-fee',$5::numeric)",
          [intent.id, principal.budget_id, amountBaseUnits, fee.budget_id, feeCapSun],
        )
        await writeAudit(client, principal.organization_id, principal.account_id, 'sponsor-payout-intent-reserved', {
          intentId: intent.id, idempotencyKey, intentDigest, role: 'asset-principal',
          amountBaseUnits, fundingSnapshotCheckedAt: principalSnapshot.checkedAt,
          submissionEnabled: false,
        })
        await writeAudit(client, fee.organization_id, fee.account_id, 'sponsor-payout-intent-reserved', {
          intentId: intent.id, idempotencyKey, intentDigest, role: 'network-fee',
          feeBudgetCapSun: feeCapSun, fundingSnapshotCheckedAt: feeSnapshot.checkedAt,
          submissionEnabled: false,
        })
        await client.query('COMMIT')
        return {
          success: true, duplicate: false, intentId: intent.id, idempotencyKey, intentDigest,
          status: intent.status, expiresAt: intent.expires_at,
          principalReservationBaseUnits: amountBaseUnits, feeBudgetCapSun: feeCapSun,
          transactionSpecificFeeCoverageVerified: false,
          sponsorAuthorizationVerified: false,
          transactionSubmitted: false,
          canSubmitSponsoredTransfer: false, submissionEnabled: false,
          userFundedFallbackAllowed: false,
        }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        if (error?.code === '23505') {
          const raced = await db.query(
            "SELECT id::text AS id, intent_digest, status, expires_at FROM trc20_token_clone.sponsor_organization_payout_intents WHERE idempotency_key = $1",
            [idempotencyKey],
          )
          if (raced.rows.length && digestMatches(raced.rows[0])) {
            return { success: true, duplicate: true, intentId: raced.rows[0].id, intentDigest,
              status: raced.rows[0].status, expiresAt: raced.rows[0].expires_at,
              canSubmitSponsoredTransfer: false, submissionEnabled: false }
          }
          return { success: false, reason: 'idempotency-key-conflict' }
        }
        console.error('Dual sponsor payout reservation failed:', error?.code || 'unknown')
        return { success: false, reason: 'database-unavailable' }
      } finally {
        client.release()
      }
    } catch (error) {
      console.error('Dual sponsor payout reservation initialization failed:', error?.code || 'unknown')
      return { success: false, reason: 'database-unavailable' }
    }
  }

  async function cancelPayoutIntent(intentId, reviewReference) {
    if (!validId(String(intentId)) || !isValidSponsorRegistryReference(reviewReference)) {
      return { success: false, reason: 'invalid-payout-intent-cancellation' }
    }
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured' }
    try {
      await ensureSchema(db)
      const client = await db.connect()
      try {
        await client.query('BEGIN')
        await releaseExpiredPayoutIntents(client, 100)
        const selected = await client.query(
          "SELECT id::text AS id, status, principal_organization_id::text AS principal_organization_id, " +
          "principal_account_id::text AS principal_account_id, fee_organization_id::text AS fee_organization_id, " +
          "fee_account_id::text AS fee_account_id FROM trc20_token_clone.sponsor_organization_payout_intents " +
          "WHERE id = $1 FOR UPDATE",
          [intentId],
        )
        const intent = selected.rows[0]
        if (!intent) {
          await client.query('ROLLBACK')
          return { success: false, reason: 'payout-intent-not-found' }
        }
        if (intent.status !== 'pending_authorization') {
          await client.query('COMMIT')
          return { success: true, duplicate: true, status: intent.status, reservationReleased: true }
        }
        const reservations = await client.query(
          "SELECT id::text AS id, budget_id::text AS budget_id, amount_base_units::text AS amount_base_units " +
          "FROM trc20_token_clone.sponsor_organization_payout_reservations " +
          "WHERE intent_id = $1 AND status = 'active' ORDER BY budget_id FOR UPDATE",
          [intentId],
        )
        if (reservations.rows.length !== 2) throw new Error('Dual sponsor reservation pair is incomplete')
        for (const reservation of reservations.rows) {
          const updated = await client.query(
            "UPDATE trc20_token_clone.sponsor_budgets " +
            "SET reserved_base_units = reserved_base_units - $1::numeric, updated_at = now() " +
            "WHERE id = $2::bigint AND reserved_base_units >= $1::numeric",
            [reservation.amount_base_units, reservation.budget_id],
          )
          if (updated.rowCount !== 1) throw new Error('Payout reservation ledger underflow')
        }
        await client.query(
          "UPDATE trc20_token_clone.sponsor_organization_payout_reservations " +
          "SET status = 'released', updated_at = now() WHERE intent_id = $1 AND status = 'active'",
          [intentId],
        )
        await client.query(
          "UPDATE trc20_token_clone.sponsor_organization_payout_intents " +
          "SET status = 'cancelled', updated_at = now() WHERE id = $1",
          [intentId],
        )
        await writeAudit(client, intent.principal_organization_id, intent.principal_account_id,
          'sponsor-payout-intent-cancelled', { intentId: String(intentId), reviewReference, reservationReleased: true })
        await writeAudit(client, intent.fee_organization_id, intent.fee_account_id,
          'sponsor-payout-intent-cancelled', { intentId: String(intentId), reviewReference, reservationReleased: true })
        await client.query('COMMIT')
        return { success: true, duplicate: false, status: 'cancelled', reservationReleased: true }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        console.error('Sponsor payout-intent cancellation failed:', error?.code || 'unknown')
        return { success: false, reason: 'database-unavailable' }
      } finally {
        client.release()
      }
    } catch (error) {
      console.error('Sponsor payout-intent cancellation initialization failed:', error?.code || 'unknown')
      return { success: false, reason: 'database-unavailable' }
    }
  }

  return { listOrganizations, createOrganization, createAccount, reviewOrganization, reviewAccount,
    linkBudget, listBudgetLinks, listBudgetsForWallet, revokeBudgetLink,
    reservePayoutIntent, cancelPayoutIntent, expirePayoutIntents }
}

function toBudgetLink(row) {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    accountId: String(row.account_id),
    budgetId: String(row.budget_id),
    status: row.status,
    reviewReference: row.review_reference,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

